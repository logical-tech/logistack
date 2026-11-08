---
title: "Zero-downtime deployments: rolling updates and rollbacks"
description: "How zero-downtime deployments work: rolling updates, health checks, connection draining, safe migrations and fast rollbacks, with real config examples."
date: 2026-11-08
category: Deployment
keywords: zero-downtime deployments, rolling updates, health checks, rollback, blue-green deployment, graceful shutdown
---

You deploy a one-line fix and, for eight seconds, every request returns a 502. Nobody notices at 3 a.m. At 3 p.m., support gets tickets. Zero-downtime deployments remove that gap: the new version starts, proves it is healthy and takes traffic before the old one stops. This guide covers the strategies (rolling, blue-green, canary), the pieces that make them work (health checks, draining, graceful shutdown), the part most guides skip (database migrations), and how to roll back when a release goes wrong.

## Why deployments cause downtime

A naive deploy does three things in order: stop the old container, start the new one, wait for it to boot. Between the stop and the moment the new process listens on its port, the proxy has nowhere to send requests. That window is your downtime.

Other causes are less obvious:

- **The app listens before it's ready.** The port is open but the app is still connecting to the database or warming a cache.
- **The old process is killed mid-request.** A `SIGKILL` drops in-flight requests and open connections.
- **The proxy doesn't know a backend went away.** It keeps routing to a dead address until its own health check catches up.
- **A migration breaks the old version.** The new code renamed a column; the old replicas, still serving, start throwing errors.

Zero downtime means handling all four.

## Deployment strategies compared

| Strategy | How it works | Extra capacity | Rollback speed | Good for |
|---|---|---|---|---|
| Recreate | Stop all old, start all new | None | Slow (redeploy) | Dev, or apps that can't run two versions |
| Rolling update | Replace replicas one at a time | One replica | Fast | Most web apps and APIs |
| Blue-green | Run a full new copy, switch traffic at once | Double | Instant (switch back) | Large releases, strict cut-overs |
| Canary | Send a small share of traffic to the new version first | Small | Fast | High-traffic services that need real-user validation |

Rolling updates are the default for good reason. They need little extra capacity, work on one server, and every container orchestrator supports them. Blue-green and canary add safety for large systems but need more capacity and traffic-splitting at the proxy.

## How a rolling update works

A rolling update replaces replicas one by one. The safe variant is **start-first**:

1. Start a new replica on the new image.
2. Wait until its health check passes.
3. Add it to the load balancer.
4. Tell one old replica to stop accepting new requests and finish its current ones.
5. Stop the old replica.
6. Repeat until every replica runs the new version.

At every moment, at least the original number of healthy replicas is serving. With one replica, that still holds: for a few seconds there are two.

The alternative, **stop-first**, stops the old replica before starting the new one. It causes a short gap, but you need it when two copies can't run at once: when they would share a volume or bind the same port on a host.

### Docker Swarm example

Swarm supports both orders natively. This compose fragment configures a start-first rolling update with automatic rollback:

```yaml
services:
  api:
    image: registry.example.com/acme/api:dep_8f3c2a1
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/healthz"]
      interval: 5s
      timeout: 3s
      retries: 3
      start_period: 10s
    stop_grace_period: 30s
    deploy:
      replicas: 2
      update_config:
        parallelism: 1
        order: start-first
        monitor: 30s
        failure_action: rollback
      rollback_config:
        order: start-first
```

`monitor: 30s` tells Swarm to watch each new task for 30 seconds before calling the update a success. `failure_action: rollback` returns to the previous spec on its own if a task fails during that window.

## Health checks: the core of zero downtime

The orchestrator can only send traffic to a "ready" container if it knows what ready means. That's the health check's job.

Three kinds are common:

- **HTTP**: request a path like `/healthz` and expect a 2xx. Best for web apps.
- **TCP**: open a connection to the port. Proves the process listens, not that it works.
- **Command**: run a command in the container; exit code 0 means healthy. Useful for workers.

A good HTTP health endpoint checks what the app needs to serve a request, and nothing more:

```ts
app.get("/healthz", async (c) => {
  await db.execute("select 1"); // can we reach the database?
  return c.text("ok");
});
```

Keep it cheap. If the health check calls three downstream APIs, one slow partner can mark every replica unhealthy and take you down during a deploy.

## Graceful shutdown and connection draining

Starting the new version cleanly is half the job. Stopping the old one cleanly is the other half.

When an orchestrator stops a container, it sends `SIGTERM`, waits a grace period, then sends `SIGKILL`. Your app should use that window:

```ts
process.on("SIGTERM", async () => {
  server.close();        // stop accepting new connections
  await drainQueue();    // finish jobs already picked up
  await db.end();        // close the pool
  process.exit(0);
});
```

Set the grace period longer than your slowest normal request. If an upload can take 20 seconds, a 10-second grace period will cut it off.

Two common bugs:

- **PID 1 doesn't forward signals.** If your container runs `sh -c "node server.js"`, the shell gets `SIGTERM` and the app never does. Use the exec form (`CMD ["node", "server.js"]`) or a minimal init.
- **The proxy keeps routing to a stopping replica.** The orchestrator must remove the replica from rotation before or as it sends `SIGTERM`.

## Database migrations without downtime

During a rolling update, old and new versions run side by side, against the same database. A migration that breaks the old version breaks the deploy, even if the new code is perfect.

The rule: **every migration must work with both the current and the next version of the code.** Split breaking changes across releases, often called expand and contract:

1. **Expand.** Add the new column, nullable. Deploy code that writes to both old and new columns.
2. **Migrate.** Backfill the new column.
3. **Switch.** Deploy code that reads from the new column.
4. **Contract.** In a later release, drop the old column.

Renames and drops never happen in the same release that stops using them. Run migrations as a step before the rollout starts, and if the migration fails, the rollout should not begin. More on schema changes in [database migration](/blog/database-migration/).

## Rollbacks: plan for the bad release

Even with all of the above, some bad releases pass every check. A fast rollback is the last safety net.

What makes rollback fast:

- **Immutable image tags.** Each deploy gets a unique tag, like a commit SHA or deployment ID. Rolling back means pointing at the previous tag, with no rebuild. With `:latest`, the previous version may no longer exist.
- **Keep old images around.** If your registry garbage-collects aggressively, the image you want to roll back to may be gone.
- **Rollback restores code, not data.** If the bad release ran a destructive migration, rolling back the image won't restore the dropped column. That's why expand and contract matters.

## Zero-downtime deployments in LogiStack

LogiStack, an open-source self-hosted PaaS on Docker Swarm, applies these rules to every deployment by default. Swarm does the rollout itself.

### Start-first or stop-first, chosen for you

- **Stateless services roll start-first.** The new replica starts, passes its health check, takes traffic, then the old one stops. No request is dropped.
- **Services with a volume or a port published on the node roll stop-first**, because two copies can't share the data or the port. Expect a short gap. Keep state in a database or [object storage](/docs/data/object-storage/) to stay on the start-first path.
- Swarm watches each new replica for 30 seconds. If one fails, the rollout rolls back automatically, the deployment is marked **Failed**, and the previous version keeps running.

### Health checks and drain timeout

Under **Settings** › **Healthcheck and drain**, pick **HTTP request** (port and path), **TCP connect** or **Command**. A service with a domain and no health check of its own gets a TCP check on its port, so a rollout only completes once the new replicas listen. The **Drain timeout** is the time a replica gets after `SIGTERM` to finish in-flight requests: 10 seconds by default, up to 3600.

### Release commands for migrations

A **pre-deploy command** runs once on the new image before any replica is replaced. If it fails, the deployment fails and the current version keeps running. A **post-deploy command** runs once the new replicas are healthy. Commands run without a shell, one argument per line:

```text
bun
run
db:migrate
```

### One-click rollback

Every Git build is tagged with its deployment ID, never `:latest`. On the **Deployments** tab, select an earlier **Ready** deployment and **Roll back to this**: a new deployment runs that image again with no build. Full details in [Deployments, rollbacks and live logs](/docs/deploy/deployments/).

![The service Deployments tab with the list of deployments and a live log](/docs/screens/service-deployments.webp)

### What LogiStack doesn't do

Rollouts are rolling updates. There is no built-in blue-green or canary traffic splitting. If you need to send 5% of users to a new version, you'll need feature flags in your app or a platform with weighted routing, such as Kubernetes with a service mesh. See [Docker Swarm vs Kubernetes](/blog/docker-swarm-vs-kubernetes/) for when that trade-off is worth it.

## A zero-downtime checklist

- [ ] Every service has a health check that reflects readiness.
- [ ] Rollouts are start-first wherever the service is stateless.
- [ ] The app handles `SIGTERM` and the grace period covers your slowest request.
- [ ] The container's main process receives signals (exec form `CMD`).
- [ ] Migrations work with both the old and the new code.
- [ ] Images have unique, immutable tags, and old ones stay in the registry.
- [ ] Failed rollouts roll back on their own.
- [ ] You know how to roll back by hand in one step.

## FAQ

### What is a zero-downtime deployment?

A release where users never see an error or an outage while the new version replaces the old one. The new version starts and passes a health check before the old one stops, and the old one finishes in-flight requests before it exits.

### Do I need Kubernetes for zero-downtime deployments?

No. Docker Swarm supports start-first rolling updates, health checks and automatic rollback out of the box. Kubernetes adds options like canary traffic splitting through extra tools, at the cost of more operational work.

### Can I get zero downtime with a single replica?

Yes, with start-first updates. For a few seconds two replicas run, then the old one stops. This doesn't work if the service has a volume or a host port that two copies can't share.

### What is the difference between rolling and blue-green deployments?

A rolling update replaces replicas one at a time and needs one extra replica of capacity. Blue-green runs a complete second copy and switches all traffic at once, which needs double the capacity but allows an instant switch back.

### Why did my deployment still drop requests?

The usual causes: no health check, so traffic reached the new replica before it was ready; the app ignored `SIGTERM`; or the service has a volume, which forces a stop-first rollout.

Zero downtime is a set of defaults, not a project. LogiStack gives every service start-first rollouts, health checks, drain timeouts, pre-deploy migrations and one-click rollback on your own servers. [Install it](/#install), or read how this fits into a [continuous deployment](/blog/continuous-delivery-vs-continuous-deployment/) pipeline.

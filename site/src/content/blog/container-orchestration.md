---
title: "Container orchestration: how it works and when you need it"
description: "Container orchestration explained from first principles: scheduling, self-healing, rollouts and the reconcile loop, and how to tell when your team needs it."
date: 2026-11-08
category: Orchestration
keywords: container orchestration, what is container orchestration, orchestration platform, desired state, reconcile loop
---

At first, containers make life simpler. You SSH into a server, run `docker run`, and the app is up. Then there are three servers, eleven containers, a database that must stay on the box with the SSD, and a deploy script that works unless someone runs it twice. When a server reboots at night, you find out in the morning which containers came back. Container orchestration is the answer to that drift: software that decides where containers run, notices when reality diverges from the plan, and fixes it without you.

This guide explains what an orchestrator actually does, the one idea that makes every orchestrator work, and how to tell whether you need one yet.

## What container orchestration does

An orchestrator takes a description of what should run and keeps it running across a group of machines. Concretely, it handles these jobs:

1. **Scheduling.** Pick a node for each container, based on free CPU and memory, labels such as "has a GPU" or "holds the database disk", and spreading copies apart.
2. **Self-healing.** Restart a container that exits, replace one that fails its health check, and reschedule everything from a node that stops responding.
3. **Rollouts and rollbacks.** Replace containers in batches when the image changes, wait for health checks, and revert when the new version fails.
4. **Service discovery and networking.** Give each service a stable name and address, connect containers across hosts, and load-balance between copies.
5. **Scaling.** Run more or fewer copies on request, or automatically from metrics.
6. **Configuration and secrets.** Deliver environment variables, config files and credentials to the containers that need them, and only those.
7. **Storage placement.** Keep a container next to its data, or attach a network volume wherever it lands.

None of these is hard to script for one case. Doing all of them correctly at once, while servers fail and people deploy, is what orchestrators are for.

## The core idea: desired state and the reconcile loop

Every modern orchestrator, from Kubernetes to Docker Swarm to Nomad, is built on one pattern. You don't tell it what to **do**. You tell it what should **be**, and a loop makes it so.

```text
loop forever:
    desired = read what should exist
    actual  = observe what does exist
    diff    = desired - actual
    for each difference:
        apply the smallest change that removes it
    sleep, or wait for an event
```

That loop is called reconciliation. It has three properties that matter in production:

- **Idempotent.** Running the loop twice changes nothing the second time. A deploy that crashes halfway is finished by the next pass instead of starting over.
- **Self-correcting.** If a node dies or someone changes something by hand, the next pass sees the difference and repairs it.
- **Declarative.** Your config describes the end state, so it can live in Git and be reviewed like code.

Compare the two styles:

| | Imperative (scripts) | Declarative (orchestrator) |
| --- | --- | --- |
| You write | "Stop container A, pull image, start container B" | "Service web runs image v2 with 3 replicas" |
| A step fails halfway | You figure out where it stopped | The next pass continues from the current state |
| Run it twice | Possibly two containers, or an error | Nothing changes |
| Someone edits a server by hand | The change stays until it causes trouble | The orchestrator reverts it |
| Audit | Read shell history | Read the config diff |

If you remember one thing from this article, make it this table. The rest is implementation detail.

## What happens when a node dies

Here is the loop at work in a three-node cluster running a `web` service with three replicas:

1. **00:00** Node 2 loses power. Its `web` replica disappears with it.
2. **00:05 to 00:30** The managers stop receiving heartbeats from node 2. After the timeout, they mark it down.
3. **Next pass** Desired: 3 replicas. Actual: 2 healthy. The scheduler places a new replica on node 1 or node 3, wherever resources allow.
4. **The new container starts**, passes its health check, and joins the load balancer.
5. **Node 2 comes back.** It rejoins as healthy and empty. Nothing moves back until the next update, because the desired state is already met.

The app stayed up because there were three copies and a load balancer that only sends traffic to healthy ones. The orchestrator made sure the count returned to three without anyone waking up.

One caveat: this works cleanly for **stateless** services. A database whose data lived on node 2's local disk can't be rescheduled elsewhere without its data. That is why stateful services are either pinned to a node with backups, or given replicated or network storage.

## Do you need container orchestration?

Not always. Orchestration has a cost: more concepts, more components, more to monitor. A rough guide by stage:

| Stage | Typical setup | Orchestration? |
| --- | --- | --- |
| One app, one server | Docker Compose with restart policies | No. Compose and good backups are enough. |
| Several apps, one or two servers, small team | Compose per app, or a small cluster | Optional. Useful once deploys and reboots start to hurt. |
| Many services, a few to dozens of servers | Docker Swarm, Nomad, or a PaaS on top | Yes. Manual placement stops scaling. |
| Large fleet, platform team | Kubernetes, managed or self-run | Yes, with the ecosystem around it. |

Signs that you have reached the "yes" rows:

- A server reboot means manually restarting containers.
- Deploys cause a few seconds or minutes of downtime and people work around it.
- You keep a spreadsheet or wiki page of which container runs where.
- Two people deploying at once has broken something.
- Scaling means SSH, copy a command, change the port, update the proxy.

If containers themselves are still new to you, start with [containerization](/blog/containerization/) before choosing an orchestrator.

## Orchestration is not a platform

An orchestrator keeps containers running. It doesn't, on its own:

- Build images from your Git repository.
- Get TLS certificates and route `app.example.com` to the right service.
- Back up databases and volumes, or test that backups restore.
- Store logs and metrics history with alerts.
- Give your team logins, roles and an audit log.
- Create a preview environment for each pull request.

Teams fill these gaps with a stack of extra tools, or adopt a platform that bundles them on top of the orchestrator. For the tools themselves, see our roundup of [container orchestration tools](/blog/container-orchestration-tools/). For a head-to-head on the two most common orchestrators, read [Docker Swarm vs Kubernetes](/blog/docker-swarm-vs-kubernetes/).

## Common mistakes when you start orchestrating

- **Keeping state inside containers.** Uploads written to the container filesystem vanish when the orchestrator replaces it. Use volumes, object storage or a database.
- **Deploying `:latest`.** Two nodes can pull two different images under the same tag, and a rollback has nothing exact to go back to. Tag images with a commit or build ID.
- **No health checks.** Without one, the orchestrator sends traffic to a container the moment it starts, before the app is ready. This is the most common cause of errors during [zero-downtime deployments](/blog/zero-downtime-deployments/).
- **No resource limits.** One leaking process takes a whole node down with it, and the scheduler can't place work it can't measure.
- **One manager.** A single control node is a single point of failure for every change. Run three.
- **Changing things by hand.** A quick `docker service scale` from a shell works until the next deploy silently overrides it, or doesn't.

## Two layers of reconciliation

The reconcile loop is a good idea at every level, not only inside the orchestrator. Docker Swarm reconciles tasks: it keeps the replica count and image you last set. But Swarm treats whatever was set last as the truth, even if it came from a shell at 3 a.m. It also knows nothing about your proxy routes, DNS records or backups.

LogiStack adds a second loop above Swarm. It is an open-source, self-hosted PaaS that keeps the desired state of every service, domain and variable as rows in Postgres. The dashboard, the REST API, project manifests and the MCP server only change those rows. A worker then converges Docker Swarm and the Caddy proxy to them:

- Deploy jobs move each service through clone, build, push and deploy, and every step can be re-run safely.
- A reconciler runs every 30 seconds as a safety net. It compares desired state with what Docker reports, records the observed state, detects crash loops, and removes orphaned objects that carry LogiStack's labels but no longer have a row.
- A proxy sync compiles every domain into one Caddy configuration and loads it through Caddy's admin API. If Caddy rejects it, the previous configuration stays.

The result: a service scaled by hand goes back to the size you set, and a deploy interrupted by a worker restart finishes on the next attempt. The full design is in the [architecture reference](/docs/reference/architecture/), and adding machines to the cluster is covered in [Nodes](/docs/operations/nodes/).

![The network map: every service, the networks it joins and the ports it publishes](/docs/screens/network.webp)

The trade-off is scope. LogiStack orchestrates through Swarm, so you get Swarm's model, not Kubernetes' ecosystem, and the project is young.

## FAQ

### What is the difference between containerization and orchestration?

Containerization packages an app and its dependencies into an image that runs the same everywhere. Orchestration runs many of those containers across many machines and keeps them in the state you declared. You need the first before the second.

### Is Docker Compose a container orchestrator?

Not really. Compose starts and connects containers on one host from a YAML file, and restart policies bring them back after a crash. It doesn't schedule across machines, roll out updates with health checks or reschedule after a node failure. Docker Swarm, which reads the same file format, does.

### Is Kubernetes the only container orchestration platform?

No. Docker Swarm and HashiCorp Nomad are mature alternatives, and cloud providers offer their own, such as Amazon ECS. Kubernetes has the largest ecosystem, but smaller orchestrators are easier to run for small teams.

### Can orchestration run databases?

Yes, with care. The simplest approach pins a database to one node with its local volume and backs it up on a schedule. Advanced setups use replicated storage or database operators for automatic failover, which mostly means Kubernetes.

### How many servers do I need for orchestration?

One is enough to start: a single-node cluster gives you rolling updates, health-based restarts and secrets. You need at least three to tolerate a node failure without losing the control plane.

If you want the reconcile-loop model without assembling the pieces yourself, LogiStack installs on one Linux server with a single command and adds servers from the dashboard. [Install it](/#install) and deploy your first service in a few minutes.

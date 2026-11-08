---
title: "Kamal alternatives: Kamal vs a PaaS with a dashboard"
description: "Kamal alternatives compared: when Kamal's deploy.yml is the right tool, and when a self-hosted PaaS with a dashboard, databases and backups fits better."
date: 2026-11-08
category: Comparisons
keywords: kamal alternatives, kamal vs coolify, kamal deploy alternative, kamal vs dokku, kamal dashboard
---

Kamal is a good answer to a narrow question: how do I get my container onto my servers with zero downtime, without a platform in the way? 37signals built it to move Basecamp and HEY off the cloud, and it shows. One YAML file, one command, and the result is predictable. People look for Kamal alternatives when the question gets wider. Who runs the database backups? Where does a teammate read logs? How do you add a staging copy for a pull request? This article compares Kamal with a PaaS that has a dashboard, fairly, and helps you decide which one fits your team.

## What Kamal is

Kamal is an MIT-licensed deploy tool. It runs on your machine or in CI and talks to your servers over SSH. On a deploy it:

1. Builds your Docker image and pushes it to a registry.
2. Connects to every host listed in the config and pulls the image.
3. Starts the new container, waits for its health check, and tells `kamal-proxy` to send traffic to it.
4. Stops the old container once traffic has drained.

`kamal-proxy` routes by hostname, so several apps can share a server, and it can obtain and renew TLS certificates on its own. Supporting containers such as a database or Redis are declared as accessories. Kamal 2 is the current major version, and it installs Docker on a fresh Ubuntu server for you.

A minimal config looks like this:

```yaml
# config/deploy.yml
service: shop
image: acme/shop
servers:
  web:
    - 203.0.113.10
    - 203.0.113.11
  job:
    hosts:
      - 203.0.113.12
    cmd: bin/jobs
proxy:
  host: shop.example.com
  ssl: true
registry:
  username: acme
  password:
    - KAMAL_REGISTRY_PASSWORD
env:
  secret:
    - DATABASE_URL
accessories:
  redis:
    image: redis:7
    host: 203.0.113.12
    port: "127.0.0.1:6379:6379"
```

## Why teams like Kamal

Kamal's design choices are deliberate, and for many teams they are the right ones.

- **Nothing runs on the server but your containers and a proxy.** No control plane to update, secure or back up.
- **Config lives in the repository.** Every change to deployment is a reviewed commit.
- **Any host works.** Cloud VMs, bare metal, a mix of providers. If you can SSH in, Kamal can deploy.
- **Multi-server from the start.** Listing more IPs is all it takes to run on more hosts.
- **Fast, plain rollbacks.** `kamal rollback <version>` starts a previous image that is still on the hosts.
- **Tiny surface area.** Fewer moving parts means fewer things to fail at 3 a.m.

If your team is a few engineers who live in the terminal, deploy one or two apps, and already run their databases elsewhere, Kamal is hard to improve on. Keep it.

## Where Kamal stops

Kamal deploys. It does not try to be a platform, so these are yours to build:

- **Databases.** An accessory is a container with a volume. Versions, tuning, backups and restores are up to you.
- **Backups.** There is no scheduler, no retention policy and no restore check.
- **Visibility.** `kamal app logs` streams logs from the hosts. Metrics, alerts and a history of deploys need other tools.
- **People.** Anyone who deploys needs SSH access and the secrets. There are no roles, no SSO and no audit log beyond Git history.
- **Previews.** A per-pull-request environment means scripting destinations and DNS from CI.
- **Scheduling.** You decide which host runs what. If a host dies, its containers stay down until you act.

None of these are bugs. They are the cost of a deliberately small tool.

## Kamal vs a PaaS with a dashboard

| | Kamal | Self-hosted PaaS (for example LogiStack) |
| --- | --- | --- |
| Where it runs | Your laptop or CI, over SSH | A control plane on your servers |
| Config | `config/deploy.yml` in the repo | Dashboard, API, or YAML manifests in Git |
| Builds | Dockerfile, built locally or remotely | Dockerfile, Railpack or static, built on the server |
| Zero-downtime deploys | Yes, via `kamal-proxy` health checks | Yes, rolling updates with health checks |
| TLS | `kamal-proxy` per host | Caddy, including wildcard certificates over DNS-01 |
| Placement | You assign roles to hosts | The scheduler places replicas across nodes |
| Node failure | Containers wait for you | Swarm reschedules replicas on healthy nodes |
| Databases | Accessories you operate | Managed engines with an editor |
| Backups | Your scripts | Scheduled, encrypted, with restore checks |
| Logs and metrics | CLI log streaming | Searchable logs, metrics, alerts in the browser |
| Team access | SSH keys and secrets | Roles, SSO, audit log |
| Previews | Your CI scripts | Built in per pull request |
| What you maintain | Nothing extra on the hosts | The platform itself, updated from the dashboard |

The short version: Kamal keeps the server simple and pushes work into your repository and your head. A PaaS puts more software on the server and takes work off your plate.

## Kamal alternatives

### LogiStack

LogiStack is an open-source PaaS under Apache 2.0. It runs on Docker Swarm with Caddy as the proxy, and the desired state of every service lives in Postgres, where a reconciler keeps Docker and Caddy in line with it. For a Kamal user, the key differences are:

- **The server builds.** Push to GitHub, GitLab, Gitea or Bitbucket, and the build runs in rootless BuildKit on your server. Your existing Dockerfile works as is. See [deploy from Git](/docs/deploy/from-git/).
- **Images are immutable.** Tags look like `<registry>/<org>/<service>:<deploymentId>`, and a rollback runs exactly that image.
- **Databases are a product.** Postgres, MySQL, MariaDB, MongoDB, Redis and libSQL, with a table editor, query console, encrypted scheduled [backups](/docs/data/backups/) and a job that restores the latest backup into a throwaway container to prove it works.
- **Config can still live in Git.** [Project manifests](/docs/automation/project-manifests/) export a project as YAML that you apply from CI, with secrets never exported.
- **Nodes join from the dashboard.** A wizard checks a server over SSH, installs Docker and joins it to the Swarm; an agent then reports metrics and logs.

The honest trade-offs: you run a control plane, which needs at least 2 GB of RAM and updates of its own. LogiStack is young, with a much smaller community than Kamal and Rails. It uses Swarm, so if you want Kubernetes later, neither tool takes you there.

### Coolify and Dokploy

Both are open-source dashboards that deploy from Git, run databases and handle certificates. Coolify places each app on a server you choose; Dokploy runs on Swarm with Traefik. The [LogiStack vs Dokploy vs Coolify](/blog/logistack-vs-dokploy-vs-coolify/) comparison lays out the differences.

### Dokku

Dokku is the closest in spirit to Kamal: small, CLI-driven, no dashboard in its free edition. It builds on the server with buildpacks and manages databases through plugins, but it is built around one host. See [Dokku alternatives](/blog/dokku-alternatives/).

### Managed platforms

If what you actually want is to stop thinking about servers, Render, Railway and Fly.io run containers for you. You pay more per unit of compute and give up the control that brought you to Kamal. [Heroku vs self-hosted](/blog/heroku-vs-self-hosted/) compares the economics.

## Can you combine them?

Yes, and some teams do. A common split:

- Kamal deploys the main product app, whose deploy config the developers want in the repo.
- A PaaS runs the supporting cast: Postgres with backups, internal tools, analytics, a status page, from [one-click templates](/templates/).

That keeps the critical path minimal while the rest gets a dashboard. Use separate servers, since both want ports 80 and 443.

## Moving from Kamal to a PaaS

The move is usually short because Kamal already forced you to containerize.

1. **Reuse the Dockerfile.** Point the new service at the repository and keep the Dockerfile as the build type.
2. **Copy secrets.** Read `.kamal/secrets` and set each value as a variable on the new service.
3. **Map roles to services.** The `web` role becomes a service with a domain. Each other role, such as `job`, becomes a service with its own start command and no domain.
4. **Replace accessories.** Create a managed database, then dump and restore. If the Postgres accessory publishes its port on `127.0.0.1:5432` of its host, tunnel to it over SSH:

```bash
ssh -N -L 5433:127.0.0.1:5432 root@203.0.113.12 &
pg_dump -h 127.0.0.1 -p 5433 -U postgres -Fc shop > shop.dump
pg_restore --no-owner -d "$NEW_DATABASE_URL" shop.dump
```

5. **Switch DNS** once the new service answers with a valid certificate, then run `kamal app stop` on the old hosts.

## FAQ

### Is Kamal better than a PaaS?

For a small team with one or two apps, an external database and strong terminal habits, Kamal is often the better choice: less to run, less to secure. A PaaS pays off when several people deploy, when you run many services, or when databases and backups need to be handled for you.

### Does Kamal have a web UI?

No. Kamal is a command-line tool, and its state lives in your config and on the hosts. If you need a dashboard, use a self-hosted PaaS, or pair Kamal with separate tools for logs and metrics.

### Can Kamal deploy to multiple servers?

Yes. You list hosts per role in `config/deploy.yml`, and Kamal deploys to all of them. It does not move containers when a host fails; a scheduler such as Docker Swarm does.

### Is Kamal only for Rails?

No. It deploys any containerized app. It comes from the Rails world and its defaults suit Rails, but Node, Go, Python and PHP apps work the same way.

If Kamal covers your deploys but you want databases, backups, logs and team access handled in one place on your own servers, try LogiStack. The [one-line installer](/#install) sets it up on a fresh server, and your Kamal Dockerfile works unchanged.

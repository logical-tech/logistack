---
title: "CapRover alternatives: self-hosted PaaS options compared"
description: "Compare CapRover alternatives for 2026, from Swarm-based platforms to single-server tools and managed hosts, with a clear pick for each kind of team."
date: 2026-11-08
category: Comparisons
keywords: caprover alternatives, caprover alternative, caprover vs coolify, caprover vs dokploy, self-hosted paas
---

CapRover has been a quiet workhorse of self-hosting for years. One install gives you Docker Swarm, nginx, Let's Encrypt and a dashboard, and the `caprover` CLI pushes your code. Teams look for CapRover alternatives when they need things it was not built around: a database editor, scheduled backups they can restore, preview environments, single sign-on, or a configuration format that is not a `captain-definition` file. This guide compares the options by what you need next, not by feature count.

## What CapRover gets right

CapRover deserves a fair summary before you replace it. It is Apache 2.0 licensed, still released in 2026, and built on proven parts:

- **Docker Swarm** for scheduling and clustering, so you can add nodes.
- **nginx** as the load balancer, with config you can customize per app.
- **Let's Encrypt** certificates for every app domain.
- **One-click apps** for common software, maintained by the community.
- **NetData** for server monitoring.
- **Deploy by CLI, tarball, webhook or image**, described by a small JSON file:

```json
{
  "schemaVersion": 2,
  "dockerfilePath": "./Dockerfile"
}
```

Its requirements are modest: a server with 1 GiB of RAM, a wildcard DNS record and ports 80, 443 and 3000 open. For a solo developer running a few apps, that is hard to beat.

## Where teams outgrow CapRover

The pain points come up again and again:

- **Data operations.** One-click databases exist, but there is no built-in table editor, and backups of app data are mostly your job.
- **Team access.** There is one admin password. If several people deploy, you share it or build around it.
- **Workflow.** No preview environment per pull request and no first-class staging versus production split.
- **Config as code.** The `captain-definition` file covers the build, not the whole app with its domains, variables and volumes.
- **Observability.** NetData shows the host. Per-service metrics, alerts and log search need extra tools.

If none of these hurt, stay on CapRover. If some do, the alternatives below fix different subsets.

## CapRover alternatives at a glance

| Tool | Hosting | Orchestration | Proxy | Multi-server | License |
| --- | --- | --- | --- | --- | --- |
| LogiStack | Self-hosted | Docker Swarm | Caddy | Swarm nodes with an agent | Apache 2.0 |
| Dokploy | Self-hosted or vendor cloud | Docker Swarm | Traefik | Swarm and remote servers | Open source |
| Coolify | Self-hosted or vendor cloud | Docker | Traefik or Caddy | One server per app, over SSH | Apache 2.0 |
| Dokku | Self-hosted | Docker, k3s or Nomad | nginx | Through k3s or Nomad schedulers | MIT |
| Kamal | Self-hosted, no dashboard | Docker over SSH | kamal-proxy | Hosts listed in config | MIT |
| Portainer | Self-hosted | Docker, Swarm, Kubernetes | None built in | Agents per environment | zlib (CE) |
| Render, Railway | Managed | Vendor | Vendor | Vendor regions | Proprietary |

## Swarm-based CapRover alternatives

If you chose CapRover for Swarm, you probably want to keep it. Swarm is simpler than Kubernetes and built into Docker. Two newer platforms keep that base and add more on top. The [Docker Swarm guide](/blog/docker-swarm/) explains the model if you have only used it through CapRover.

### LogiStack

LogiStack is an open-source PaaS (Apache 2.0) on Docker Swarm, with Caddy as the proxy. Compared with CapRover, the differences are in how it applies changes and in what ships with it.

**How it works.** The desired state of every service, domain and certificate is stored in Postgres, and a reconciler keeps Docker and Caddy matching it. Builds run in rootless BuildKit and get immutable tags of the form `<registry>/<org>/<service>:<deploymentId>`, so a rollback runs the exact image it names. A new container must pass its health check before the old one stops.

**What ships.**

- Builds from GitHub, GitLab, Gitea, Bitbucket or any SSH git URL, with a Dockerfile, Railpack or a static site. See [build types](/docs/deploy/build-types/).
- Postgres, MySQL, MariaDB, MongoDB, Redis and libSQL with a table editor, query console and schema diagram.
- Encrypted backups of databases and volumes to S3, SFTP, WebDAV, Azure or Google Drive, with a scheduled job that restores the latest backup into a throwaway container. See [backups](/docs/data/backups/).
- Environments, preview environments per pull request, and YAML manifests you can keep in Git.
- Organizations, custom roles, OIDC and SAML sign-in, passkeys and an audit log.
- More than 500 one-click templates and Compose stacks you paste or pull from Git.
- An agent per node that reports metrics, logs and container health, plus alert rules.

Adding a node is a wizard: it checks the server over SSH, installs Docker and joins it to the Swarm. See [nodes](/docs/operations/nodes/).

The trade-offs: LogiStack is younger than CapRover, with a smaller community and fewer forum answers. It needs 2 GB of RAM, twice CapRover's minimum. There is no automated importer from CapRover, so you move apps by hand.

### CapRover and LogiStack side by side

| | CapRover | LogiStack |
| --- | --- | --- |
| Proxy | nginx, customizable per app | Caddy, compiled from stored state |
| Build input | `captain-definition`, Dockerfile, tarball, image | Git with Dockerfile, Railpack or static site, or an image |
| Databases | One-click apps | Six engines with a table editor and query console |
| Backups | Your scripts for app data | Scheduled, encrypted, with restore checks |
| Users | One admin password | Members, custom roles, SSO, passkeys |
| Previews | Not built in | Per pull request |
| Monitoring | NetData per host | Per-service metrics, logs and alert rules |
| Minimum RAM | 1 GiB | 2 GB |

The table is not a scorecard. If you run three personal projects, CapRover's smaller footprint may matter more than any row on the right.

### Dokploy

Dokploy runs on Swarm with Traefik, builds from Git with several builders, deploys Compose files and runs databases with S3 backups. It has a large community and a hosted control plane option. The [three-way comparison](/blog/logistack-vs-dokploy-vs-coolify/) covers how it differs from LogiStack and Coolify.

## Non-Swarm alternatives

### Coolify

Coolify has the largest one-click catalog among self-hosted platforms and a busy community. It deploys plain Docker containers to the servers you connect, and you choose the server for each app. That is simpler than Swarm and gives you no automatic rescheduling if a node dies.

### Dokku

Dokku is the minimal choice: Heroku-style `git push` deploys, buildpacks or a Dockerfile, plugins for databases and certificates. It is CLI only in the free version; Dokku Pro is a paid add-on with a web UI and JSON API. If you liked CapRover's simplicity and want less dashboard, see [Dokku alternatives](/blog/dokku-alternatives/).

### Kamal

Kamal from 37signals deploys containers over SSH, with `kamal-proxy` handling zero-downtime switches and TLS. Everything lives in `config/deploy.yml` in your repository. There is no dashboard and no database tooling. [Kamal alternatives](/blog/kamal-alternatives/) explains when that is a strength.

### Portainer

Portainer is a container management UI, not a PaaS. It does not build from Git with a buildpack or issue certificates for you. It is a good companion when you want to see and fix containers, and a weak replacement for push-to-deploy.

## Managed options

If you are tired of running servers, Render and Railway remove the host entirely. You lose Swarm, the flat server bill and control over location.

## Moving from CapRover

There is no one-click path from CapRover to any platform, so plan per app.

**1. Inventory.** For each app, note the image or build method, environment variables, persistent directories, domains and the container port. CapRover shows these per app in its dashboard.

**2. Choose the build.** If your `captain-definition` points at a Dockerfile, reuse it. If it uses a template, write a short Dockerfile or try Railpack.

**3. Move the data.** For a database, dump from the CapRover container and restore into the new one:

```bash
docker exec $(docker ps -q -f name=srv-captain--db) \
  pg_dump -U postgres -Fc app > app.dump
pg_restore --no-owner -d "$NEW_DATABASE_URL" app.dump
```

For a persistent directory, copy the volume contents into the new service's volume.

**4. Cut over DNS.** CapRover relies on a wildcard record. Add explicit records for the moved apps, wait for HTTPS, then remove the app from CapRover.

## FAQ

### Is CapRover still maintained?

Yes. CapRover published a new release in November 2026, and its GitHub repository is active. Its pace is steady rather than fast, and new features land less often than on newer platforms.

### What is the best CapRover alternative on Docker Swarm?

LogiStack and Dokploy both run on Swarm and add databases, backups and team features. LogiStack uses Caddy and stores desired state in Postgres with a reconciler; Dokploy uses Traefik and has a larger community.

### Can I run CapRover and another platform on the same server?

Not easily. Both want ports 80 and 443 and both manage the Swarm. Use a second server for the new platform and move apps across.

### Is CapRover good enough for production?

For small teams and a few apps, yes. It is stable and simple. The gaps show when several people deploy, when you need preview environments, or when restoring data has to be a tested routine.

If you want to keep Swarm and gain databases, restore-checked backups and team access in one free package, try LogiStack. Install it with the [one-line script](/#install), then add a second node when one server is no longer enough.

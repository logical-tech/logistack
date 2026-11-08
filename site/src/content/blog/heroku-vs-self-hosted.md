---
title: "Heroku vs self-hosted: cost, control and the work you take on"
description: "Heroku vs self-hosted deployment compared on cost, operations, data control and lock-in, with a concept map and a migration path to your own servers."
date: 2026-11-08
category: Self-hosting
keywords: heroku vs self-hosted, self-hosted heroku, heroku alternative, self-hosted paas, leave heroku
---

The Heroku invoice arrives, and it is bigger than the server it replaces would cost by an order of magnitude. Then you remember why you pay it: nobody on your team has been woken up by a full disk in years. That is the real Heroku vs self-hosted question. Not "which is better", but who does the operational work, and what that work is worth to you.

This guide compares the two honestly. It covers where Heroku still earns its price, what self-hosting actually involves in 2026, how Heroku's concepts map to a self-hosted PaaS, and how to move one app without downtime.

## The short answer

- **Stay on Heroku** if your team is small, your bill is a small share of revenue, and you have no data-location or compliance constraints.
- **Self-host** if the bill keeps growing with steady traffic, you need data in a specific place, or you want to stop translating your app into one vendor's add-on catalog.

Self-hosting no longer means writing Ansible and Nginx configs by hand. A self-hosted PaaS gives you `git push` deploys, HTTPS and managed databases on servers you rent. You still own the servers.

## What Heroku gives you

Heroku defined the developer experience that every PaaS now copies:

- **Dynos and buildpacks.** Push code, Heroku detects the language, builds a slug and runs it in a dyno.
- **The Procfile.** One line per process type: `web`, `worker`, `release`.
- **Add-ons.** Postgres, Redis, logging, email and monitoring, attached with one command and billed on one invoice.
- **Pipelines and review apps.** Promote a build from staging to production, and get a temporary app per pull request.
- **No servers to patch.** Operating system, runtime security fixes and the routing layer are Heroku's job.

It also comes with constraints you design around: an ephemeral filesystem that resets when a dyno restarts, dynos that restart at least once a day, pricing per dyno size and per add-on plan, and limited choice of where your data lives. The free tier ended in 2022, so every hobby app is now a paid one.

## What self-hosting means today

Self-hosting has three layers, and you choose how much of each you want to own:

1. **The server.** A VPS or dedicated machine from Hetzner, OVHcloud, DigitalOcean, Vultr or any provider. You pay a flat monthly price for CPU, memory and disk.
2. **The platform.** Software that turns that server into a PaaS: builds, containers, routing, certificates, databases and backups. Examples are LogiStack, Coolify, Dokploy and Dokku.
3. **Your apps.** The same code you push to Heroku, usually with a Dockerfile or a zero-config builder.

You stop paying per process and per add-on, and you start paying for machines. What you run on them is up to you.

## Heroku vs self-hosted compared

| | Heroku | Self-hosted PaaS |
| --- | --- | --- |
| Time to first deploy | Minutes | An hour the first time, including the server |
| Cost shape | Per dyno and per add-on plan, grows with each process | Flat per server, grows in steps when you add one |
| Scaling | Add dynos or larger dyno types | Add replicas, then add servers |
| Databases | Managed add-ons with backups and followers | Containers you run, with backups you schedule |
| Filesystem | Ephemeral | Persistent volumes on the node |
| Data location | Heroku's regions | Any provider, any country, your own hardware |
| Operating system patches | Heroku | You |
| Support | Vendor support plans | Community, or a support contract you buy |
| Lock-in | Buildpacks, add-ons, pipelines | Containers and standard database dumps |

## Cost: how to compare without guessing

Don't compare list prices; compare your own bill line by line.

1. Write down each dyno type and count, and each add-on with its plan.
2. Add up the memory you actually use across dynos, plus the database size and connections you need.
3. Size servers to that with headroom: roughly double your steady memory, so builds and spikes fit.
4. Add the cost of off-site backup storage, which is usually small with S3-compatible object storage.
5. Add your own time. Budget a few hours a month for updates and checks, more in the first month.

For most teams with steady traffic, the server line ends up a small fraction of the Heroku line. The time line is what decides it. If an hour of an engineer costs more than the monthly difference, Heroku is the cheaper option. If you already run Docker in production, it rarely is.

## The work you take on when you self-host

Be clear about this before you move. A good platform automates most of it, but not all.

**The platform handles:**

- Building images from Git and rolling them out with health checks.
- Issuing and renewing HTTPS certificates.
- Restarting crashed containers and moving them when a node fails, if you run more than one.
- Scheduled database and volume backups to S3-compatible storage.
- Logs, metrics and alerts per service.

**You still handle:**

- Operating system updates on each server and the occasional reboot.
- Firewall rules at your provider.
- Disk space, especially build caches and old images.
- Keeping backups off the server, and testing that they restore.
- Keeping the platform itself up to date.

LogiStack narrows the second list where it can: backups can run a scheduled restore check into a throwaway container, nodes show disk use by directory and can prune unused images, and updates run from **Settings > Updates** with an automatic rollback if a component fails. The OS and the firewall stay yours.

## Mapping Heroku concepts to a self-hosted PaaS

Most of what you know transfers. Here is how Heroku's vocabulary maps to LogiStack:

| Heroku | LogiStack |
| --- | --- |
| App | Service, grouped in a project |
| Buildpack | Railpack (no config) or your Dockerfile |
| Procfile `web` | A service with a domain |
| Procfile `worker` | A second service from the same repository with its own start command |
| Procfile `release` | A pre-deploy command that runs before the new version starts |
| Config vars | Environment variables at organization, project, environment or service level |
| Heroku Postgres, Heroku Key-Value Store | Managed Postgres, Redis and four other engines |
| Pipelines | Environments such as staging and production |
| Review apps | Preview environments per pull request |
| Heroku Scheduler | Scheduled jobs with run history |
| `heroku run bash` | A terminal in the running container, in the browser |
| Rollback | Roll back to any earlier deployment, using its image |

See [Deploy from Git](/docs/deploy/from-git/) and [Preview environments](/docs/deploy/preview-environments/) for the details.

## Moving one app off Heroku

Start with one non-critical app. The steps below keep Heroku serving until the new copy is ready.

**1. Prepare a server and install the platform.** A server with 2 vCPU and 4 GB of RAM is a good start. See [choosing a VPS in Europe](/blog/choosing-a-vps-in-europe/) if location matters.

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

**2. Create the service.** Connect the repository, choose Railpack or your Dockerfile, and copy your config vars:

```bash
heroku config --app my-app --shell > heroku.env
```

Review the file before you paste it: drop Heroku-specific variables such as `DATABASE_URL` from the add-on, which you replace in the next step.

**3. Move the database.** Create a Postgres database in LogiStack, then export from Heroku and restore:

```bash
heroku pg:backups:capture --app my-app
curl -o latest.dump "$(heroku pg:backups:url --app my-app)"
```

Upload `latest.dump` through the database's restore action, or restore it with `pg_restore` from a machine that can reach the database. Then set `DATABASE_URL` on the service.

**4. Test on a generated hostname.** Deploy and open the service on its generated domain before touching DNS.

**5. Freeze writes, sync, switch.** Put the Heroku app in maintenance mode, take a final dump, restore it, then point your domain at the new server. Caddy issues the certificate on the first request.

```bash
heroku maintenance:on --app my-app
```

Keep the Heroku app for a week, scaled down, in case you need to go back.

## When Heroku is still the better choice

Credibility matters more than a sale, so here it is plainly:

- You are one or two developers, and every hour spent on servers is an hour not spent on the product.
- Your Heroku bill is small next to revenue, and growing slowly.
- You rely on add-ons with no good self-hosted equivalent.
- You need a vendor support contract and an SLA to satisfy customers.

In those cases, stay. Revisit the question when the bill or the constraints change. [Heroku alternatives](/blog/heroku-alternatives/) covers hosted options that sit between the two.

## FAQ

### Is self-hosting cheaper than Heroku?

On infrastructure, almost always, once you have steady traffic. The honest comparison includes your time for updates and checks. Teams that already run Docker usually find it cheaper overall; teams with no ops experience may not.

### Can I get a Heroku-like experience on my own server?

Yes. A self-hosted PaaS gives you deploys from Git, automatic HTTPS, environment variables, managed databases and rollbacks. With LogiStack you also get preview environments and scheduled backups, all in the free, open-source build.

### Do I need Docker knowledge to leave Heroku?

It helps but isn't required. Railpack builds most Node, Python, Ruby, Go and PHP apps without a Dockerfile. Knowing how to read container logs and how volumes work will save you time when something goes wrong.

### What happens to my data when a server dies?

Volumes live on the server that runs the service, so you need backups somewhere else. Schedule database and volume backups to S3-compatible storage, and test a restore. See [Backups](/docs/data/backups/).

If you have decided to try self-hosting, LogiStack is a good first platform: one command to [install](/#install), a guided setup wizard, and every feature in the open-source build. Read [the install guide](/docs/getting-started/install/) and move your least critical Heroku app first.

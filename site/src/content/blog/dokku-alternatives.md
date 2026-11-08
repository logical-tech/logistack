---
title: "Dokku alternatives: when one server and a CLI are not enough"
description: "Compare Dokku alternatives for 2026: self-hosted PaaS with a dashboard, multi-server Swarm platforms, Kamal and managed hosts, with honest trade-offs."
date: 2026-11-08
category: Comparisons
keywords: dokku alternatives, dokku alternative, dokku vs coolify, dokku vs caprover, dokku multiple servers
---

Dokku is the smallest PaaS that feels like Heroku. You install it on a VPS, run `git push dokku main`, and your app is built, started and given a domain. It is MIT-licensed, mature and well documented. People start searching for Dokku alternatives when the terminal stops being enough: a teammate needs to see logs without SSH access, the app has outgrown one server, or backups and databases need more than a plugin and a cron entry. This guide covers what to move to, and when to stay.

## What Dokku does well

Dokku's strengths are real, and they shape what a good replacement must keep.

- **Heroku compatibility.** Herokuish buildpacks, Cloud Native Buildpacks, `Procfile` process types and `app.json` hooks work the way Heroku users expect.
- **Many builders.** Besides buildpacks, it supports Dockerfiles, Nixpacks, Railpack and prebuilt images.
- **Small footprint.** The Docker scheduler needs 1 GB of memory, or less with swap.
- **Plugins.** Official plugins add Postgres, MySQL, Redis, Let's Encrypt and more.
- **Scriptable.** Every action is a shell command, which makes automation simple:

```bash
dokku apps:create shop
dokku postgres:create shop-db
dokku postgres:link shop-db shop
dokku domains:set shop shop.example.com
dokku letsencrypt:enable shop
git push dokku main
```

For a developer with a handful of apps on one VPS, that is close to ideal. Nothing to click, nothing extra to secure.

## Where Dokku gets hard

The limits show up as your setup grows.

- **No free web UI.** Dokku Pro adds a web UI and a JSON API, but it is a paid product. The free edition is CLI only, so everyone who deploys needs SSH access to the server.
- **One server by default.** Dokku can schedule onto k3s or Nomad, but then you run and understand those systems too. Most installs stay on one host.
- **Backups are plugin commands.** You can export a database to S3 from a plugin, but scheduling, retention and testing a restore are yours to build.
- **Team features.** There are no roles, no SSO and no audit log beyond your shell history.
- **Previews.** Per-pull-request environments mean scripting app creation from CI.

## Dokku alternatives at a glance

| Tool | Interface | Builds | Multi-server | Databases | License |
| --- | --- | --- | --- | --- | --- |
| LogiStack | Dashboard, API, MCP | Railpack, Dockerfile, static | Docker Swarm | Six engines with editor and backups | Apache 2.0 |
| Coolify | Dashboard, API | Nixpacks, Dockerfile, Compose | One server per app | One-click with S3 backups | Apache 2.0 |
| Dokploy | Dashboard, API | Several builders, Dockerfile, Compose | Docker Swarm | One-click with S3 backups | Open source |
| CapRover | Dashboard, CLI | captain-definition, Dockerfile | Docker Swarm | One-click apps | Apache 2.0 |
| Kamal | CLI, config file | Dockerfile | Hosts in config | Accessories | MIT |
| Heroku, Render | Managed dashboard | Buildpacks or native runtimes | Vendor | Managed Postgres | Proprietary |

## If you want a dashboard

### LogiStack

LogiStack is an open-source PaaS under Apache 2.0, on Docker Swarm with Caddy for HTTPS. It keeps Dokku's push-to-deploy flow and adds the parts teams usually bolt on.

| Dokku | LogiStack |
| --- | --- |
| `git push dokku main` | Push to GitHub, GitLab, Gitea or Bitbucket; webhooks are registered for you ([deploy from Git](/docs/deploy/from-git/)) |
| Buildpacks, Dockerfile, Railpack | Railpack, Dockerfile or a static site ([build types](/docs/deploy/build-types/)) |
| `Procfile` process types | One service per process, each with its own start command |
| `dokku postgres:create` | Postgres, MySQL, MariaDB, MongoDB, Redis or libSQL in one click, with a table editor |
| `postgres:backup` to S3 | Scheduled, encrypted backups with retention and restore checks |
| `dokku letsencrypt:enable` | Automatic HTTPS from Caddy, including wildcard certificates over DNS-01 |
| `dokku logs`, `dokku enter` | Log search, metrics and a browser terminal per service |
| SSH keys per user | Members, custom roles, SSO and an audit log |

Previews are built in: each pull request gets its own environment and URL, and it is removed on merge. Scheduled jobs run in a fresh container, in an existing service or on a node, with a history of every run.

The trade-offs are the mirror image of Dokku's strengths. LogiStack needs 2 GB of RAM against Dokku's 1 GB. It has no Herokuish buildpacks, so a few Heroku-specific apps need a Dockerfile. It is a young project with a smaller community. And a dashboard is one more service to keep updated.

### Coolify

Coolify gives you a polished dashboard and a large catalog of one-click services. It connects to extra servers over SSH and places each app on the server you choose. See [Coolify alternatives](/blog/coolify-alternatives/) for its strengths and gaps.

### CapRover

CapRover sits between Dokku and the newer platforms: a simple dashboard on Docker Swarm with nginx, plus a CLI. It is a good step up if you want a UI without many concepts. Read [CapRover alternatives](/blog/caprover-alternatives/) for the full picture.

### Dokploy

Dokploy runs on Swarm with Traefik and covers Git builds, Compose, databases and S3 backups. The [Dokploy alternatives](/blog/dokploy-alternatives/) article compares it in detail.

## If you want to stay in the terminal

### Kamal

Kamal is what many Rails teams move to from Dokku. You describe servers, the image and the proxy in `config/deploy.yml`, then run `kamal deploy`. It builds the image, pushes it to a registry and swaps containers behind `kamal-proxy` with no downtime. It works across many hosts from day one, because each host is just an SSH target.

You give up buildpacks (Kamal needs a Dockerfile) and any notion of a platform: there is no database plugin, no backup schedule and no catalog. The [Kamal alternatives](/blog/kamal-alternatives/) post compares it with dashboard platforms.

### Plain Compose

Some teams leave Dokku for a `docker-compose.yml`, a reverse proxy and a deploy script. It is transparent, and you rebuild every feature Dokku gave you. [Docker Compose in production](/blog/deploy-docker-compose-in-production/) covers what that takes.

## If you want to stop running servers

Heroku is the original Dokku was modeled on, and Render is its closest modern equivalent. Both remove patching and on-call for the host and cost more per unit of compute.

## A day with each tool

The difference is easiest to see in routine tasks.

| Task | Dokku | Dashboard PaaS such as LogiStack |
| --- | --- | --- |
| Read a failing app's logs | `ssh` in, then `dokku logs shop -t` | Open the service, search the logs in the browser |
| Give a contractor access | Add their SSH key, which by default reaches every app | Invite them with a role scoped to one project |
| Check last night's backup | Read the cron output on the host | See the run, its size and the latest restore check |
| Add a second server | Set up k3s or Nomad and switch schedulers | Run the node wizard; Swarm places replicas |
| Roll back a bad deploy | Force-push an older commit, or redeploy an older image | Pick an earlier deployment and roll back to its image |

Neither column is wrong. The left one has fewer moving parts; the right one spreads the work across more people.

## How to choose

- **One developer, one VPS, happy in the terminal:** stay on Dokku.
- **Several people deploy, or you need logs in a browser:** a dashboard platform such as LogiStack or Coolify.
- **More than one server with automatic placement:** a Swarm-based platform, LogiStack or Dokploy.
- **Rails app, deploy config in the repo, no platform:** Kamal.
- **No servers at all:** Render or Heroku.

## Moving an app off Dokku

**1. Export the config.**

```bash
dokku config:export --format envfile shop > shop.env
```

**2. Dump the database.**

```bash
dokku postgres:export shop-db > shop.dump
pg_restore --no-owner --no-acl -d "$NEW_DATABASE_URL" shop.dump
```

`postgres:export` writes a custom-format dump, which `pg_restore` reads directly.

**3. Map processes.** Each line of your `Procfile` becomes a service. The `web` process gets a domain, workers get none, and a `release` step runs in your entrypoint or as a one-off job.

**4. Copy persistent storage.** Anything mounted with `dokku storage:mount` lives on the host, usually under `/var/lib/dokku/data/storage/`. Copy it into the new service's volume.

**5. Switch DNS** once the new app answers with a valid certificate, and keep the Dokku app stopped, not destroyed, for a few days.

## FAQ

### Does Dokku support multiple servers?

Yes, through its k3s or Nomad schedulers, but you then operate that scheduler too. Most Dokku installs run on one server. Swarm-based platforms such as LogiStack and Dokploy treat several servers as the normal case.

### Is there a web UI for Dokku?

Dokku Pro, a paid product from the Dokku maintainers, adds a web UI and JSON API. Free options with a dashboard include LogiStack, Coolify, CapRover and Dokploy, though they replace Dokku rather than sit on top of it.

### Is Dokku production ready?

Yes. It has been in use for over a decade and powers many production apps. Its limits are about teams and scale, not reliability.

### Dokku or Coolify?

Dokku if you want the smallest moving parts and a CLI. Coolify, or LogiStack, if you want a dashboard, more people deploying, and databases with backups managed for you.

If Dokku's workflow suits you but your team needs a dashboard, several servers and backups that prove they restore, try LogiStack. The [install guide](/docs/getting-started/install/) gets a server ready in a few minutes, and nothing sits behind a paid plan.

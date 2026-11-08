---
title: "What is Docker Compose? A practical guide with examples"
description: "What is Docker Compose and how does it work? Learn the compose file, core commands, networking, volumes and profiles, with a real multi-service example."
date: 2026-11-08
category: Docker
keywords: what is docker compose, docker compose, docker-compose.yml, compose file, docker compose commands
---

Your app needs a web process, a Postgres database, a Redis cache and a background worker. Starting them with four `docker run` commands means remembering a dozen flags, creating a network by hand and starting things in the right order. **Docker Compose** replaces that with one YAML file and one command. If you have asked "what is Docker Compose and do I need it", this guide answers it with a working example, the commands you will use daily, and the places where Compose stops being enough.

## What is Docker Compose?

Docker Compose is a tool that runs multi-container applications from a declarative file. You describe the services, networks and volumes your app needs in `compose.yaml` (or the older name `docker-compose.yml`), and `docker compose up` creates all of them.

Three facts help place it:

- **It is part of Docker.** Compose v2 ships as a plugin of the Docker CLI, so the command is `docker compose` with a space. The old Python tool `docker-compose` (with a hyphen) is deprecated.
- **The format is an open spec.** The Compose Specification is maintained in the open, and other tools, such as Podman Compose, read the same files.
- **It is declarative.** You describe the end state. Running `up` again only changes what differs from that state.

## Why use Docker Compose?

- **One command for the whole stack.** New team members run `docker compose up` instead of following a setup document.
- **Service discovery for free.** Services reach each other by name, such as `db:5432`.
- **Reproducible environments.** The file lives in Git, so everyone runs the same versions.
- **Fast feedback.** Rebuild and restart one service without touching the others.

## Anatomy of a compose file

Here is a complete file for a Node.js API with Postgres, Redis and a worker:

```yaml
name: shop

services:
  api:
    build: .
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgres://shop:${DB_PASSWORD}@db:5432/shop
      REDIS_URL: redis://cache:6379
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped

  worker:
    build: .
    command: ["node", "dist/worker.js"]
    environment:
      DATABASE_URL: postgres://shop:${DB_PASSWORD}@db:5432/shop
      REDIS_URL: redis://cache:6379
    depends_on: [db, cache]
    restart: unless-stopped

  db:
    image: postgres:16.4
    environment:
      POSTGRES_USER: shop
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: shop
    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U shop"]
      interval: 5s
      retries: 10

  cache:
    image: redis:7.4-alpine
    volumes:
      - cache-data:/data

volumes:
  db-data: {}
  cache-data: {}
```

And a `.env` file next to it, which Compose reads automatically for variable substitution:

```bash
DB_PASSWORD=use-a-long-random-value
```

### The top-level keys

| Key | What it holds |
|---|---|
| `name` | The project name. It prefixes containers, networks and volumes. Defaults to the folder name. |
| `services` | Each container definition. The only required key. |
| `volumes` | Named volumes that services mount. |
| `networks` | Extra networks. Without it, Compose creates one default network. |
| `configs`, `secrets` | Files mounted into services, kept out of the image. |

### The service keys you use most

- `image` or `build`: a published image to pull, or a Dockerfile to build. See [Dockerfile vs Docker Compose](/blog/dockerfile-vs-docker-compose/) for how the two divide the work.
- `ports`: `"HOST:CONTAINER"` mappings to reach a service from outside.
- `environment`: variables, with `${VAR}` substitution from the shell or `.env`.
- `volumes`: named volumes or bind mounts.
- `depends_on`: start order, optionally waiting for a health check.
- `healthcheck`: a command that reports whether the service works.
- `restart`: what Docker does when the container exits.
- `command`, `entrypoint`, `user`: overrides for the image defaults.

## The commands you will use daily

```bash
docker compose up -d            # create and start everything in the background
docker compose up -d --build    # rebuild images that use build: first
docker compose ps               # list the project's containers and their state
docker compose logs -f api      # follow one service's logs
docker compose exec db psql -U shop shop   # open a shell or client inside a service
docker compose restart worker   # restart one service
docker compose pull             # pull newer versions of image: services
docker compose down             # stop and remove containers and the network
docker compose down -v          # also remove named volumes (deletes data)
docker compose config           # print the file after variable substitution
```

`docker compose config` is the most underrated one. It shows exactly what Compose will run, with every variable resolved, and fails loudly on a typo.

## How networking works in Compose

Compose creates a network called `<project>_default` and attaches every service to it. Each service name becomes a DNS name on that network. That is why `api` connects to `db:5432` and not to `localhost:5432`: inside a container, `localhost` is the container itself.

Only services with `ports:` are reachable from the host. In the example, the database has no `ports:` entry, so nothing outside the Docker network can connect to it, which is what you want. For bridge networks, overlays and how ports interact with your firewall, read the guide to [Docker networking](/blog/docker-networking/).

## How data works in Compose

Containers are disposable, so anything that must survive goes on a volume. Named volumes declared under the top-level `volumes:` key outlive `docker compose down`. They disappear only with `down -v` or `docker volume rm`. Bind mounts like `./src:/app/src` map a host folder into the container and suit development, where you want code changes to appear without a rebuild. More on the trade-offs in [Docker volumes](/blog/docker-volumes/).

## Profiles, overrides and includes

Three features keep one compose setup useful across machines.

**Profiles** turn optional services on only when asked:

```yaml
services:
  mailpit:
    image: axllent/mailpit:v1.21
    profiles: ["dev"]
```

```bash
docker compose --profile dev up -d
```

**Override files** layer changes on top of the base file. Compose reads `compose.override.yaml` automatically, so you can keep dev-only bind mounts there. Pass files explicitly for other setups:

```bash
docker compose -f compose.yaml -f compose.prod.yaml up -d
```

**Includes** pull in another compose file, useful when a team owns a shared service definition:

```yaml
include:
  - ../shared/observability.yaml
```

## What Docker Compose does not do

Compose is a single-host tool. It is good at starting containers on one machine, and it leaves several jobs to you:

- **TLS and domains.** You need a reverse proxy such as Caddy, Traefik or Nginx in front.
- **Zero-downtime updates.** `up -d` replaces a container by stopping the old one and starting the new one. There is a gap.
- **Several servers.** Compose has no scheduler across nodes. Docker Swarm can deploy a compose-format file with `docker stack deploy`, and Kubernetes needs a translation step.
- **Backups, alerts and log retention.** Not part of Compose at all.
- **Rollbacks.** Only as good as your image tags. With `:latest`, there is nothing to roll back to.

None of this makes Compose a bad production choice for small apps. It means you add the missing pieces deliberately. Our guide to [deploying Docker Compose in production](/blog/deploy-docker-compose-in-production/) walks through each one.

## Docker Compose and a PaaS

A self-hosted PaaS can take a compose file and fill those gaps. LogiStack, the open-source platform we build on Docker Swarm, deploys a compose file as a [stack](/docs/deploy/compose-stacks/): you paste it, or point it at a file in a repository and it redeploys when the file changes. Each compose service becomes a LogiStack service with its own logs, metrics and domain. Official `postgres`, `mysql`, `mariadb` and `mongo` images with a pinned tag become managed databases with backups and a built-in editor.

![The Compose tab of a stack in LogiStack, showing the compose file and an Edit button](/docs/screens/stack-compose.webp)

There are honest limits. LogiStack refuses some compose keys that Swarm cannot run or that would bypass its volume management, such as host path bind mounts, `privileged: true`, `network_mode` and `env_file`. The docs list every one, and the error names every problem in your file at once. The [templates catalog](/templates/) is also built on compose stacks, so you can see real examples there.

## FAQ

### Is Docker Compose free?

Yes. Docker Compose is open source under the Apache 2.0 license. Docker Desktop, which bundles it on macOS and Windows, has its own license terms for larger companies, but Compose on a Linux server with Docker Engine has no fee.

### What is the difference between docker-compose and docker compose?

`docker-compose` is the original Python tool, now deprecated. `docker compose` is Compose v2, written in Go and shipped as a Docker CLI plugin. Use the v2 command. It reads the same files.

### Do I still need the version key?

No. The top-level `version:` key is obsolete under the Compose Specification. Compose v2 ignores it and prints a warning. Remove it from new files.

### Can I use Docker Compose in production?

Yes, for apps that fit on one server and can accept a brief restart during updates. Add a reverse proxy with TLS, pin image versions, back up your volumes and ship logs somewhere. For several servers or zero-downtime rollouts, use an orchestrator or a platform built on one.

### Is Docker Compose the same as Docker Swarm?

No. Compose runs containers on one host. Swarm is Docker's built-in orchestrator for a cluster of hosts. Swarm can deploy files in the compose format as stacks, so the skills carry over. Read more in our [Docker Swarm](/blog/docker-swarm/) guide.

If your app already runs with `docker compose up` on your laptop, you are close to running it on a server with HTTPS, backups and logs. [Install LogiStack](/#install), paste your compose file, and review what it creates before the first deploy.

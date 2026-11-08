---
title: "Dockerfile vs Docker Compose: which one do you need?"
description: "Dockerfile vs Docker Compose compared: what each file does, how they work together, and when you need one, the other, or both in development and production."
date: 2026-11-08
category: Docker
keywords: dockerfile vs docker compose, dockerfile, docker compose, docker-compose.yml, compose build
---

You open a repository and find a `Dockerfile`, a `docker-compose.yml`, or both, and it is not obvious which one runs the app. The **Dockerfile vs Docker Compose** question looks like a choice between two tools, but it is not. They answer different questions. A Dockerfile says how to build one image. A compose file says how to run one or more containers together. Most real projects use both.

This guide shows what each file owns, where they overlap, and how to decide what to write first.

## The short answer

| Question | Answered by |
|---|---|
| What goes inside my app's image? | Dockerfile |
| Which base image, which dependencies, which build steps? | Dockerfile |
| Which containers run, and how do they connect? | Compose file |
| Which ports, volumes, env vars and restart rules? | Compose file (or `docker run` flags) |
| How do I start the app, its database and its cache with one command? | Compose file |

If your project is a single service with no dependencies, a Dockerfile alone is enough. Once you add a database, a worker or a cache, you want a compose file too.

## What a Dockerfile does

A Dockerfile is a build recipe. `docker build` reads it top to bottom and produces an image: a read-only set of layers plus a default command. If the difference between image and running container is new to you, read [Docker image vs container](/blog/docker-image-vs-container/) first.

A typical Python API:

```dockerfile
FROM python:3.12-slim AS base
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN useradd --uid 10001 app && chown -R app /app
USER app

EXPOSE 8000
CMD ["gunicorn", "-b", "0.0.0.0:8000", "app:server"]
```

What it controls:

- The base image and OS packages.
- Dependency installation and its caching (copy the lock file before the source).
- The user the process runs as.
- The default command and the port the app listens on.

What it does not control: which host port maps to 8000, where the database is, which volume keeps uploads, or how many copies run. Those are runtime concerns.

## What a Docker Compose file does

A compose file describes an application made of services. `docker compose up` reads it, builds or pulls the images, creates a network, creates volumes and starts the containers in dependency order. For a full introduction, see [what is Docker Compose](/blog/what-is-docker-compose/).

The same API with its database and cache:

```yaml
services:
  api:
    build: .
    ports:
      - "8000:8000"
    environment:
      DATABASE_URL: postgres://app:app@db:5432/app
      REDIS_URL: redis://cache:6379/0
    depends_on:
      db:
        condition: service_healthy
      cache:
        condition: service_started

  db:
    image: postgres:16.4
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app
    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app"]
      interval: 5s
      retries: 10

  cache:
    image: redis:7.4-alpine

volumes:
  db-data: {}
```

What it controls:

- Which services exist and which image each one runs.
- Networking: every service reaches the others by name (`db`, `cache`) on a shared network.
- Ports published to the host.
- Volumes, environment variables, health checks and start order.

Notice `build: .` on the `api` service. That line hands the image build back to the Dockerfile. Compose does not replace the Dockerfile, it calls it.

## Dockerfile vs Docker Compose, side by side

| | Dockerfile | Docker Compose |
|---|---|---|
| Purpose | Build one image | Run several containers as one app |
| Format | Instruction file (`FROM`, `RUN`, `COPY`) | YAML (Compose Specification) |
| Command | `docker build` | `docker compose up` |
| Output | An image | Running containers, a network, volumes |
| Scope | One service | A whole application |
| Build time or run time | Build time | Run time (and triggers builds) |
| Networking | None, only `EXPOSE` as documentation | Creates a network with DNS by service name |
| Data | Nothing persistent | Declares named volumes |
| Lives next to | The service's source code | The repository root or a deploy folder |

## When you need only a Dockerfile

- You ship a single stateless service and the platform you deploy to handles ports, domains and env vars.
- You publish an image for others to run, such as a CLI tool or a library's demo server.
- Your production platform does not read compose files, and you configure runtime settings there instead.

Many PaaS products, LogiStack included, take a repository with a Dockerfile and handle the runtime part themselves: domain, HTTPS, variables, health checks and rolling updates. See [build types](/docs/deploy/build-types/) for how LogiStack builds a Dockerfile with BuildKit, including multi-stage targets.

## When you need only a compose file

- Every service uses a prebuilt image: Postgres, Redis, Grafana, an open-source app you self-host.
- You run third-party software and never build anything yourself.

Most self-hosted apps (analytics, wikis, password managers) ship exactly this: a compose file that pulls published images. No Dockerfile of yours is involved.

## When you need both

This is the normal case for your own product:

- The Dockerfile builds your app's image.
- The compose file runs that image next to the database, cache, worker and anything else it needs.

A common pattern is one Dockerfile used by two compose services, for example the web process and a background worker with a different command:

```yaml
services:
  web:
    build: .
    command: ["gunicorn", "-b", "0.0.0.0:8000", "app:server"]
  worker:
    build: .
    command: ["python", "-m", "app.worker"]
```

Both services get the same image, and only the command differs.

## Where the two files overlap

Some settings exist in both places. The rule: the compose file wins at run time.

| Setting | In the Dockerfile | In compose |
|---|---|---|
| Command | `CMD`, `ENTRYPOINT` | `command`, `entrypoint` |
| Environment | `ENV` | `environment` |
| Health check | `HEALTHCHECK` | `healthcheck` |
| User | `USER` | `user` |
| Ports | `EXPOSE` (documentation only) | `ports`, `expose` |

Put defaults that belong to the image in the Dockerfile, so the image runs sensibly anywhere. Put deployment-specific values (real hostnames, credentials, port mappings) in compose or your platform's settings. Never bake secrets into the Dockerfile with `ENV`: they end up in the image config, readable by anyone who can pull the image.

## Build arguments and build secrets

Compose can pass build arguments into the Dockerfile:

```yaml
services:
  api:
    build:
      context: .
      dockerfile: Dockerfile
      target: runtime
      args:
        APP_VERSION: "1.4.2"
```

For private package tokens, use a BuildKit secret mount instead of an argument, because arguments are recorded in the image history:

```dockerfile
RUN --mount=type=secret,id=npm_token \
    NPM_TOKEN="$(cat /run/secrets/npm_token)" npm ci
```

## A quick decision path

1. Is there code of yours to package? Write a Dockerfile and check that `docker run` starts the app.
2. Does the app need a database, cache or worker? Add a compose file that builds your image and pulls the rest.
3. Does production run on a platform that reads Dockerfiles but sets runtime options itself? Keep the compose file for local development only.
4. Is everything third-party? Skip the Dockerfile and write only the compose file.

## Development versus production

In development, compose is the standard way to run the whole stack on a laptop: one command, hot reload through a bind mount, a throwaway database.

In production, the picture changes. A compose file on one server works, but you still need TLS, a reverse proxy, backups, logs, rolling updates and a way to roll back. You can assemble those yourself, or use a platform that reads your compose file and adds them. We cover the do-it-yourself route in [deploying Docker Compose in production](/blog/deploy-docker-compose-in-production/).

LogiStack accepts both shapes. A Git service with a Dockerfile builds on every push. A [compose stack](/docs/deploy/compose-stacks/) can be pasted or read from a repository; each compose service becomes a service you can scale, give a domain and inspect on its own. A `build:` key works when the stack comes from a repository, since the build needs the source. The docs list the compose keys it refuses, such as host path bind mounts and `privileged: true`, so check that list before you migrate.

## FAQ

### Can Docker Compose work without a Dockerfile?

Yes. If every service uses `image:` instead of `build:`, compose only pulls published images. That is how most self-hosted open-source apps are distributed.

### Can a compose file replace a Dockerfile?

No. Compose has no instructions to install packages or copy source code into an image. It can only point at an existing image or at a Dockerfile to build.

### Should I put the database in my Dockerfile?

No. One image should run one process. Run the database as its own compose service from an official image, with its data on a named volume.

### Is docker-compose.yml the same as compose.yaml?

Both names work. `compose.yaml` is the preferred name in the Compose Specification, and Docker Compose still finds `docker-compose.yml`. The top-level `version:` key is obsolete and ignored by Compose v2.

### Which file should I write first?

Write the Dockerfile first and make the image run on its own with `docker run`. Then add a compose file when you need a second service. Debugging is easier one layer at a time.

If you already have a Dockerfile or a compose file, you have most of what LogiStack needs. [Install it](/#install) on a server, point it at your repository, and it handles the domain, HTTPS and rollbacks around the files you already wrote.

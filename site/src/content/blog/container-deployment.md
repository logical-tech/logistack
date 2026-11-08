---
title: "Container deployment: from Dockerfile to production"
description: "A practical guide to container deployment: building images, registries, choosing a runtime platform, networking, data, secrets and safe rollouts."
date: 2026-11-08
category: Docker
keywords: container deployment, deploy docker container, container deployment platform, docker in production, deploy containers
---

`docker run` works on your laptop in ten seconds. Getting the same container to run in production, behind HTTPS, restarted when it crashes, updated without dropping requests and backed up every night, takes a lot more than ten seconds. Container deployment is everything between "the image builds" and "users depend on it". This guide walks through each step in order, the platform choices at each one, and the mistakes that cost teams the most time.

## What container deployment covers

Deploying a container means taking an image and running it somewhere reliable, with everything around it that production needs. The pipeline has six stages:

1. **Build** an image from your source.
2. **Store** it in a registry.
3. **Schedule** it onto a server.
4. **Connect** it: networking, domains, TLS.
5. **Configure** it: environment variables, secrets, volumes.
6. **Operate** it: health checks, rollouts, logs, metrics, backups.

Each stage has a simple version and a production version. The gap between them is where most of the work lives.

## Step 1: build a production image

A good production image is small, reproducible and runs as a non-root user. Multi-stage builds get you most of the way:

```dockerfile
# Build stage
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Runtime stage
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

What matters here:

- **Pin the base image** to a version, not `latest`.
- **Copy the lockfile first** so dependency layers stay cached when only source changes.
- **Drop build tools** from the final stage.
- **Run as a non-root user.**
- **Use the exec form of `CMD`** so the process receives `SIGTERM` and can shut down cleanly.

If you don't want to write a Dockerfile, buildpack-style tools such as Railpack detect the language and produce an image from the source alone.

## Step 2: tag and store the image

Push the image to a registry so servers can pull it. Two rules prevent most deployment confusion:

- **Tag every build uniquely.** Use the commit SHA or a build ID. A tag should point to exactly one image, forever.
- **Never deploy `:latest`.** You can't tell what's running, and you can't roll back to a tag that has moved.

```bash
docker build -t ghcr.io/acme/api:8f3c2a1 .
docker push ghcr.io/acme/api:8f3c2a1
```

Registry options range from hosted (Docker Hub, GitHub Container Registry, GitLab) to self-hosted (a registry on your own server). Self-hosting avoids pull limits and keeps images on your network, but you then own its storage and garbage collection.

## Step 3: choose where containers run

This is the biggest decision in container deployment. The options trade control for operational work.

| Option | You manage | Scales across servers | Good fit |
|---|---|---|---|
| `docker run` or Compose on one VPS | Everything | No | Side projects, internal tools |
| Docker Swarm | Servers, Swarm, proxy | Yes | Small teams wanting clustering without Kubernetes |
| Kubernetes (self-managed or managed) | Cluster, add-ons, manifests | Yes | Large teams, complex workloads, platform engineers on staff |
| Hosted container platforms (Fly.io, Render, Railway, Cloud Run) | Your app only | Yes | Teams that want no servers |
| Self-hosted PaaS on your servers | Servers | Depends on the PaaS | Teams wanting a hosted feel at server prices |

A few honest notes:

- **Compose on one server** is fine for a lot longer than people admit. It's when you need a second server, or zero-downtime updates, that it starts to hurt. See [deploying Docker Compose in production](/blog/deploy-docker-compose-in-production/).
- **Kubernetes** is the industry standard and has the largest ecosystem. It also has the steepest learning curve. If you have the people, it's often the right call. See [Docker Swarm vs Kubernetes](/blog/docker-swarm-vs-kubernetes/).
- **Hosted platforms** remove the server work entirely. You pay for that in price per resource and in less control over where data lives.

## Step 4: networking, domains and TLS

A container listening on port 3000 isn't reachable by users. Between them you need:

- **A reverse proxy** on ports 80 and 443 that routes hostnames to containers.
- **TLS certificates**, ideally issued and renewed automatically through Let's Encrypt.
- **DNS records** pointing your domain at the server.
- **Internal networks** so the app reaches its database by name, while the database stays off the public internet.

Caddy, Traefik and Nginx are the usual proxies. Caddy and Traefik handle certificates on their own; Nginx needs a companion such as Certbot.

Keep databases on an internal network only. A Postgres port published to the internet is one of the most common ways self-hosted setups get breached.

## Step 5: configuration, secrets and data

### Environment variables

The [twelve-factor](https://12factor.net/config) approach still holds: configuration goes in the environment, not in the image. The same image should run in staging and production with different variables.

### Secrets

Don't bake secrets into images or pass them as command-line arguments, where they show up in `ps` and in build logs. Inject them at runtime from an encrypted store, or from a secret manager such as Vault.

### Persistent data

Containers are disposable; data isn't. Anything that must survive a restart goes in a volume, a database or object storage. Volumes are local to one server in most setups, which pins the container to that server and complicates scaling.

## Step 6: rollouts and operations

Once the container runs, it has to keep running and change safely.

- **Health checks** tell the platform when a container is ready and when it has died.
- **Restart policies** bring crashed containers back.
- **Rolling updates** start the new version before stopping the old one. See [zero-downtime deployments](/blog/zero-downtime-deployments/).
- **Resource limits** on CPU and memory stop one container from starving the rest.
- **Logs and metrics** must be readable without SSH.
- **Backups** of volumes and databases, with restores you have actually tested.

## Common container deployment mistakes

- **Deploying `:latest`.** You lose the ability to tell what runs and to roll back.
- **No health check.** The proxy sends traffic to a container that is still booting.
- **Secrets in the image.** Anyone who can pull the image can read them.
- **Publishing the database port.** Exposes your data to the internet.
- **No resource limits.** One memory leak takes down every container on the server.
- **Untested backups.** A backup you have never restored is a hope, not a backup.

## Container deployment with LogiStack

LogiStack is an open-source, self-hosted PaaS that runs these six stages for you on Docker Swarm, with Caddy as the proxy. You bring Linux servers; it handles the rest.

| Stage | What LogiStack does |
|---|---|
| Build | Builds from your Dockerfile, with Railpack and no config, or as a static site, in rootless BuildKit. amd64, arm64 or both. |
| Store | Pushes to a built-in registry on your server, or GHCR, Docker Hub, GitLab or any registry with a login. Git builds are tagged with the deployment ID, never `:latest`. |
| Schedule | Runs each service on Docker Swarm, across one server or many. Placement constraints and node labels decide where. |
| Connect | Caddy serves every domain with automatic HTTPS. Each environment gets its own private network; databases never join the ingress network. |
| Configure | Variables at organization, project, environment or service level, encrypted at rest. Secrets stay write-only, or come from Vault, Infisical or 1Password. |
| Operate | Start-first rolling updates with health checks and automatic rollback, live logs, a browser terminal, metrics, alerts and scheduled, encrypted backups. |

You can deploy from Git (see [Deploy an app from Git](/docs/deploy/from-git/)), run a published image (see [Deploy a Docker image](/docs/deploy/from-image/)), paste a `docker-compose.yml` as a stack, or start from one of the [templates](/templates/).

![The New service wizard with the source options](/docs/screens/service-new.webp)

### Trade-offs to know

LogiStack runs on Docker Swarm, not Kubernetes. That keeps the operational load low, but you don't get the Kubernetes ecosystem of operators, Helm charts and service meshes. It is also a young project with a smaller community than Kubernetes or the long-standing PaaS tools. If you already run Kubernetes well, stay there. If you want hosted-platform convenience on your own servers without a platform team, LogiStack is built for that.

## FAQ

### What is container deployment?

Running a container image in production with everything it needs around it: a registry, a server or cluster to run on, networking and TLS, configuration and secrets, and safe updates, monitoring and backups.

### Do I need Kubernetes to deploy containers?

No. A single server with Docker Compose works for small apps, and Docker Swarm or a PaaS built on it covers multi-server setups. Kubernetes fits best when you have the team to run it and workloads that need its ecosystem.

### How do I update a running container without downtime?

Use rolling updates with health checks: start the new container, wait until it reports healthy, send it traffic, then stop the old one. The old container should handle `SIGTERM` and finish its in-flight requests.

### Where should a container store data?

In a volume, a database or object storage, never in the container's own filesystem, which disappears when the container is replaced. Back up volumes and databases on a schedule.

### What's the difference between deploying a container and deploying Compose?

A container is one process. A Compose file describes several containers and how they connect. Many platforms, LogiStack included, deploy a Compose file as a stack of services.

Container deployment is six stages, and each one has a simple version that fails in production. LogiStack gives you the production version of all six on servers you own, free and open source. [Install it](/#install) on one Linux server and deploy your first container in minutes, or read the [features](/features/) first.

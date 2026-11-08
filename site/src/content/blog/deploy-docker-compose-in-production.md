---
title: "How to deploy Docker Compose in production (2026 guide)"
description: "Deploy Docker Compose in production on a VPS: pinned images, a reverse proxy with HTTPS, secrets, health checks, backups, logs and updates, step by step."
date: 2026-11-08
category: Deployment
keywords: deploy docker compose in production, docker compose production, docker compose vps, docker compose https, docker compose deployment
---

Your compose file works on your laptop. Now it has to run on a server where real users hit it, where a reboot at 3 a.m. must not take it down, and where losing the database volume is not an option. Moving from `docker compose up` on a laptop to **Docker Compose in production** is mostly about the things Compose does not do for you: TLS, secrets, restarts, backups, logs and updates. This guide walks through each one on a single Linux server, then shows where a platform saves you the wiring.

If you are new to the file format, start with [what is Docker Compose](/blog/what-is-docker-compose/).

## Is Docker Compose good enough for production?

For a lot of apps, yes. A single well-sized server running Compose serves many internal tools, SaaS products in their first years, and self-hosted software. It is simple to reason about and easy to debug.

It stops being enough when you need:

- More than one server, for capacity or for surviving a machine failure.
- Updates without a gap, because Compose stops the old container before the new one is ready.
- A team that deploys several times a day and needs history, rollbacks and access control.

Decide up front which side you are on. The steps below get a single-server setup right. The last sections cover what changes beyond it.

## Step 1: prepare the server

Use a supported Linux distribution (Ubuntu LTS or Debian stable), install Docker Engine from Docker's own repository, and lock down SSH.

```bash
curl -fsSL https://get.docker.com -o get-docker.sh
less get-docker.sh          # read it before you run it
sudo sh get-docker.sh
docker compose version      # confirm the Compose v2 plugin is present
```

Then the basics:

- Create a non-root user for deployments and disable password login over SSH.
- Open only ports 22, 80 and 443 in the provider's firewall.
- Know that ports you publish with Docker bypass UFW rules on the host, because Docker writes its own iptables rules. Publish only what must be public, and bind internal ports to `127.0.0.1`.

## Step 2: make the compose file production-ready

Start from your development file and change five things.

**Pin every image.** Never deploy `:latest`. Two pulls a week apart can give you different software.

**Drop development bind mounts.** Code goes into the image, not into a mounted folder.

**Add health checks and restart policies.** Docker restarts crashed containers, and `depends_on` can wait for health.

**Keep internal services off the host network.** Only the proxy publishes ports.

**Set resource limits.** One leaking process should not starve the database.

```yaml
name: shop

services:
  proxy:
    image: caddy:2.9
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
    restart: unless-stopped

  app:
    image: ghcr.io/acme/shop:1.8.3
    environment:
      DATABASE_URL: postgres://shop:${DB_PASSWORD}@db:5432/shop
    depends_on:
      db:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/healthz"]
      interval: 10s
      timeout: 3s
      retries: 5
    deploy:
      resources:
        limits:
          memory: 512M
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
    restart: unless-stopped

volumes:
  caddy-data: {}
  db-data: {}
```

The app image is built in CI and pushed to a registry with a version tag. The server only pulls. Building on the production server works, but it eats memory during the build and makes deploys depend on the server's state.

## Step 3: put a reverse proxy with HTTPS in front

The `proxy` service above runs Caddy, which obtains and renews Let's Encrypt certificates on its own. The whole config:

```caddyfile
shop.example.com {
	encode zstd gzip
	reverse_proxy app:3000
}
```

Point an `A` record for `shop.example.com` at the server before you start, or the certificate request fails. If you test repeatedly, use Let's Encrypt's staging environment, because failed attempts count against rate limits. Our post on [Let's Encrypt rate limits](/blog/lets-encrypt-rate-limits/) covers the numbers.

## Step 4: handle secrets properly

The `.env` file approach is acceptable on a single server if you treat the file as a secret:

```bash
umask 077
openssl rand -base64 32 | sed 's/^/DB_PASSWORD=/' > .env
```

Keep `.env` out of Git, readable only by the deploy user, and out of your backups in plain text. For stricter setups, Compose supports file-based `secrets:` that mount at `/run/secrets/<name>` instead of living in environment variables, where any process listing can read them. Many official images, Postgres included, accept a `_FILE` variant such as `POSTGRES_PASSWORD_FILE`.

## Step 5: deploy and update

The first deploy:

```bash
docker compose pull
docker compose up -d
docker compose ps
```

An update after CI pushes `1.8.4`:

```bash
sed -i 's/shop:1.8.3/shop:1.8.4/' compose.yaml
docker compose pull app
docker compose up -d app
```

Compose stops the old `app` container and starts the new one, so expect a few seconds of errors. A rollback is the same command with the old tag, which is why pinned tags matter. Keep the compose file in Git so every change has a commit.

Run migrations as a one-off before switching:

```bash
docker compose run --rm app npm run migrate
```

## Step 6: back up the volumes

A volume is not a backup. Dump the database on a schedule and ship the file off the server:

```bash
docker compose exec -T db pg_dump -U shop -Fc shop > /backups/shop-$(date +%F).dump
```

Run it from cron or a systemd timer, encrypt it, copy it to S3-compatible storage, and delete old dumps. Then test a restore into a scratch container regularly. The detailed approach is in our [database backup](/blog/database-backup/) guide.

## Step 7: logs and monitoring

Docker's default `json-file` log driver keeps logs forever unless you cap it. Set a limit for every service:

```yaml
x-logging: &logging
  driver: json-file
  options:
    max-size: "10m"
    max-file: "5"

services:
  app:
    logging: *logging
```

Add an uptime check from outside the server, and watch disk usage: full disks cause more outages on small servers than CPU. Alert before a disk passes 80 percent.

## The production checklist

| Area | Do | Avoid |
|---|---|---|
| Images | Version tags or digests, built in CI | `:latest`, building on the server |
| Ports | Publish 80 and 443 only | Publishing database ports |
| TLS | Caddy or Traefik with automatic certificates | Hand-copied certificates |
| Secrets | `.env` with `0600`, or Compose `secrets:` | Secrets in Git or in the image |
| Health | `healthcheck` plus `restart: unless-stopped` | Relying on "it started" |
| Data | Named volumes, scheduled dumps off-server | Trusting the volume alone |
| Logs | Size limits, central shipping | Unbounded `json-file` logs |
| Updates | Pull, `up -d`, keep old tag for rollback | Editing containers by hand |

## Where single-server Compose runs out

Three limits appear as an app grows.

1. **Downtime on update.** Compose cannot start the new container before stopping the old one for the same service name and port. Workarounds exist (blue-green with two services behind the proxy), but you maintain them.
2. **One machine.** Compose does not schedule across servers. Docker Swarm runs compose-format stacks across nodes with rolling updates; Kubernetes needs a translation. Our [Docker Swarm vs Kubernetes](/blog/docker-swarm-vs-kubernetes/) comparison helps choose.
3. **Operations glue.** Backups, alerts, log search, access control and an audit trail are all separate tools you wire together.

## Running your compose file on a PaaS instead

A self-hosted PaaS keeps your compose file and adds the missing operations. LogiStack, the open-source platform we build, deploys a compose file as a [stack](/docs/deploy/compose-stacks/) on Docker Swarm with Caddy in front. Each compose service becomes a service with its own domain and automatic HTTPS, logs, metrics and terminal. Deployments are rolling: the new container starts and passes its health check before the old one stops. Official database images with a pinned tag become managed databases with [scheduled, encrypted backups](/docs/data/backups/) to any S3 destination and scheduled restore checks.

![A compose stack in LogiStack with its containers, status, CPU and memory](/docs/screens/stack.webp)

The trade-offs are worth stating. LogiStack is a young project with a smaller community than Docker itself. It runs on Swarm, not Kubernetes. And it does not accept every compose key: host path bind mounts, `privileged`, `network_mode` and `env_file` are refused, and domains are added per service in the dashboard instead of being read from the file. If your file depends on those, plain Compose or another platform may fit better.

## FAQ

### Should I build images on the production server?

It works for small projects, but building in CI is better. Builds need much more memory than running apps, they make each deploy depend on the server's state, and a registry gives you an image to roll back to.

### How do I get zero-downtime deploys with Docker Compose?

Plain Compose cannot do it for a single service. You can run two copies (blue and green) behind the proxy and switch between them, or move to Docker Swarm, whose rolling updates start the new task before stopping the old one. See [zero-downtime deployments](/blog/zero-downtime-deployments/).

### Do I need Kubernetes instead?

Probably not for a single app on one or a few servers. Kubernetes pays off with many teams and services. Swarm or a PaaS on top of it covers most smaller setups with far less to operate.

### How do I keep containers running after a reboot?

Set `restart: unless-stopped` or `restart: always` on each service and make sure the Docker service is enabled at boot with `systemctl enable docker`. Containers with those policies start again when the daemon starts.

If you would rather keep your compose file and skip the proxy, backup and log wiring, [install LogiStack](/#install) on your server and paste the file in. It shows what it will create before anything runs.

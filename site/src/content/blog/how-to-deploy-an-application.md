---
title: "How to deploy an application: a step-by-step guide"
description: "How to deploy an application to production: prepare the app, containerize it, pick a target, add a database, domain and HTTPS, and ship on every push."
date: 2026-11-08
category: Deployment
keywords: how to deploy an application, deploy a web app, deploy app to server, deploy node app, deploy docker app
---

You have a working app and a deadline. You need it on a real domain with HTTPS, connected to a real database, and you want the next version to ship without an evening of SSH. This guide shows how to deploy an application end to end, with a small Node.js API as the example. The same steps apply to Python, Go, Ruby, PHP or anything that runs in a container.

We go from a local project to a production deployment that rebuilds on every push and rolls back in one click.

## How to deploy an application: what you will have at the end

By the end you will have:

- The app built into a container image with a unique tag.
- The image running on a server, restarted if it crashes.
- A Postgres database on a private network, not exposed to the internet.
- A domain with a valid HTTPS certificate.
- Automatic deploys on push, with a migration step and health checks.

If you want the theory behind these steps first, read [what is application deployment](/blog/what-is-application-deployment/).

## Step 1: Make the app ready for production

Most deploy problems start in the code. Four habits remove most of them.

**Read configuration from the environment.** Ports, database URLs and API keys come from environment variables, never from files committed to the repository.

**Listen on all interfaces.** Inside a container, `localhost` is the container itself. Bind to `0.0.0.0`.

**Expose a health endpoint.** The platform uses it to decide when a new version is ready for traffic.

**Log to stdout.** The platform collects stdout and stderr. Log files inside the container disappear with it.

A minimal Express API that follows all four:

```javascript
// server.js
import express from "express";
import pg from "pg";

const app = express();
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

app.get("/healthz", async (_req, res) => {
  try {
    await db.query("select 1");
    res.send("ok");
  } catch {
    res.status(503).send("database unreachable");
  }
});

app.get("/api/orders", async (_req, res) => {
  const { rows } = await db.query("select id, total from orders order by id desc limit 20");
  res.json(rows);
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, "0.0.0.0", () => console.log(`listening on ${port}`));
```

## Step 2: Containerize it

A container image packages the app with its runtime, so the server runs exactly what you tested. A multi-stage Dockerfile keeps the final image small:

```dockerfile
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
USER node
EXPOSE 3000
CMD ["node", "server.js"]
```

Add a `.dockerignore` so local files stay out of the build:

```text
node_modules
.env
.git
```

Test it locally before you go further:

```bash
docker build -t orders-api:dev .
docker run --rm -p 3000:3000 -e DATABASE_URL=postgres://postgres:dev@host.docker.internal:5432/postgres orders-api:dev
curl http://localhost:3000/healthz
```

If you prefer not to write a Dockerfile, many platforms detect the language and build for you, with buildpacks or Railpack. A Dockerfile still gives you the most control and the easiest exit.

## Step 3: Choose where it runs

| Option | You manage | Cost shape | Good when |
| --- | --- | --- | --- |
| Managed PaaS (Render, Railway, Fly.io, Heroku) | App and config | Per app or usage | You want zero server work |
| Self-hosted PaaS on a VPS | App, config, server updates | Flat server bill | You want PaaS ergonomics, lower cost, data control |
| Plain VPS with Docker Compose and a script | Everything | Flat server bill | One small app, no team |
| Kubernetes | Everything plus the cluster | Cluster plus people | Large scale, dedicated platform team |

This guide uses a self-hosted PaaS, because it shows every step that a managed platform hides, and you keep the result. For the trade-offs, see [self-hosted PaaS](/blog/self-hosted-paas/).

## Step 4: Get a server and install the platform

Rent a VPS with Ubuntu 22.04+ or Debian 12+, at least 2 GB of RAM (4 GB gives builds headroom), and ports 80 and 443 open in the provider's firewall. Then install LogiStack, an open-source self-hosted PaaS:

```bash
ssh root@203.0.113.7
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

The installer sets up Docker and Docker Swarm, starts the platform, and keeps the dashboard private until setup is done. Open it through an SSH tunnel from your machine:

```bash
ssh -L 3000:127.0.0.1:3000 root@203.0.113.7
```

Go to `http://localhost:3000` and follow the setup wizard. Back up `/etc/logistack/credentials`: it holds the master key that encrypts your secrets. The [install docs](/docs/getting-started/install/) cover flags and cloud-init.

## Step 5: Point your domain

Create a DNS record for the app at your DNS provider:

```text
api.example.com.   A   203.0.113.7
```

If you connect Cloudflare, Route 53 or Hetzner DNS to LogiStack, it creates the record for you when you add the domain. For many apps, a wildcard such as `*.apps.example.com` saves a DNS change per app.

## Step 6: Create the database

In the project's production environment, create a Postgres service. The platform generates the password and stores it encrypted. Services in the same environment share a private network, so the app reaches the database by its service name:

```text
postgres://postgres:<POSTGRES_PASSWORD>@postgres:5432/postgres
```

The database port is never published to the internet. Set up a backup schedule now, not after the first incident: daily dumps to an S3-compatible bucket, encrypted, with a retention rule. See [database backup](/blog/database-backup/) for a sensible policy.

## Step 7: Connect the repository and create the service

1. Connect your Git provider: GitHub through a GitHub App the wizard creates, or GitLab, Gitea, Bitbucket or any Git host over SSH.
2. Create a new service from the repository and branch.
3. Set **Build with** to **Dockerfile** and **Container port** to `3000`.
4. In a monorepo, set the root directory, for example `/apps/api`, and watch paths so unrelated commits do not trigger a build.

![The new service wizard in LogiStack](/docs/screens/service-new.webp)

## Step 8: Set environment variables and secrets

On the service's Environment tab, add:

```text
PORT           3000
DATABASE_URL   postgres://postgres:...@postgres:5432/postgres   (secret)
```

Secrets are encrypted at rest and write-only in the dashboard. Variables can also live on the project or environment, and the most specific level wins. That lets staging and production share a service definition with different values.

## Step 9: Run migrations before each rollout

Schema changes must run before new code takes traffic. Set a pre-deploy command, written one argument per line because it runs without a shell:

```text
npm
run
db:migrate
```

If the migration fails, the deployment fails and the current version keeps serving. Write migrations that the previous version can still run against, because both versions run side by side during a rolling update.

## Step 10: Add the domain and deploy

Add `api.example.com` to the service on port 3000. Caddy obtains a Let's Encrypt certificate and renews it on its own. Then select **Deploy** and follow the live log: clone, build, push, release, deploy, healthy.

Check the result:

```bash
curl -i https://api.example.com/healthz
```

## Step 11: Ship on every push

The Git provider's webhook is registered for you, so every push to the branch now builds and deploys. Useful refinements:

- **Wait for CI checks** so a red build never deploys.
- **Deploy on tags** such as `v*.*.*` if you prefer explicit releases.
- **Skip a deploy** with `[skip deploy]` in the commit message.
- **Preview environments** give each pull request its own URL. See [preview environments](/blog/preview-environments/).

The full trigger options are in [deploy from Git](/docs/deploy/from-git/).

## Step 12: Verify, monitor and roll back

After each deploy, look at three things: the service logs, CPU and memory, and error rates in your app. Set an alert so a failing service or a full disk reaches you on Slack, email or another channel.

When a release is bad, open the Deployments tab and roll back to an earlier deployment. Each build has its own image tag, so the rollback runs that exact image without rebuilding. Remember that a rollback restores code, not data: if a migration changed the schema, handle that first.

## Common deployment mistakes

- **Hardcoded localhost URLs** that work in development and fail everywhere else.
- **Secrets committed to the repository** or baked into the image as build arguments.
- **No health check**, so a crashing version replaces a working one.
- **Publishing the database port** to the internet. Note that Docker publishes ports through iptables, which bypasses UFW.
- **Deploying `latest`**, which makes it impossible to know or restore what ran.
- **Backups that were never restored.**

## FAQ

### How do I deploy an application for free?

Free tiers on managed platforms come and go and often sleep idle apps. The cheapest stable setup is usually a small VPS with an open-source self-hosted PaaS, where you pay only for the server.

### Do I need Docker to deploy an app?

Not strictly. Some platforms build from source with buildpacks or Railpack. Under the hood they still produce a container image, and knowing Docker helps when a build fails.

### How long does a deployment take?

A cached build of a small app takes well under a minute; a cold build with many dependencies takes a few minutes. Rollouts add the time your app needs to pass its health check.

### How do I deploy a frontend and a backend together?

Deploy them as two services in the same environment. The frontend calls the backend's public domain, or the backend's internal name when requests come from server-side code. For a static frontend, a static-site build serves the files with Caddy.

LogiStack handles steps 4 to 12 on your own servers: Git builds, managed Postgres with backups, HTTPS, migrations and rollbacks, all in the free Apache 2.0 build. Read the [features](/features/) or [install it](/#install) and deploy your first app.

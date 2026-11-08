---
title: "How to deploy a Node.js app to production"
description: "Deploy a Node.js app to production: a lean Docker image, signals and graceful shutdown, memory limits, scaling without PM2, migrations and HTTPS on your server."
date: 2026-11-08
category: Deployment
keywords: deploy nodejs, node.js production deployment, deploy node app, nodejs docker, node.js graceful shutdown
---

Node.js apps are easy to start and surprisingly easy to run badly. The usual production problems aren't about your routes; they're about the process: requests cut off during deploys, a container killed for memory it never seemed to use, PM2 fighting the orchestrator, or `npm start` swallowing signals. This guide covers how to deploy a Node.js app to production with those details right, for Express, Fastify, Hono, NestJS or any HTTP server.

If you want the general end-to-end flow (domain, database, first deploy), read [how to deploy an application](/blog/how-to-deploy-an-application/) first; it uses a Node.js API as its example. This post goes deeper on the Node-specific parts.

## Production checklist for a Node.js app

Before the Dockerfile, make sure the app itself is ready:

| Concern | What to do |
| --- | --- |
| Port | Read `process.env.PORT`, bind `0.0.0.0` |
| Config | Every secret and URL from environment variables |
| Logs | Write to stdout as JSON lines, no log files |
| Shutdown | Handle `SIGTERM`, stop accepting, finish in-flight requests |
| Health | A cheap `/healthz` route that doesn't hit the database |
| State | No sessions or uploads on local disk or in process memory |
| Errors | Crash on `uncaughtException`, let the platform restart you |

The last line surprises people. After an uncaught exception, Node's own docs say the process is in an undefined state. Log it and exit; a restart is cheaper than a zombie process serving corrupted state.

## A lean Dockerfile for Node.js

For a TypeScript app that compiles to `dist/`:

```dockerfile title="Dockerfile"
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

The details that matter:

- **`npm ci`, then `npm prune --omit=dev`**: install everything to build, then drop dev dependencies before copying `node_modules`. TypeScript, test runners and linters stay out of the runtime image.
- **`NODE_ENV=production`**: Express and many libraries switch to faster code paths and less verbose errors.
- **`CMD ["node", ...]`**, exec form: Node runs as PID 1 and receives signals directly. `CMD npm start` and the shell form `CMD node dist/server.js` both put another process in front that may not forward `SIGTERM`.
- **`USER node`**: the official images include an unprivileged user. Running as root in a container is a needless risk.
- **Alpine**: small, and includes `wget` for health checks. If a native module misbehaves on musl, switch both stages to `node:22-slim`.

For pnpm, add `RUN corepack enable` and use `pnpm install --frozen-lockfile` and `pnpm prune --prod`. More image techniques are in [Docker build best practices](/blog/docker-build-best-practices/).

## Graceful shutdown in Node.js

During a rolling deploy, the platform starts the new container, waits until it's healthy, then sends `SIGTERM` to the old one and waits a few seconds before `SIGKILL`. Your job is to use those seconds well:

```ts title="src/server.ts"
import { createServer } from "node:http";
import { app } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const server = createServer(app);

server.listen(port, "0.0.0.0", () => {
	console.log(JSON.stringify({ msg: "listening", port }));
});

function shutdown(signal: string) {
	console.log(JSON.stringify({ msg: "shutting down", signal }));
	server.close(() => process.exit(0));
	server.closeIdleConnections();
	// Hard stop if something hangs past the platform's grace period.
	setTimeout(() => process.exit(1), 9_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
```

`server.close()` stops accepting new connections and waits for open ones. `closeIdleConnections()` (Node 18.2+) drops idle keep-alive sockets that would otherwise hold the server open. Close database pools and queue connections in the `close` callback before exiting. Keep the hard-stop timeout a little shorter than your platform's drain timeout so you exit on your own terms.

Fastify, NestJS and Hono's Node adapter have their own close hooks (`fastify.close()`, `app.enableShutdownHooks()`), which do the same thing.

## Memory limits and the V8 heap

A Node process in a container with a 512 MB limit doesn't automatically know about that limit. Recent Node versions read the cgroup limit and size the heap from it, but the heap is only part of the memory: buffers, native modules and the runtime live outside it. When total memory crosses the container limit, the kernel kills the process with no stack trace, and you see an exit code of 137.

Two habits help:

- Set the old-space size explicitly to about 75% of the container limit, leaving room for everything else:

  ```bash
  NODE_OPTIONS=--max-old-space-size=384
  ```

  With this, a leak ends in a JavaScript `heap out of memory` error with a stack trace, instead of a silent kill.
- Watch memory per replica over a day. A steady climb that resets only on deploy is a leak, not a sizing problem.

## Do you need PM2 or cluster mode?

On a bare VPS, PM2 restarts crashed processes and runs one per core with cluster mode. In containers on an orchestrator, both jobs are already done:

- **Restarts**: Docker restarts a crashed container and the orchestrator replaces unhealthy ones.
- **Using all cores**: run more replicas, each with one Node process. A replica per core gives the same parallelism as cluster mode, plus rolling deploys and per-replica health checks.

PM2 inside a container adds a second supervisor that hides crashes from the first, so the platform thinks everything is fine while PM2 restarts your app in a loop. Use one process per container and let the platform scale it.

The exception is a tiny server where you want several cores in a single container. Node's built-in `node:cluster` module does that without PM2, but more replicas are usually simpler.

## Migrations and background workers

**Migrations** (Prisma, Drizzle, Knex, TypeORM) should run once per deploy, before the new code takes traffic, not in the app's startup code. With three replicas, startup migrations run three times at once.

**Workers** for BullMQ, cron jobs or queue consumers are the same image with a different entry file. Build once, run two services:

```bash
node dist/server.js   # web
node dist/worker.js   # jobs
```

Workers need the same `SIGTERM` handling: stop pulling new jobs, finish the current one, exit.

## Deploy Node.js with LogiStack

[LogiStack](/features/) is an open-source, self-hosted PaaS on Docker Swarm with Caddy in front. It builds your repository on your own server and handles rollouts, domains and HTTPS.

**1. Install it** on a Linux server:

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

**2. Create a Git service.** Connect your Git provider and pick the repository. Set **Build with** to **Dockerfile** for the file above, or **Railpack (no Dockerfile needed)** to let LogiStack detect the app and build it without one. Set **Container port** to `3000`. See [Deploy from Git](/docs/deploy/from-git/) and [Build types](/docs/deploy/build-types/).

**3. Set variables.** Add `DATABASE_URL`, API keys (as secrets) and `NODE_OPTIONS=--max-old-space-size=384` in the **Environment** tab. LogiStack also sets `LOGISTACK_COMMIT_SHA` and `LOGISTACK_DEPLOYMENT_ID` on every container, useful as a release tag in your error tracker.

**4. Size the service.** Under **Settings** › **Resources**, set **Memory** to `512` and **CPU** to `0.5` or `1`. Keep `--max-old-space-size` at about three quarters of the memory value.

**5. Health check and drain.** Under **Settings** › **Healthcheck and drain**, choose **HTTP request**, port `3000`, path `/healthz`. Set **Drain timeout** to `10` seconds (the default) or longer than your hard-stop timer. LogiStack starts each new replica first and only sends `SIGTERM` to the old one once the new one is healthy. See [Deployments](/docs/deploy/deployments/).

**6. Migrations as a release command.** Under **Settings** › **Release commands**, set the **Pre-deploy command**, one argument per line, for example `npx`, `prisma`, `migrate`, `deploy`. If it fails, the deploy stops and the current version stays live.

**7. Workers.** Create a second Git service from the same repository with no domain and set **Command** to `node` and `dist/worker.js` on two lines.

**8. Scale.** Under **Settings** › **Scaling**, set **Fixed** copies, or **Automatic** to add and remove replicas with CPU load. See [Scale a service automatically](/docs/deploy/autoscaling/).

![The Metrics tab of a service showing CPU and memory per replica](/docs/screens/service-metrics.webp)

## Common Node.js production problems

- **Exit code 137, no error logged**: the container hit its memory limit. Set `--max-old-space-size` below the limit and look for leaks.
- **Requests fail during every deploy**: the app exits on `SIGTERM` without closing the server, or runs behind `npm start` and never sees the signal.
- **`EADDRINUSE` in logs**: two processes in one container bind the same port, often PM2 cluster mode plus a stray `node`.
- **Works locally, 502 in production**: the server binds `localhost` instead of `0.0.0.0`.
- **`Cannot find module` at runtime**: a package used at runtime is listed in `devDependencies` and was pruned.

## FAQ

### What is the best way to deploy a Node.js app?

Build it into a Docker image, run one Node process per container, and deploy with a platform that does rolling updates and health checks. That works the same for Express, Fastify, NestJS or Hono, and on any server.

### Should I use Bun or Deno instead of Node in production?

Both run many Node apps and can be faster at startup or in specific workloads. Node has the widest library compatibility and the longest production track record. If you switch, keep the same rules: one process per container, signals, health checks.

### How do I run a Node.js app on a specific port?

Read the port from `process.env.PORT` with a default, and bind `0.0.0.0`. The platform then maps the domain to that port inside the container; you never publish it on the host.

### How do I see logs from a Node.js container?

Write to stdout and stderr. Docker captures both, and your platform shows them per replica. In LogiStack, the **Logs** tab streams every replica's output with search.

A production Node.js deploy comes down to one process per container, a clean `SIGTERM` handler, an honest memory limit and migrations outside the startup path. To get rolling deploys, HTTPS and autoscaling on your own server, [install LogiStack](/#install).

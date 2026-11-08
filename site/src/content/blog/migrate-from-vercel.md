---
title: "Migrate from Vercel: move a Next.js app to your server"
description: "Migrate from Vercel step by step: export env vars, build Next.js standalone, replace Vercel-only features, set up previews and cron, and switch DNS."
date: 2026-11-08
category: Deployment
keywords: migrate from vercel, leave vercel, self-host next.js, vercel migration, next.js standalone, vercel to docker
---

The Vercel bill climbed past what a server with ten times the capacity would cost, or a function timeout or a usage limit started shaping your architecture. You want to migrate from Vercel without breaking the parts of Next.js you rely on. The good news: Next.js runs well on your own server. The catch: a few features you used on Vercel are platform services, not framework features, and they need a replacement.

This guide moves one Next.js app from Vercel to a self-hosted platform step by step. It covers what changes, what works the same, and how to cut over with a way back. For a deeper look at the Dockerfile and runtime tuning, see [deploy Next.js self-hosted](/blog/deploy-nextjs-self-hosted/). If you are still comparing hosts, [Vercel alternatives](/blog/vercel-alternatives/) lists the options.

## What changes when you leave Vercel

Vercel runs Next.js as a set of functions, static files on a CDN, and edge code in many regions. On your own server, Next.js runs as one long-running Node.js process, `next start` or the standalone `server.js`, behind a reverse proxy. Most features behave the same. Some move from "global and managed" to "one region and yours".

| Feature | On Vercel | Self-hosted |
| --- | --- | --- |
| App Router, Pages Router, SSR, streaming | Works | Works the same in the Node server |
| Static pages and SSG | Served from Vercel's CDN | Served by the Node server; add a CDN if you need global caching |
| ISR, `revalidatePath`, `revalidateTag` | Managed, shared cache | Works; cache lives on each instance's disk unless you add a shared cache handler |
| `next/image` optimization | Managed, billed per image | Works with `sharp`; cache is per instance |
| Middleware | Runs at the edge | Runs inside the Node server, in your region |
| Edge runtime routes | Run on Vercel's edge network | Run inside the Node server; no global edge |
| Vercel Cron (`crons` in `vercel.json`) | Vercel calls your routes | Needs a scheduler to call them |
| Preview deployments | Per branch and pull request | Needs preview environments on your platform |
| Web Analytics, Speed Insights | Vercel products | Replace with a self-hosted analytics tool |
| Blob, KV, Edge Config, Marketplace databases | Vercel or partner services | Replace with S3-compatible storage, Redis, Postgres, or keep the partner directly |
| Skew protection | Old clients keep their assets | Not built in; plan for it |
| Function limits | Timeouts and memory per plan | Limited only by your server |

Two things work better on your own server: long-running requests and background work have no function timeout, and a WebSocket server can run in the same process.

## Step 1: inventory the Vercel project

Pull the environment variables and list the project's settings.

```bash
npm i -g vercel
vercel link
vercel env pull .env.production --environment=production
vercel domains ls
```

Then check, by hand:

- **`vercel.json`:** rewrites, redirects, headers and `crons`. Rewrites and redirects can usually move into `next.config.js`, where Next.js handles them on any host.
- **Vercel packages in `package.json`:** `@vercel/analytics`, `@vercel/speed-insights`, `@vercel/blob`, `@vercel/kv`, `@vercel/edge-config`. Each needs a replacement.
- **Environment variables by environment:** Production, Preview and Development often differ.
- **Routes with `export const runtime = "edge"`:** they keep working, but you lose the multi-region execution.

`.env.production` holds secrets. Keep it out of Git and delete it when you are done.

## Step 2: build Next.js for a container

Set standalone output in `next.config.js`. It produces a minimal `server.js` with only the dependencies the app needs, which keeps the image small.

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
};

module.exports = nextConfig;
```

A production Dockerfile:

```dockerfile
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_SITE_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
CMD ["node", "server.js"]
```

Notes on the choices:

- `HOSTNAME=0.0.0.0` makes the server listen on all interfaces, so the proxy can reach it.
- `--chown=node:node` keeps `.next/cache` writable, which ISR and image optimization need.
- `public` and `.next/static` are copied separately because standalone output does not include them.

### Build-time variables

`NEXT_PUBLIC_*` variables are inlined into the JavaScript bundle at build time. On Vercel this is invisible. On your own platform, those variables must reach the build. In LogiStack, mark them **Build** in the service's Environment tab; a non-secret build variable is passed as a build argument, which is why the Dockerfile declares it with `ARG`. A variable marked both **Build** and **Secret** is mounted for the build step only and never stored in the image. See [build types](/docs/deploy/build-types/).

Server-only variables, such as database URLs and API keys, are read at runtime and need no build flag.

## Step 3: install the platform and create the service

Install LogiStack on a Linux server:

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

Then create a service from Git: connect GitHub through the GitHub App the wizard creates for you, pick the repository and branch, choose **Dockerfile**, set container port `3000`, and choose a generated hostname for now. Every push to the branch builds an image and rolls it out without downtime: the new container must pass its health check before the old one stops.

Set a health check on a cheap route, for example an `app/api/health/route.ts` that returns `200`. Without one, a new container gets traffic as soon as it starts.

## Step 4: replace Vercel-only features

### Cron jobs

A `vercel.json` like this:

```json
{
  "crons": [{ "path": "/api/cron/digest", "schedule": "0 7 * * *" }]
}
```

becomes a schedule that calls the route. Protect the route with a shared secret, as you probably already do with `CRON_SECRET` on Vercel:

```sh
#!/bin/sh
set -eu
curl -fsS -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/digest
```

Run the schedule **inside** the Next.js service so it has the same environment and reaches the server on `localhost`. Unlike Vercel Cron, you pick the time zone, and every run keeps its exit code and output. See [schedules](/docs/data/schedules/).

### Preview deployments

LogiStack's preview environments give each pull request its own environment and URL, post the commit status on GitHub, and remove the environment when the branch merges. Set different variables for previews, such as a staging API URL. See [preview environments](/docs/deploy/preview-environments/).

![The Previews settings of a project, with preview environments for pull requests](/docs/screens/project-previews.webp)

### Analytics

Replace `@vercel/analytics` with a self-hosted, cookie-free tool. Umami deploys from the [Umami template](/templates/umami/) in one click, with its own database. Add its script tag to your root layout.

### Storage and data

- **Vercel Blob:** use S3-compatible object storage with the AWS SDK. You can host it yourself (MinIO, RustFS, Garage or SeaweedFS in LogiStack) or use Cloudflare R2 or Backblaze B2.
- **KV:** a Redis service in the same environment, reached at `redis:6379`.
- **Marketplace databases:** keep the provider and connect directly, or move to a Postgres service on the same private network for lower latency.
- **Edge Config:** usually a few feature flags. Environment variables or a small table in your database cover most uses.

### ISR with more than one replica

With one replica, ISR works as is: the cache lives in `.next/cache` on that container. With several replicas, each has its own cache, so one replica may serve a page another has already revalidated. If that matters, configure a shared cache handler in `next.config.js` (the `cacheHandler` option, backed by Redis for example) and set `cacheMaxMemorySize: 0` so every instance reads the shared store.

Also note that the filesystem cache resets on each deploy, because each deploy is a new container. Pages regenerate on first request.

### Skew protection

On Vercel, a browser that loaded the previous deployment can still fetch that deployment's JavaScript chunks. On your own server, the old chunks are gone after a rollout, and a client navigating with an old bundle can hit a missing file. Most apps tolerate this with a reload on chunk-load errors. Apps with long-lived sessions can serve `.next/static` from object storage or a CDN that keeps previous builds.

## Step 5: test, then switch DNS

1. Deploy and test on the generated hostname: sign-in, forms, image-heavy pages, revalidation, a cron run.
2. Add your real domain to the service with HTTPS on. See [domains](/docs/networking/domains/).
3. Lower the DNS TTL a day before.
4. Point the domain at your server: an A record for the apex, or for `www` either an A record or a CNAME to a hostname that resolves to the server. Remove the records pointing at Vercel.
5. Caddy issues a Let's Encrypt certificate once the record resolves.
6. Keep the Vercel project for a week. Reverting is a DNS change.

## Performance: what to expect

Without Vercel's edge network, every request goes to your server's region. For an audience mostly in one region, a server close to them is often faster than a cold serverless function. For a global audience, put a CDN in front for static assets and cacheable pages, and keep dynamic routes on the server.

Compute is no longer metered per invocation. A small server handles a lot of Next.js traffic, and long requests no longer count against a timeout. Size for memory first: a busy Next.js server with image optimization can use several hundred megabytes per instance.

## FAQ

### Does Next.js work fully outside Vercel?

Yes. Next.js supports self-hosting with `next start` or standalone output, including the App Router, server components, server actions, streaming, ISR, middleware and image optimization. What you lose are Vercel's platform services, such as its global edge, managed analytics and skew protection.

### Do I need Docker to self-host Next.js?

Not strictly; `next start` runs on any server with Node.js. A container makes builds reproducible and deploys roll back cleanly, so most self-hosted platforms use one. Railpack can also build a Next.js app without a Dockerfile if you prefer.

### What happens to my edge functions?

They keep working, but they run inside the Node server in the region where you host it. Code written for the edge runtime is compatible; it simply loses the multi-region execution. For most apps, a server near your users matters more.

### How do I handle `NEXT_PUBLIC_` variables?

They are baked in at build time, so they must be available to the build, not only at runtime. On LogiStack, mark them as build variables and declare them with `ARG` in your Dockerfile. Changing one means rebuilding.

If you want to try it on one app, install LogiStack with [one command](/#install), deploy your Next.js repository on a generated hostname, and compare it side by side with Vercel before you move DNS. Git deploys, preview environments, schedules and databases are all in the free, open-source build.

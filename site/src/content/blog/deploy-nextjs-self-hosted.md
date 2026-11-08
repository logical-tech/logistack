---
title: "Self-host Next.js: deploy with standalone output on your server"
description: "Self-host Next.js on your own server with standalone output: a production Dockerfile, env vars, caching, image optimization and push-to-deploy."
date: 2026-11-08
category: Deployment
keywords: self-host nextjs, deploy nextjs self hosted, nextjs standalone output, nextjs docker, nextjs vps
---

Your Next.js app works on Vercel, but the bill grows with traffic, or your data has to stay in one region, or you just want the app next to its database on a server you control. You can self-host Next.js and keep almost every feature: server components, route handlers, middleware, ISR and image optimization all run in a plain Node.js process. The trick is the `standalone` output mode, which turns a 600 MB `node_modules` folder into a small, self-contained server you can put in a container.

This guide walks through a production Dockerfile, the settings that trip people up, and a deploy flow that rebuilds on every push.

## What you give up when you self-host Next.js

Be clear about the trade first. Running `next start` (or the standalone server) gives you the full Next.js runtime, but not Vercel's platform around it.

| Feature | On your own server |
| --- | --- |
| Server components, route handlers, server actions | Work as usual |
| Middleware | Runs in the Node.js server, not at an edge location |
| ISR and `revalidate` | Work, cached on the local disk of each replica |
| Image optimization (`next/image`) | Works, uses `sharp` in the container |
| Edge runtime routes | Run in the Node.js server, no global edge network |
| Preview URLs per branch | Need your platform to provide them |
| Global CDN | Add one yourself (Cloudflare or similar) if you need it |

For most apps that serve one region, none of this matters. If your audience is spread across continents and you rely on edge rendering, a managed platform may still be the better fit. Our list of [Vercel alternatives](/blog/vercel-alternatives/) covers both managed and self-hosted options, and [migrating from Vercel](/blog/migrate-from-vercel/) goes through the move step by step.

## Turn on standalone output

Add one line to `next.config.ts`:

```ts title="next.config.ts"
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	output: "standalone",
};

export default nextConfig;
```

On the next `next build`, Next.js traces which files your server actually imports and copies them into `.next/standalone`, together with a minimal `server.js`. That folder holds only the dependencies your code reaches at runtime, so the final image is a fraction of the size of a full install.

Two folders are not copied for you, because a CDN usually serves them:

- `.next/static`: the hashed JavaScript and CSS bundles.
- `public`: your static files, such as `favicon.ico` and images.

Your Dockerfile copies both next to `server.js`. Forget them and the page renders, but without styles or scripts.

## A production Dockerfile for Next.js

This Dockerfile uses three stages: install, build, run. It works with npm, pnpm or Yarn lockfiles.

```dockerfile title="Dockerfile"
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* pnpm-lock.yaml* yarn.lock* ./
RUN corepack enable && \
    if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; \
    elif [ -f yarn.lock ]; then yarn install --frozen-lockfile; \
    else npm ci; fi

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_SITE_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && \
    if [ -f pnpm-lock.yaml ]; then pnpm build; else npm run build; fi

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
```

Add a `.dockerignore` so your local build and secrets stay out of the context:

```text title=".dockerignore"
node_modules
.next
.env*
.git
```

A few details in that file matter more than they look:

- **`HOSTNAME=0.0.0.0`**: the standalone server binds to the container's hostname by default. Inside Docker that address is not always reachable from the proxy. Binding to all interfaces fixes "the container is running but I get a 502".
- **`CMD ["node", "server.js"]`**: run Node directly, not through `npm start`. npm does not forward `SIGTERM` reliably, so your server gets killed instead of shutting down cleanly during a rollout.
- **`USER node`**: the official image ships an unprivileged `node` user. Use it.
- **Alpine base**: it includes `wget`, which matters for health checks later.

Test it locally before you deploy:

```bash
docker build -t shop-web:dev .
docker run --rm -p 3000:3000 shop-web:dev
```

## Environment variables: build time vs runtime

This is the part of self-hosting Next.js that causes the most confusion. There are two kinds of variables, and they reach your app at different moments.

**`NEXT_PUBLIC_*` variables are inlined at build time.** Next.js replaces `process.env.NEXT_PUBLIC_SITE_URL` with the literal string during `next build`. Changing the value at runtime does nothing; you need a rebuild. That is why the Dockerfile above declares `ARG NEXT_PUBLIC_SITE_URL` in the build stage.

**Everything else is read at runtime.** `DATABASE_URL`, `STRIPE_SECRET_KEY` and similar values are read by the server when it runs, so they belong on the running container, never baked into the image.

A rule that saves time: if the browser needs it, it is a build variable. If only the server needs it, it is a runtime variable, and if it is sensitive, it is a secret.

One more trap: pages that Next.js prerenders at build time run their data fetching during `next build`. If a page reads from the database while being prerendered, the build container needs `DATABASE_URL` too. Mark those pages `export const dynamic = "force-dynamic"` or give the build the variable as a build secret, so it never lands in the image.

## Caching, ISR and multiple replicas

The standalone server keeps its ISR and data cache on local disk under `.next/cache`. On one replica this just works. With two or more replicas, each one has its own cache:

- A `revalidatePath()` call reaches only the replica that handled the request. The others keep serving their copy until their own timer expires.
- Every replica optimizes images on its own the first time they are requested.

For many apps this is acceptable: time-based revalidation converges within the `revalidate` window. If you rely on on-demand revalidation across replicas, configure a shared cache handler (Next.js supports a custom `cacheHandler` in `next.config`, and Redis-backed handlers exist as community packages), or run one replica and scale vertically. Pick one consciously instead of discovering it in production.

Uploads are the other stateful piece. Do not write user files to the container's disk; they disappear on the next deploy. Send them to S3-compatible storage. You can run an S3-compatible server next to the app on the same platform.

## Image optimization

`next/image` works when you self-host. Next.js 15 and later use `sharp` for resizing, and the standalone trace includes it when it is installed. If you see a warning about missing `sharp` in production, add it to your dependencies:

```bash
npm install sharp
```

Optimized images are cached in `.next/cache/images` on each replica. If image traffic is heavy, a CDN in front of the server takes most of that load.

## Graceful shutdown and health checks

During a rolling deploy the old container gets `SIGTERM` and a few seconds to finish its requests. The standalone server handles `SIGTERM` itself, as long as Node is PID 1 (the `CMD` above makes sure of that).

Give the platform something cheap to probe. A route handler is enough:

```ts title="app/healthz/route.ts"
export const dynamic = "force-dynamic";

export function GET() {
	return Response.json({ ok: true });
}
```

Docker health checks run inside the container, so the image needs a client like `wget` or `curl`. Alpine has `wget`. A Debian-slim base does not ship either, so install one there if you want an HTTP check.

## Deploy Next.js with LogiStack

[LogiStack](/features/) is an open-source, self-hosted PaaS that builds your repository on your server and runs it on Docker Swarm with Caddy in front. Here is the flow for the app above.

**1. Install LogiStack** on a Linux server (Ubuntu 22.04+ or Debian 12+, 2 GB of RAM):

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

**2. Connect your Git provider.** GitHub connects through a GitHub App that LogiStack creates for you; GitLab, Gitea, Forgejo and Bitbucket use an access token. See [Deploy from Git](/docs/deploy/from-git/).

**3. Create a Git service.** Pick the repository and branch, set **Build with** to **Dockerfile** and **Container port** to `3000`. In a monorepo, set **Root directory** and add **Watch paths** so only relevant pushes rebuild.

**4. Add variables.** In the **Environment** tab, add `NEXT_PUBLIC_SITE_URL` and check **Build**, so it reaches the build as a build argument. Add `DATABASE_URL` and API keys as secrets without **Build**: they reach only the running container. A variable marked both **Build** and **Secret** is passed as a BuildKit secret for the build step and is never stored in the image. The details are in [Build types](/docs/deploy/build-types/).

**5. Set a health check.** Under **Settings** › **Healthcheck and drain**, choose **HTTP request**, port `3000`, path `/healthz`. A new replica takes traffic only once it passes, and the old one stops after.

**6. Run migrations before the rollout.** If you use Prisma or Drizzle, add a **Pre-deploy command**. It runs once on the new image; if it fails, the old version keeps serving:

```text title="Pre-deploy command"
npx
prisma
migrate
deploy
```

The standalone output does not include the Prisma CLI, so either keep a migration step in a separate image stage or call your migration through a small script your build copies in. See [Deployments](/docs/deploy/deployments/) for how release commands run.

**7. Add a domain.** Use your own hostname and LogiStack issues a Let's Encrypt certificate through Caddy, or start with a generated `sslip.io` hostname for testing.

Every push to the branch now builds an image tagged with the deployment ID, rolls it out replica by replica, and keeps the previous images so you can roll back in one click. If you want per-pull-request URLs like Vercel previews, LogiStack has preview environments for pull requests.

![The Deployments tab of a service with the live build log](/docs/screens/service-deployments.webp)

### Static export instead of a server

If your app has no server-side features, `output: "export"` writes plain HTML to `out/`. You don't need Node at all: LogiStack's **Static site** builder serves it with Caddy. See [deploying a static site](/blog/deploy-static-site/).

## Common problems when self-hosting Next.js

- **Unstyled page, 404 on `/_next/static`**: the Dockerfile didn't copy `.next/static` or `public` next to `server.js`.
- **502 from the proxy, container running**: the server listens on the container hostname. Set `HOSTNAME=0.0.0.0`.
- **A `NEXT_PUBLIC_` value is stale**: it was inlined in the previous build. Rebuild after changing it.
- **Build fails reaching the database**: a page is prerendered at build time. Make it dynamic or pass the variable as a build secret.
- **Memory kills under load**: image optimization is memory hungry. Raise the memory limit or move images to a CDN or a dedicated image service.

## FAQ

### Can I self-host Next.js without Docker?

Yes. Copy `.next/standalone`, `.next/static` and `public` to the server and run `node server.js` under systemd. You lose immutable images, easy rollbacks and isolation from other apps, which is why most teams containerize.

### Does ISR work when self-hosting Next.js?

Yes. Time-based revalidation works on any Node.js server. On-demand revalidation with several replicas needs a shared cache handler, because each replica keeps its own cache on disk.

### How much server do I need for a Next.js app?

A small app runs comfortably in 512 MB to 1 GB of memory per replica. Builds need more than runtime, often 2 GB or more for large apps, so size the build server for the build, not just the traffic.

### Is middleware supported outside Vercel?

Yes. Middleware runs inside the standalone Node.js server before your routes. It doesn't run at a global edge, so latency depends on where your server is.

Self-hosting Next.js comes down to standalone output, a careful Dockerfile and a clear split between build and runtime variables. If you want push-to-deploy, rollbacks and HTTPS on your own server without writing the glue yourself, [install LogiStack](/#install) and point it at your repository.

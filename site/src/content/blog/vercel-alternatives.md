---
title: "Vercel alternatives for Next.js and full-stack apps"
description: "Compare Vercel alternatives for Next.js, static sites and full-stack apps: edge platforms, managed hosts and self-hosted PaaS options, with trade-offs."
date: 2026-11-08
category: Comparisons
keywords: vercel alternatives, self-host next.js, vercel alternative open source, next.js hosting, netlify vs vercel
---

Vercel is a pleasant place to ship a Next.js app. Push a branch, get a preview URL, merge, and production updates in under a minute. The friction shows up later: a bill that grows with seats and usage, a Hobby plan that does not allow commercial projects, a backend that needs a long-running process or a database next to it, or a client who wants the data in their own region. This guide covers the Vercel alternatives that solve those problems, how much of the Vercel experience each one keeps, and what changes when you run Next.js outside Vercel.

## What you get on Vercel

Vercel is the company behind Next.js, and the platform is built around its features. You get:

- Git-based deploys with a preview URL for every branch and pull request.
- A global edge network that caches static assets and pages.
- Serverless functions for API routes and server rendering, with a runtime tuned for Next.js.
- Incremental static regeneration, image optimization and middleware that work without configuration.
- A team model on the Pro plan, billed per seat plus usage beyond the included amounts.

What it does not give you is a place for things that are not request and response: a Postgres server you control, a queue worker, a WebSocket server that holds connections for hours, a cron job that runs for twenty minutes. Those go to other providers, and each one is another bill and another dashboard.

## Signs you need a Vercel alternative

- **Your bill tracks traffic more than revenue.** Bandwidth, function time and image optimization add up on busy sites.
- **You run a full-stack app.** The frontend is on Vercel, the API on another host, the database on a third, the workers on a fourth.
- **You need long-running processes.** WebSockets, background jobs, streaming that outlasts function limits.
- **Data residency.** You must keep data and compute in one country or on hardware you choose.
- **You use something other than Next.js.** Remix, SvelteKit, Astro, Nuxt and plain Node run fine elsewhere, often more simply.

## Can you self-host Next.js?

Yes. Next.js runs as a normal Node.js server, and most features work there, including server components, API routes, middleware and incremental static regeneration. Set the standalone output so the build contains only what the server needs:

```js
// next.config.mjs
/** @type {import('next').NextConfig} */
const nextConfig = {
	output: "standalone",
};

export default nextConfig;
```

Then build a small image:

```dockerfile
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
```

Three things differ from Vercel. The ISR cache lives on the server's disk, so several replicas each keep their own cache unless you configure a shared cache handler. Image optimization runs on your server's CPU. And there is no global edge network unless you put a CDN such as Cloudflare in front.

If your site is fully static (`output: "export"`), you do not need a Node server at all: any static host serves the `out` folder.

## Vercel alternatives at a glance

| Platform | Type | Best at | Long-running processes | Databases | Self-hostable |
| --- | --- | --- | --- | --- | --- |
| Netlify | Managed, edge | Static and Jamstack sites | No | Via partners | No |
| Cloudflare Workers | Managed, edge | Global edge apps | Limited | D1, KV, Durable Objects | No |
| Render | Managed PaaS | Full-stack apps | Yes | Postgres, Redis-compatible | No |
| Railway | Managed PaaS | Full-stack apps, fast setup | Yes | Postgres, MySQL, Redis, MongoDB | No |
| AWS Amplify Hosting | Managed on AWS | Teams on AWS | No | AWS services | No |
| LogiStack | Self-hosted PaaS | Full-stack apps on your servers | Yes | Six engines, built in | Yes |
| Coolify | Self-hosted PaaS | Large app catalog | Yes | One-click databases | Yes |

## Edge-first alternatives

### Netlify

Netlify pioneered the Jamstack model: static builds on a CDN, with serverless and edge functions for dynamic parts, plus deploy previews, forms and redirects configured in `netlify.toml`. It supports Next.js through an adapter. It is the most direct swap if your site is mostly static and you want to keep the managed, preview-per-branch workflow. Read [Netlify alternatives](/blog/netlify-alternatives/) for its own limits.

### Cloudflare Workers and Pages

Cloudflare runs your code in V8 isolates in hundreds of cities, with static assets served from the same network. Cloudflare now steers new projects toward Workers with static assets rather than Pages. Next.js runs there through the OpenNext adapter. Storage options include D1 (SQLite), KV, R2 and Durable Objects. It is fast and the free tier is generous, but the runtime is not a full Node.js server, and some npm packages will not work.

## Full-stack managed alternatives

### Render

Render runs long-lived web services, workers, cron jobs and managed Postgres side by side. A Next.js app runs as a Node service. You lose the edge network by default and gain a place for your backend and database in one account.

### Railway

Railway puts your frontend, API, workers and databases on one canvas and bills by usage. It handles monorepos well and deploys quickly. Costs are low for small apps and rise with sustained load.

### AWS Amplify Hosting

Amplify Hosting deploys frontends, Next.js included, onto AWS with branch previews. It makes sense when the rest of your stack already lives in AWS and you want everything under one account.

## Self-hosted Vercel alternatives

Self-hosting gives you a fixed monthly cost, data on hardware you pick, and room for any process. It also makes you responsible for the servers.

### LogiStack

LogiStack is an open-source PaaS under Apache 2.0, on Docker Swarm with Caddy for automatic HTTPS. For a Vercel user, the parts that matter:

- **Git deploys on push** from GitHub, GitLab, Gitea or Bitbucket, built with your Dockerfile, with Railpack (no Dockerfile needed) or as a static site served by Caddy. See [build types](/docs/deploy/build-types/).
- **Preview environments.** Each pull request gets its own environment and URL, with the commit status posted on GitHub, and is removed when it closes. See [preview environments](/docs/deploy/preview-environments/).
- **Rolling deploys.** The new container must pass its health check before the old one stops, and you can roll back to any earlier deployment without a rebuild.
- **The backend next to the frontend.** Postgres, MySQL, MariaDB, MongoDB, Redis and libSQL run in the same project, with a table editor in the dashboard, plus workers, cron jobs and S3-compatible storage.
- **Cloudflare in front.** LogiStack can issue Cloudflare origin certificates and publish a service through a Cloudflare Tunnel, which gives you a CDN without opening inbound ports.

![The Preview deployments wizard, choosing which environment a pull request preview clones](/docs/screens/project-previews.webp)

The honest trade-offs: LogiStack has no global edge network or serverless functions of its own. Your app runs on the servers you add, so latency depends on where they are. It is a young project with a smaller community than Vercel's, and it uses Docker Swarm, not Kubernetes.

### Coolify

Coolify is a widely used open-source dashboard for self-hosting, with Nixpacks builds, Compose support and a large one-click catalog. See [Coolify alternatives](/blog/coolify-alternatives/) for a comparison.

## Which Vercel alternative fits you

- **Mostly static marketing site:** Netlify or Cloudflare.
- **Next.js at the edge, worldwide:** Cloudflare with OpenNext, or stay on Vercel.
- **Full-stack app, no servers:** Render or Railway.
- **Full-stack app, fixed cost, your servers:** LogiStack or Coolify.
- **Heavy use of Vercel-specific features** such as its image pipeline at global scale: stay, and move only the backend.

Many teams do the last one. The frontend stays on Vercel, while the API, workers and databases move to a self-hosted platform where long-running processes cost a fixed amount. If you are new to the idea, [what is a self-hosted PaaS](/blog/self-hosted-paas/) explains the model.

## FAQ

### What is the best free alternative to Vercel?

For static sites, Cloudflare and GitHub Pages have free tiers that cover most projects. For full-stack apps, a self-hosted PaaS such as LogiStack or Coolify is free software, and you pay only for the server.

### Can I host Next.js without Vercel?

Yes. Build with `output: "standalone"` and run `node server.js` in a container. Server components, API routes, middleware and ISR work, with the cache on local disk unless you add a shared cache handler.

### Do I lose preview deployments if I leave Vercel?

Not necessarily. Netlify, Render, Railway and Amplify offer previews per branch or pull request, and LogiStack creates a preview environment with its own URL for each pull request.

### Is Vercel or Netlify better?

Vercel is the stronger fit for Next.js, since the same company builds both. Netlify is equally capable for static sites and other frameworks. For backends and databases, look beyond both.

If your app has outgrown request-and-response hosting and you want the frontend, backend and database on servers you own, try LogiStack. The [first deploy guide](/docs/getting-started/first-deploy/) walks you through a Git deploy, and the [install command](/#install) sets up a server in minutes.

---
title: "How to deploy vibe-coded apps to your own server"
description: "Deploy vibe-coded apps from Lovable, Bolt, v0, Cursor or Claude Code to your own server: export to Git, pick a build, set env vars, add a domain and HTTPS."
date: 2026-11-08
category: AI
keywords: deploy vibe coded app, deploy lovable app, deploy bolt app, deploy v0 app, self-host ai generated app, vibe coding deployment
---

The app works in the builder's preview. You clicked through it, showed it to a colleague, maybe got a first customer. Now you want it on your own domain, on a server you control, without the builder's hosting fees or limits. This guide shows how to deploy vibe-coded apps from Lovable, Bolt, v0, Cursor or Claude Code to your own server: get the code into Git, figure out what kind of app you actually have, build it, wire up its configuration and put it online with HTTPS. It assumes no DevOps background.

## What each AI builder actually gives you

The first job is to know what is in the repository. The builders produce different shapes of app.

| Tool | What you usually get | How you get the code out | Typical backend |
| --- | --- | --- | --- |
| Lovable | Vite, React and TypeScript single-page app | GitHub sync from the editor | Supabase (database, auth, storage, edge functions) |
| Bolt.new | Depends on the prompt: often Vite and React, sometimes Next.js, Astro or a Node server | Download as a zip, or push to GitHub | Whatever it wired up, often Supabase |
| v0 | Next.js App Router with Tailwind and shadcn/ui | Push to GitHub, or download the code | Next.js route handlers and server actions, plus any database you connected |
| Cursor, Claude Code, Windsurf | Whatever stack you or the agent chose | It is already your repository | Anything |

Two consequences follow. A Lovable app is mostly a static frontend: the hard parts live in Supabase, which keeps running where it is. A v0 or Bolt app with server code needs a running Node process. Read `package.json` before you decide anything.

## Step 1: get the code into Git

Every deployment flow below starts from a Git repository, because that is what makes later changes deploy on push.

- **Lovable:** connect GitHub in the project settings. Lovable creates the repository and keeps it in sync both ways, so you can keep prompting in Lovable and deploy what lands in Git.
- **Bolt.new:** push to GitHub from the project menu, or download the zip and push it yourself.
- **v0:** push the generated project to a GitHub repository, or download it and commit it.
- **Cursor and Claude Code:** commit and push as usual.

If you downloaded a zip, run it locally once before you go further:

```bash
git init && git add -A && git commit -m "Initial export"
npm install
npm run build
```

A build that fails on your laptop will fail on the server too. Fix it here, where the error is easier to read.

## Step 2: find out what kind of app it is

Open `package.json` and look at the `scripts` and dependencies.

| You see | It is | How to run it |
| --- | --- | --- |
| `vite build`, no server code | Static single-page app | Build once, serve files |
| `next build` with `output: "export"` | Static Next.js export | Build once, serve the `out` folder |
| `next build` without export, or route handlers, server actions | Next.js server app | Run `next start` or a standalone server |
| `express`, `hono`, `fastify`, a `server.js` | Node server | Run the server process |
| `astro build` without an adapter | Static site | Serve the `dist` folder |

Static apps are the cheapest to host: a web server returns files and never runs your code. Server apps need a process that stays up, memory limits and a health check.

## Step 3: find the configuration the app expects

Generated code reads configuration in three places, and you need all of it on the server:

1. **`.env` files.** Look for `.env`, `.env.local` and `.env.example`. List every variable name.
2. **Public build-time variables.** `VITE_*` in Vite apps and `NEXT_PUBLIC_*` in Next.js are baked into the JavaScript at build time. They must be set when the app is built, not only when it runs, and anyone can read them in the browser.
3. **Hardcoded values.** Search for URLs and keys pasted straight into the code.

```bash
grep -rnE "https?://|sk_|api[_-]?key|secret|supabase\.co" src app lib 2>/dev/null | grep -v node_modules
```

Anything secret that ended up in a `VITE_` or `NEXT_PUBLIC_` variable, or in source, is public. Move it to server-side code and rotate it. A Supabase anon key is meant to be public, but only when row level security is on for every table. Our post on [secure vibe coding](/blog/secure-vibe-coding/) covers these mistakes and a ten-minute review of AI-written code, so this guide does not repeat it.

## Step 4: add a Dockerfile for server apps

Static apps do not need one if your platform has a static site builder. For a Next.js server app, set `output: "standalone"` in `next.config.ts` and use a small multi-stage build:

```ts title="next.config.ts"
import type { NextConfig } from "next";

const config: NextConfig = { output: "standalone" };
export default config;
```

```dockerfile title="Dockerfile"
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
```

The `ARG` lines let the build see the public variables. Server-only secrets are not declared here; they arrive as runtime environment variables. For more on Next.js specifically, see [self-hosting Next.js](/blog/deploy-nextjs-self-hosted/).

If the app is a plain Node server and you would rather not write a Dockerfile, a detection-based builder such as Railpack can build it from `package.json` alone. Try that first and switch to a Dockerfile when you need control.

## Step 5: deploy it

You need four things on the server: a build, the environment variables, a domain with a certificate, and a process supervisor that restarts the app when it crashes. A self-hosted PaaS bundles these. The flow on LogiStack, an open-source PaaS you install on your own server:

1. [Install LogiStack](/#install) on a VPS:

   ```bash
   curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
   ```

2. Connect GitHub and create a service from the repository ([deploy from Git](/docs/deploy/from-git/)).
3. Choose the build type ([build types](/docs/deploy/build-types/)):
   - **Static site** for Vite, Astro and static exports. The publish directory defaults to `dist`; use `out` for a Next.js static export. Container port `80`. The builder installs dependencies with the package manager your lockfile names, runs your `build` script, and serves `index.html` for unknown paths, so client-side routes survive a reload.
   - **Dockerfile** for the Next.js server above, container port `3000`.
   - **Railpack** for a Node server without a Dockerfile.
4. Add the variables on the **Environment** tab. Check **Build** for `VITE_*` and `NEXT_PUBLIC_*` values so the build sees them, and mark secrets as **Secret**.
5. Add your domain. Point an A record at the server, and Caddy issues the certificate.
6. For a server app, set an HTTP health check on a route that returns 200, such as `/` or `/api/health`.

From then on, every push to the branch builds and rolls out a new version. If a deploy breaks the app, roll back to the previous deployment from the **Deployments** tab.

![A service's deployment history with build status and commit for each deploy](/docs/screens/service-deployments.webp)

## What changes when you leave the builder's hosting

The builder handled some things for you. Check each one on your own server.

- **Supabase redirect URLs.** Add your new domain to the allowed redirect URLs in Supabase Auth, or sign-in links point back to the old preview domain.
- **OAuth apps.** Google and GitHub sign-in need the new callback URL registered.
- **CORS.** If the frontend and an API now live on different domains, the API must allow the new origin.
- **Webhooks.** Stripe and other services send events to a URL. Update it.
- **Emails.** Transactional email links often embed the site URL in a variable. Change it.
- **Database.** If the builder provisioned a database for you, decide whether it stays there or moves next to the app. A Supabase project can stay on Supabase while the frontend moves; nothing forces a big-bang migration.

## Keep shipping with the AI tool

Deploying from Git does not end the vibe coding. The loop now looks like this:

1. Prompt in Lovable, Bolt or your editor.
2. The change lands in a branch.
3. A preview environment builds the branch on its own URL, so you test it before it reaches users. See [preview environments](/blog/preview-environments/).
4. Merge, and production deploys.

Protect `main` so the builder cannot push straight to production, and review the diff of anything that touches auth, payments or database access.

## FAQ

### Can I deploy a Lovable app without Lovable hosting?

Yes. Sync the project to GitHub, build it as a static site with `npm run build`, and serve the `dist` folder from any web server or PaaS. The Supabase backend keeps running as it is; add your new domain to its allowed redirect URLs.

### Do I need Docker to deploy a vibe-coded app?

Not for a static app if your platform builds static sites, and not for many Node apps if it can detect and build them. Server apps with unusual needs, such as a Next.js standalone build, are easiest with a short Dockerfile you control.

### Why does my app work locally but show a blank page in production?

Usually a build-time variable was missing during the build, so the bundled code has `undefined` where the API URL should be. Set `VITE_*` or `NEXT_PUBLIC_*` variables for the build step and rebuild.

### Is it cheaper to self-host a vibe-coded app?

Often, once you have more than one or two apps. One small VPS can run several static sites and server apps, while builder and frontend-cloud plans charge per project, seat or usage. You trade that for doing your own updates and backups.

### Should the AI agent deploy for me?

It can, with a narrow, expiring key and a human approving destructive actions. Our guide to [AI agents and infrastructure](/blog/ai-agents-infrastructure/) explains how to set that up.

If your builder's preview has become a real product, give it a real home. [Install LogiStack](/#install) on a server you own, connect the repository and every push from your AI tool deploys with HTTPS, rollbacks and logs included.

---
title: "Monorepo deployments: build and ship only what changed"
description: "Monorepo deployments without rebuilding everything: watch paths, build contexts, per-app Dockerfiles, shared packages and preview environments explained."
date: 2026-11-08
category: Deployment
keywords: monorepo deployments, monorepo deploy, deploy monorepo docker, watch paths, turborepo docker
---

A monorepo makes code sharing easy and deployments awkward. You fix a typo in the marketing site and the API, the worker and the admin app all rebuild and redeploy. Or the opposite: you change a shared package and only one of the three apps that use it picks up the change. Monorepo deployments come down to two questions for every service: what does it need to build, and which changes should trigger it. This guide answers both with concrete config.

## A typical layout

Most JavaScript and TypeScript monorepos look something like this, and the same ideas apply to Go workspaces, Python packages or a Cargo workspace:

```text
/
├── apps/
│   ├── web/          # Next.js frontend
│   ├── api/          # HTTP API
│   └── worker/       # queue consumer
├── packages/
│   ├── db/           # schema and client, used by api and worker
│   ├── ui/           # components, used by web
│   └── shared/       # types and helpers, used by all three
├── package.json
└── pnpm-lock.yaml
```

Three deployable apps, three internal packages, one lockfile. Each app becomes its own service with its own image, domain, scaling and rollback history. Deploying them as one unit throws away most of the reasons you split them.

## Question 1: what does each service need to build?

### Root directory vs build context

Two settings decide which files a build can see:

- **Root directory**: the folder the platform treats as the project. Paths in other settings are relative to it.
- **Build context**: the folder sent to Docker or BuildKit. A `COPY` can only reach files inside it.

If an app is fully self-contained, set the root directory to `apps/web` and the context to `.`. Builds are small and fast.

If the app imports `packages/ui` or `packages/shared`, the context must include them. Keep the root directory at `/` and point the Dockerfile path at `apps/web/Dockerfile`. The usual error when you get this wrong is a `COPY` that cannot find `packages/...`.

### A Dockerfile that sees the whole repo but copies only what it needs

Sending the full repository as context is fine as long as the Dockerfile is selective and `.dockerignore` excludes the noise:

```text
# .dockerignore
**/node_modules
**/.next
**/dist
.git
*.md
```

With pnpm and Turborepo, `turbo prune` produces a minimal subset of the workspace for one app, split into the files needed to install and the full sources. That split is what makes dependency caching work:

```dockerfile
# apps/web/Dockerfile
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS prune
COPY . .
RUN pnpm dlx turbo@2 prune web --docker

FROM base AS deps
COPY --from=prune /repo/out/json/ ./
COPY --from=prune /repo/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS build
COPY --from=prune /repo/out/full/ ./
RUN pnpm turbo run build --filter=web

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
```

The `deps` stage only changes when a `package.json` or the lockfile of something `web` depends on changes. Edit a component and BuildKit reuses the installed dependencies. The [Docker build best practices](/blog/docker-build-best-practices/) post explains the layer and cache-mount rules behind this.

Without Turborepo, copy each workspace's `package.json` explicitly before the install step, then copy the sources. It is more lines, but the effect on caching is the same.

### One lockfile, many apps

A shared lockfile is both the strength and the trap of a monorepo. Any dependency change anywhere touches `pnpm-lock.yaml`, and if every service rebuilds on lockfile changes, you are back to rebuilding everything. Two ways out:

- Prune the lockfile per app at build time (`turbo prune` does this), so the install layer only changes when that app's dependencies change.
- Accept lockfile-triggered rebuilds but keep them cheap with a warm cache.

## Question 2: which changes should deploy which service?

### Write the dependency map down

Before you configure any tool, write down which folders each service is built from:

| Service | Built from |
|---|---|
| web | `apps/web`, `packages/ui`, `packages/shared`, lockfile |
| api | `apps/api`, `packages/db`, `packages/shared`, lockfile |
| worker | `apps/worker`, `packages/db`, `packages/shared`, lockfile |

This table is the source of truth. Everything below is just a place to encode it.

### Path filters in CI

In GitHub Actions, path filters decide whether a workflow runs at all:

```yaml
on:
  push:
    branches: [main]
    paths:
      - "apps/api/**"
      - "packages/db/**"
      - "packages/shared/**"
      - "pnpm-lock.yaml"
```

Keep one workflow per service with its own filter, or use a single workflow with a change-detection step that outputs which services to build. Build tools with a project graph, such as Turborepo, Nx or Bazel, can compute the affected set from the graph instead of from hand-written lists, which stays correct as dependencies change.

### Watch paths on the deploy platform

If your platform builds on push, it needs the same map. LogiStack calls these **watch paths**: a list of globs or directory prefixes on each Git service. A push only deploys the service when it changes at least one listed path. An empty list deploys on every push.

```text
apps/api
packages/db
packages/shared
pnpm-lock.yaml
```

A service can hold up to 50 watch paths. Pushes that touch none of them still show up in the service's **Deployments** tab as **Skipped**, with the reason, so you can tell "nothing happened" from "something broke". The setting sits next to the root directory in the service wizard, and can also be set through the API. See [deploy from Git](/docs/deploy/from-git/) and [Git webhooks](/docs/automation/git-webhooks/).

### Commits that should deploy nothing

Docs-only commits, CI tweaks and README edits should not deploy anything. Watch paths handle most of them. For the rest, LogiStack skips any commit whose message contains `[skip ci]`, `[ci skip]` or `[skip deploy]`.

## Coordinating services that change together

Monorepos invite changes that span several services: a new database column, the API that writes it and the frontend that shows it, in one pull request. Each service still deploys on its own, so plan the order:

1. **Expand the schema first.** Add the column as nullable, in a migration that runs before the new API code. With LogiStack, a pre-deploy command runs the migration on the new image before any replica is replaced; see [deployments](/docs/deploy/deployments/).
2. **Deploy the API** so it writes the new field and tolerates its absence.
3. **Deploy the frontend** that reads it.
4. **Contract later.** Drop old columns in a later release, once nothing reads them.

Each step must keep the previous version working, because rollouts are not atomic across services. The [zero-downtime deployments](/blog/zero-downtime-deployments/) guide covers expand and contract in detail.

## Preview environments for monorepos

Pull request previews are where monorepos pay off. One pull request can change the API and the web app together, and a reviewer wants to click through both. A preview should therefore clone the whole project environment, not one service.

LogiStack's previews do that: a pull request clones an environment you choose, such as staging, into `pr-<number>`, builds the pull request's head commit for the services that build from that repository, and posts the URL on the pull request. Closing or merging the pull request removes it. The setup is in [preview environments](/docs/deploy/preview-environments/), and the general practice in the [preview environments](/blog/preview-environments/) post.

## Common monorepo deployment mistakes

- **Context too narrow.** Root directory set to `apps/web` while the app imports `packages/ui`. The build fails on `COPY` or on module resolution.
- **Context too broad without `.dockerignore`.** Every build uploads `node_modules` and `.git`, and any change anywhere invalidates the cache.
- **Watch paths that forget shared packages.** A fix in `packages/shared` never reaches the services that use it. Review the map whenever a new internal dependency appears.
- **One pipeline for everything.** A failing test in the worker blocks a frontend hotfix. Separate services deserve separate gates.
- **Versioning internal packages.** Inside one repository, use workspace references (`workspace:*`) and deploy from a commit. Publishing internal packages to a registry adds a step with no benefit.

## FAQ

### What is the best way to deploy a monorepo?

Treat each deployable app as its own service with its own image and rollback history. Build each with a Dockerfile that copies only the packages it needs, and trigger each deploy only from the paths it is built from.

### How do I stop every app in my monorepo from redeploying on each push?

Use path filters in CI or watch paths on the platform, listing each app's folder, the shared packages it imports and the lockfile. Prune the lockfile per app if lockfile changes trigger too many builds.

### Should each app in a monorepo have its own Dockerfile?

Usually yes, kept inside the app's folder. Apps rarely share a runtime image, and separate Dockerfiles keep each build's cache independent.

### Do I need Turborepo or Nx to deploy a monorepo?

No, but they help. Their project graph tells you which apps a change affects, and `turbo prune` makes Docker caching much better. Without them, hand-written watch paths work fine for a handful of apps.

### Can preview environments work with a monorepo?

Yes, and they work best when a preview clones every service in the project, so a pull request that touches the API and the frontend gets both in one preview.

LogiStack handles the deploy side of a monorepo on your own servers: one service per app, a root directory and Dockerfile path per service, watch paths so only the right apps rebuild, and previews that clone the whole environment. It is free and Apache 2.0. [Install it](/#install) and connect your repository.

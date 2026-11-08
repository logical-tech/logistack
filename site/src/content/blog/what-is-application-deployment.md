---
title: "What is application deployment? The process, explained"
description: "What is application deployment: the steps from commit to production, the main strategies, where apps run, and how to make deploys boring."
date: 2026-11-08
category: Deployment
keywords: what is application deployment, application deployment process, deployment strategies, software deployment, app deployment
---

The code works on your laptop. Tests pass. Then it reaches a server and something is different: a missing variable, an older runtime, a migration that did not run. Application deployment is the discipline of closing that gap, so the version you tested is the version users get, every time.

This article explains what application deployment covers, the steps every deploy goes through, the strategies teams use to limit risk, and the places applications run in 2026.

## What is application deployment?

Application deployment is the process of taking a specific version of your software and making it run in a target environment, such as staging or production, with the configuration that environment needs.

Three ideas sit inside that sentence:

- **A specific version.** A deploy names an exact commit and an exact build artifact. "Whatever is on main" is not a version.
- **A target environment.** Production, staging, a preview for one pull request, a customer's server. Each has its own variables, secrets and domains.
- **Running, not copied.** Copying files is the easy part. A deploy is done when the new version is serving traffic and healthy.

### Deployment, release and delivery are different things

These words get mixed up. Keeping them apart helps when you design a pipeline.

| Term | What it means | Example |
| --- | --- | --- |
| Build | Turning source into an artifact | A Docker image tagged with the commit |
| Deployment | Running that artifact in an environment | The image replaces the old containers in production |
| Release | Exposing the change to users | A feature flag turns the new checkout on for 10% of users |
| Continuous delivery | Every change is deployable, a human presses the button | Merge to main builds and deploys to staging; production waits for approval |
| Continuous deployment | Every passing change goes to production on its own | Merge to main ships to users within minutes |

You can deploy without releasing (code is live but hidden behind a flag) and you can release without deploying (flip a flag on code that shipped last week). For the delivery side, see [continuous delivery vs continuous deployment](/blog/continuous-delivery-vs-continuous-deployment/).

## What gets deployed

The artifact depends on the kind of app:

- **Container images** for web apps, APIs and workers. This is the default today because the image carries its runtime and dependencies.
- **Static bundles** for sites built with Vite, Astro, Hugo or a framework's static export, served by a web server or a CDN.
- **Binaries or packages** for Go services, desktop apps, or software installed on customers' machines.
- **Functions** for serverless platforms, where the provider runs your code per request.
- **Schema changes** for the database, which deploy alongside the app and are often the riskiest part.

## The application deployment process, step by step

Every reliable deploy, whatever tool runs it, passes through the same stages.

### 1. Trigger

Something says "ship this": a merge to main, a version tag, a button, an API call from CI. The trigger must name the exact commit.

### 2. Build once

Turn the commit into an artifact and give it a unique, immutable name. For containers, that means a tag tied to the commit or deployment, never a moving tag like `latest`. Build once and promote the same artifact through staging and production, so what you tested is what you run.

### 3. Attach configuration

Configuration lives outside the artifact. The same image gets staging variables in staging and production variables in production. Secrets are injected at run time and never baked into image layers.

### 4. Prepare dependencies

Run what must happen before new code serves traffic, usually database migrations. Write migrations so the old version still works on the new schema, because for a few seconds or minutes both versions run.

### 5. Roll out

Start the new version, check it is healthy, move traffic to it, and stop the old version. How you move traffic is your deployment strategy (next section).

### 6. Verify

Watch error rates, latency and logs right after the rollout. Health checks catch crashes. Real verification catches the bug that returns HTTP 200 with the wrong data.

### 7. Roll back or roll forward

If something is wrong, go back to the previous artifact, or ship a fix quickly. Rolling back is only fast if the old artifact still exists and the database still accepts it.

## Deployment strategies

A strategy decides how traffic moves from the old version to the new one.

| Strategy | How it works | Downtime | Extra cost | Best for |
| --- | --- | --- | --- | --- |
| Recreate | Stop old, start new | Yes, short | None | Apps with a volume that cannot be shared, internal tools |
| Rolling | Replace instances one at a time, each health-checked | No | Little | Most stateless web apps and APIs |
| Blue-green | Run a full second copy, switch traffic at once | No | Double capacity during the switch | Releases that need an instant cut-back |
| Canary | Send a small share of traffic to the new version first | No | Routing and metrics work | High-traffic services where a bug is costly |
| Feature flags | Deploy code dark, enable per user or percentage | No | Flag service and cleanup discipline | Decoupling deploy from release |

Rolling updates with health checks cover most teams. They are what most platforms do by default and what [zero-downtime deployments](/blog/zero-downtime-deployments/) usually means in practice.

## Where applications get deployed

- **A single server you manage by hand.** Cheap and simple until the second app or the second person. Deploys tend to be SSH plus a script.
- **A managed PaaS.** Heroku, Render, Railway, Fly.io. You push, they run it. Easy, priced per app or usage.
- **A self-hosted PaaS.** The same workflow on your own servers. See [self-hosted PaaS](/blog/self-hosted-paas/).
- **Kubernetes.** Full control and a large ecosystem, with a matching operational load.
- **Serverless and edge.** Functions run per request. Great for spiky traffic, harder for long-lived connections and local state.

## Why deployments fail

Most failed deploys come from a short list:

- **Configuration drift.** Staging and production differ in a variable, a version or a feature flag.
- **Mutable artifacts.** The image tag that passed tests was overwritten before production pulled it.
- **Migrations that break the old version.** A dropped column takes down the instances still running the previous release.
- **No health check, or a shallow one.** The platform declares success while the app is still booting or failing every request.
- **Manual steps.** Someone forgot to run the migration, set the new secret, or clear the cache.
- **No rollback path.** The previous build was deleted, or rolling back means rebuilding from an old commit.

## How a platform handles the steps

The value of a deployment platform is that it does these steps the same way every time. As an example, here is what a deploy looks like in LogiStack, an open-source self-hosted PaaS:

1. A push to the branch, a matching tag or a published release triggers a deployment. It can wait for the commit's CI checks to pass first.
2. BuildKit builds the image from your Dockerfile, with Railpack, or as a static site, and tags it with the deployment ID.
3. An optional pre-deploy command runs on the new image, for example a migration. If it fails, the current version keeps serving.
4. Swarm starts each new replica, waits for its health check, then stops the old one. If new replicas fail, it rolls back on its own.
5. A rollback reruns an earlier deployment's image with no build.

The live log shows each step:

```text
==> cloning https://github.com/acme/storefront#main
==> commit 8f3c2a1 Add gift card balance to checkout
==> building registry.example.com/acme/web:dep_rtstor for linux/amd64 (dockerfile)
==> pushing registry.example.com/acme/web:dep_rtstor
==> deploying registry.example.com/acme/web:dep_rtstor
==> healthy
```

![The Deployments tab in LogiStack with the deployment list and the live build log](/docs/screens/service-deployments.webp)

Details are in the docs on [deployments and rollbacks](/docs/deploy/deployments/). For a hands-on walkthrough, read [how to deploy an application](/blog/how-to-deploy-an-application/).

## A short checklist for boring deploys

- Every deploy names a commit and an immutable artifact.
- Configuration and secrets live outside the artifact, per environment.
- Migrations are backward compatible with the previous release.
- Health checks test that the app answers, not just that the process exists.
- Rollback is one action and has been tried at least once.
- Deploys happen often, in small batches, so each one carries little risk.

## FAQ

### What is the difference between deployment and installation?

Installation puts software on a machine, often once and by hand. Deployment is the repeatable process of shipping new versions of a running service, including configuration, rollout and verification.

### How often should you deploy?

As often as you can do it safely. Small, frequent deploys are easier to verify and to roll back than large monthly ones. Teams with automated pipelines often deploy several times a day.

### What is a deployment pipeline?

The automated sequence that takes a commit through build, tests, deployment to staging and deployment to production. It is usually split between a CI system and a deployment platform. See [deployment automation](/blog/deployment-automation/).

### Is deploying a Docker container different from deploying code?

The steps are the same, but the artifact is a full image with its runtime. That removes "works on my machine" problems, because the same image runs everywhere.

If you want these steps handled for you on your own servers, LogiStack builds from Git or runs a Docker image, rolls out with health checks and rolls back without rebuilding. See the [features](/features/) or [install it](/#install).

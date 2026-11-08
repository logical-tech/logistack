---
title: "Best CI/CD tools in 2026: hosted, self-hosted and open source"
description: "The best CI/CD tools compared: GitHub Actions, GitLab CI, Jenkins, Buildkite, Woodpecker, Argo CD and more, with a table and a pick for each team."
date: 2026-11-08
category: Deployment
keywords: best ci/cd tools, ci/cd tools, continuous integration tools, continuous deployment tools, open source ci/cd
---

Picking from the best CI/CD tools is harder than it looks, because most lists mix two different jobs. One tool runs your tests on every commit. Another puts the result on a server. Some products do both, some do one well and the other badly, and the right choice depends on where your code lives, where it runs and who maintains the pipeline. This guide sorts the main options by what they actually do, then gives you a pick for each common situation.

## CI and CD are two jobs

Continuous integration (CI) answers "is this commit good?". It checks out the code, installs dependencies, runs tests and linters, and often builds an artifact such as a container image.

Continuous delivery and deployment (CD) answers "how does a good commit reach users?". It moves the artifact to an environment, runs migrations, rolls replicas over without downtime and rolls back when something breaks. The difference between delivering and deploying automatically is covered in [continuous delivery vs continuous deployment](/blog/continuous-delivery-vs-continuous-deployment/).

Most teams use a general-purpose CI system for the first job and something else for the second: a shell script, a GitOps controller, or a platform that deploys on push. Keep that split in mind as you read the list.

## What to judge a CI/CD tool on

- **Where it runs.** Fully hosted, hosted control plane with your own workers, or entirely on your servers.
- **How pipelines are defined.** YAML in the repository is the norm. Some tools use real code (Groovy, TypeScript, Go, Python), which helps once pipelines grow logic.
- **Container support.** Can a job run inside any image? Can it build images with BuildKit without a privileged Docker socket?
- **Caching.** Dependency and layer caches decide whether a build takes 40 seconds or 8 minutes.
- **Secrets and permissions.** Scoped secrets, short-lived cloud credentials (OIDC), protected branches and environments with approvals.
- **Cost model.** Per-minute billing, per-seat billing, or your own hardware.
- **Lock-in.** How much of your pipeline is portable if you move Git hosts.

## The best CI/CD tools, one by one

### GitHub Actions

The default if your code is on GitHub. Workflows are YAML files in `.github/workflows`, triggered by any repository event. Its strength is the marketplace: thousands of reusable actions for setup, caching, cloud logins and notifications. Hosted runners cover Linux, Windows, macOS and arm64, and you can attach your own machines as [self-hosted runners](/blog/self-hosted-github-actions-runners/).

Weak spots: debugging YAML expressions, third-party actions that you must pin and audit, and per-minute costs on private repositories once you outgrow the free allowance. It only works with GitHub.

### GitLab CI/CD

Built into GitLab, on gitlab.com or a self-managed instance. Pipelines live in `.gitlab-ci.yml` with stages, rules, `needs` for DAG ordering, and includes for shared templates. GitLab Runner is a single Go binary you can install anywhere, with Docker, Kubernetes and shell executors.

It is the most complete "one product" option: repository, CI, container registry, environments and review apps together. The cost is running and upgrading GitLab itself if you self-host, which is a real workload.

### Jenkins

The oldest tool on the list, MIT-licensed and written in Java. Pipelines are Groovy (`Jenkinsfile`), and the plugin ecosystem covers almost any integration. Jenkins still runs a huge share of enterprise builds because it can model anything.

That flexibility is also the problem. Plugins break on upgrades, the controller needs care, and security patches are frequent. Pick Jenkins when you inherit it or need something nothing else supports, not for a fresh start.

### CircleCI

A hosted CI service with fast Docker-based executors, good caching and reusable config packages called orbs. It also has a self-hosted server edition and self-hosted runners. CircleCI fits teams that want a dedicated CI product independent of their Git host.

### Buildkite

Buildkite splits the system in two: a hosted control plane that schedules and shows builds, and agents that run on your own machines. Pipelines can be generated dynamically by a script at build time, which suits large monorepos. Your code and secrets never leave your infrastructure, while you still get a managed dashboard.

### Woodpecker CI

A community fork of Drone, Apache 2.0 licensed and light enough for a small VPS. Every step runs in a container, pipelines are short YAML files, and it integrates with Gitea, Forgejo, GitHub, GitLab and Bitbucket. Woodpecker is a good match when you self-host your Git server and want CI that stays small.

### Forgejo Actions and Gitea Actions

Both Git servers ship a built-in CI with a syntax close to GitHub Actions. Jobs run on a separate runner process (forgejo-runner or act_runner, both derived from the `act` project), and many marketplace actions work unchanged. If you run Gitea or Forgejo yourself, this is the lowest-effort CI you can add.

### Dagger

Not a CI server but a way to write pipelines as code in Go, Python or TypeScript, executed by an engine built on BuildKit. The same pipeline runs on a laptop and inside any CI, which removes the "works in CI only" loop. Teams usually call Dagger from GitHub Actions or GitLab CI rather than replacing them.

### Argo CD and Flux

The two main GitOps controllers for Kubernetes. They watch a Git repository of manifests and reconcile the cluster to match. They do no CI at all: something else builds and tags the image, then updates the manifest. If you run Kubernetes, one of these is usually the CD half of your stack.

### Platforms that deploy on push

Heroku, Render, Railway and self-hosted PaaS tools build and deploy straight from a Git webhook. They replace the CD half, and sometimes the build, without a pipeline file. Your CI still runs tests; the platform waits for green checks and ships. The [best PaaS providers](/blog/best-paas-providers/) post compares the hosted ones.

## Comparison table

| Tool | Main job | Hosting | Pipeline format | License | Best for |
|---|---|---|---|---|---|
| GitHub Actions | CI, simple CD | Hosted, own runners optional | YAML | Proprietary (runner is MIT) | Code on GitHub |
| GitLab CI/CD | CI and CD | Hosted or self-managed | YAML | Open core | All-in-one on GitLab |
| Jenkins | CI and CD | Self-hosted | Groovy | MIT | Legacy and unusual needs |
| CircleCI | CI | Hosted or server | YAML | Proprietary | Dedicated hosted CI |
| Buildkite | CI and CD | Hosted control, own agents | YAML or generated | Proprietary (agent is MIT) | Large monorepos, private infra |
| Woodpecker | CI | Self-hosted | YAML | Apache 2.0 | Small self-hosted setups |
| Forgejo / Gitea Actions | CI | Self-hosted | GitHub-like YAML | GPL / MIT | Self-hosted Git |
| Dagger | Pipeline engine | Runs inside any CI | Go, Python, TS | Apache 2.0 | Portable pipelines |
| Argo CD / Flux | CD (GitOps) | In your Kubernetes | Kubernetes manifests | Apache 2.0 | Kubernetes clusters |

## Which CI/CD tool to pick

### You host code on GitHub and deploy a few services

Use GitHub Actions for tests. For deploys, either call your platform's API from a workflow or let the platform deploy on push after checks pass. A full walkthrough of the first option is in [deploy to a VPS with GitHub Actions](/blog/github-actions-deploy-to-vps/).

### You want everything on your own servers

Run Gitea or Forgejo with their built-in Actions, or add Woodpecker. Pair it with a self-hosted PaaS for deploys so you are not maintaining SSH scripts. The [GitHub Actions alternatives](/blog/github-actions-alternatives/) guide goes deeper on this path.

### You run Kubernetes

GitHub Actions or GitLab CI to build and push images, Argo CD or Flux to deploy them. This is the standard setup and both halves are well documented.

### You have a large monorepo and long builds

Buildkite with your own agents, or GitLab CI with well-tuned rules. Combine either with path filtering so a change to one app does not rebuild everything.

### You inherited Jenkins

Keep it running, freeze new plugin installs, and move new pipelines to something simpler one service at a time.

## Where LogiStack fits

LogiStack is a self-hosted PaaS, so it covers the CD half and the image build. It is not a test runner. Connect GitHub, GitLab, Gitea, Forgejo or Bitbucket, and each push builds the service with BuildKit and rolls it out without downtime. You can then:

- **Wait for your CI.** Turn on "Wait for CI checks to pass" and a deployment holds until the commit's checks succeed, up to a timeout you set. A failed check skips the deploy.
- **Deploy on tags or releases** instead of every push, with a glob such as `v*.*.*`.
- **Skip commits** with `[skip ci]` or `[skip deploy]` in the message.
- **Call the API from any CI** when your pipeline builds the image itself, using a service account key scoped to one service.

The trigger options are documented in [Git webhooks and deploys from CI](/docs/automation/git-webhooks/), and the build side in [build types](/docs/deploy/build-types/).

The honest trade-off: LogiStack runs on Docker Swarm, not Kubernetes, and it is a young project with a smaller community than the tools above. If your organization standardizes on Kubernetes, Argo CD or Flux is the better CD choice.

## FAQ

### What is the most popular CI/CD tool?

GitHub Actions has the widest use among new projects because it ships with GitHub. Jenkins still runs a large share of enterprise pipelines. GitLab CI is the common choice for teams on GitLab.

### Are there free open-source CI/CD tools?

Yes. Jenkins, Woodpecker, Forgejo Actions, Gitea Actions, Concourse, Argo CD and Flux are all open source. You pay with the servers and the time to maintain them.

### Do I need a separate CD tool if I use GitHub Actions?

Not always. A workflow can SSH into a server or call a deploy API. Once you have several services, health checks, rollbacks and previews, a GitOps controller or a PaaS usually replaces a growing pile of shell steps.

### Should CI build the Docker image or the platform?

Either works. Building in CI gives you one artifact you test and deploy. Letting the platform build keeps pipelines short. What matters is that each deploy gets an immutable tag so rollbacks run the exact image you tested.

LogiStack handles the deploy half of CI/CD on servers you own: builds on push, waits for your checks, rolls out without downtime and rolls back in one click. It is free and Apache 2.0. [Install it](/#install) on a VPS and point your first repository at it.

---
title: "GitHub Actions deploy to VPS: three working setups"
description: "Deploy to a VPS with GitHub Actions three ways: SSH and Docker Compose, a registry pull, or a deploy API. Full workflows, secrets and rollback included."
date: 2026-11-08
category: Deployment
keywords: github actions deploy to vps, github actions ssh deploy, deploy docker to vps, github actions docker compose, ci cd vps
---

You have a VPS, a repository on GitHub and an app that runs in Docker. Now you want every merge to `main` to reach the server without you typing `ssh` and `git pull`. A GitHub Actions deploy to a VPS is the usual answer, and there are three sensible ways to build it. This guide shows each one with a complete workflow, the server setup it needs, and where it stops being enough.

## Pick the shape of your pipeline first

| Setup | What CI does | What the server does | Downtime on deploy | Rollback |
|---|---|---|---|---|
| A. SSH and build on the server | Opens SSH, runs a script | Pulls code, builds, restarts | Short gap | Check out the old commit, rebuild |
| B. Build in CI, pull on the server | Builds and pushes an image | Pulls the tag, restarts | Short gap | Restart with the old tag |
| C. Build in CI, call a deploy API | Builds, pushes, calls an endpoint | A platform rolls it out | None with health checks | One click or one API call |

Setup A is the quickest to start. Setup B is the one most teams should run. Setup C is what B grows into once you want health-checked rollouts, previews and an audit trail without writing them yourself.

## Prepare the VPS

Do this once, whichever setup you choose. If the server is brand new, harden it first with the steps in [secure a new VPS](/blog/secure-a-new-vps/).

Create a user that only deploys:

```bash
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG docker deploy
sudo mkdir -p /srv/app && sudo chown deploy:deploy /srv/app
```

Membership of the `docker` group is effectively root on that machine. Accept that for a single-purpose server, or use a rootless Docker install for the deploy user.

Generate a dedicated key pair on your laptop. Never reuse your personal key:

```bash
ssh-keygen -t ed25519 -C "github-actions" -f ./gha_deploy -N ""
```

Append `gha_deploy.pub` to `/home/deploy/.ssh/authorized_keys` on the server. Then record the server's host key so the workflow can verify it instead of trusting whatever answers:

```bash
ssh-keyscan -t ed25519 your.server.ip
```

In the repository, open **Settings › Secrets and variables › Actions** and add:

- `VPS_HOST`: the IP or hostname
- `VPS_SSH_KEY`: the contents of `gha_deploy` (the private key)
- `VPS_KNOWN_HOSTS`: the `ssh-keyscan` output line

Put these in a GitHub **environment** called `production` rather than at repository level. Environments let you require a reviewer before a job that uses them can start, and restrict which branches can deploy.

## Setup A: SSH in and build on the server

The workflow connects, pulls the code and rebuilds with Docker Compose.

```yaml
# .github/workflows/deploy.yml
name: Deploy
on:
  push:
    branches: [main]

concurrency:
  group: production
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - name: Configure SSH
        run: |
          install -m 700 -d ~/.ssh
          echo "${{ secrets.VPS_SSH_KEY }}" > ~/.ssh/id_ed25519
          chmod 600 ~/.ssh/id_ed25519
          echo "${{ secrets.VPS_KNOWN_HOSTS }}" > ~/.ssh/known_hosts

      - name: Pull and rebuild
        run: |
          ssh deploy@${{ secrets.VPS_HOST }} <<'EOF'
            set -euo pipefail
            cd /srv/app
            git fetch --quiet origin main
            git reset --hard origin/main
            docker compose up -d --build --remove-orphans
            docker image prune -f
          EOF
```

The server needs read access to the repository: add a read-only deploy key on GitHub for the server's own key pair, and clone once into `/srv/app`.

`concurrency` makes sure two pushes never deploy at the same time. Without it, a quick second merge can interleave with the first and leave the server half updated.

**Where it breaks.** The VPS builds the image, so a heavy build competes with the running app for CPU and memory. Rollback means checking out an older commit and building again. And `docker compose up` stops the old container before the new one is ready, so users see errors for a few seconds.

## Setup B: build in CI, pull on the server

Move the build to GitHub's runners, push an image tagged with the commit SHA, and let the server only pull and restart. The compose file on the server reads the tag from an environment variable:

```yaml
# /srv/app/compose.yaml
services:
  web:
    image: ghcr.io/acme/storefront:${TAG:?set TAG}
    restart: unless-stopped
    env_file: .env
    ports:
      - "127.0.0.1:3000:3000"
```

Binding to `127.0.0.1` keeps the app off the public interface; a reverse proxy such as Caddy terminates TLS in front of it. The [Caddy explainer](/blog/what-is-caddy/) covers that part.

The workflow:

```yaml
# .github/workflows/deploy.yml
name: Build and deploy
on:
  push:
    branches: [main]

permissions:
  contents: read
  packages: write

concurrency:
  group: production
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ghcr.io/acme/storefront:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment: production
    steps:
      - name: Configure SSH
        run: |
          install -m 700 -d ~/.ssh
          echo "${{ secrets.VPS_SSH_KEY }}" > ~/.ssh/id_ed25519
          chmod 600 ~/.ssh/id_ed25519
          echo "${{ secrets.VPS_KNOWN_HOSTS }}" > ~/.ssh/known_hosts

      - name: Pull and restart
        run: |
          ssh deploy@${{ secrets.VPS_HOST }} "cd /srv/app && \
            echo TAG=${{ github.sha }} > .tag && \
            TAG=${{ github.sha }} docker compose pull && \
            TAG=${{ github.sha }} docker compose up -d && \
            docker image prune -f"
```

If the package is private, log the server in to GHCR once with a personal access token that has only `read:packages`:

```bash
echo "$TOKEN" | docker login ghcr.io -u your-user --password-stdin
```

The `cache-from` and `cache-to` lines keep BuildKit's layer cache between runs, which often turns a five-minute build into a one-minute build. The [Docker build best practices](/blog/docker-build-best-practices/) post explains how to order a Dockerfile so that cache actually hits.

**Rollback** is now cheap: run the same `compose up` with an earlier SHA. The `.tag` file records what is live, so you can see it after a reboot.

**What is still missing.** There is still a gap while the container restarts. There is no health check that stops a broken image from replacing a working one. Migrations need their own step, and you are one `rm` away from losing track of which SHA ran when. The [zero-downtime deployments](/blog/zero-downtime-deployments/) guide shows what it takes to close the gap by hand.

## Setup C: build in CI, deploy through an API

The third shape keeps the CI half of setup B and hands the rollout to a platform that already does health checks, start-first updates and rollbacks. Your workflow builds and pushes the image, then makes one authenticated HTTP call. No SSH key on GitHub, no shell access to the server.

With LogiStack, that call is `POST /api/services/{id}/deploy`, authenticated by an API key that belongs to a service account limited to that one service. The LogiStack docs carry a complete workflow that builds to GHCR, points the service at the new tag, deploys and polls until the deployment is healthy. Rather than repeat it here, use the version in [Git webhooks and deploys from CI](/docs/automation/git-webhooks/). The [deployment automation](/blog/deployment-automation/) post walks through the same pattern in more depth.

What you get on the server side:

- **Rolling updates.** A stateless service starts the new replica, waits for its health check, then stops the old one. If a new replica fails within the watch window, Swarm rolls back on its own and the old version keeps serving.
- **Pre-deploy commands** for migrations, run once on the new image before any replica is replaced.
- **Immutable tags.** Each deployment has its own image tag, so **Roll back to this** reruns exactly the image that ran before.
- **A log per deployment**, visible in the dashboard, with the trigger that started it.

![The Deployments tab listing each deployment with its trigger, commit and status](/docs/screens/service-deployments.webp)

### Or skip the workflow entirely

If GitHub Actions only exists to deploy, you may not need it for that at all. Connect the repository to LogiStack through its GitHub App and every push builds and deploys on your own server, with BuildKit. Keep Actions for tests and turn on **Wait for CI checks to pass**: the deployment holds until the commit's checks succeed and is skipped if they fail. See [deploy from Git](/docs/deploy/from-git/).

## Secure the pipeline

Whichever setup you run:

- **Pin third-party actions** to a full commit SHA, not a tag, so a compromised tag cannot change what runs with your secrets.
- **Use environments with required reviewers** for production. A merge then waits for a human before the deploy job starts.
- **Scope tokens.** `permissions:` at the top of the workflow should grant only what the jobs use. The server's registry token needs read, never write.
- **Restrict the SSH key.** Prefix the key in `authorized_keys` with `from="..."` options or a forced `command=` that runs only your deploy script.
- **Never echo secrets.** GitHub masks known secret values in logs, but derived values such as a base64-encoded key are not masked.

## FAQ

### Can GitHub Actions deploy to a VPS for free?

Public repositories get hosted runner minutes for free, and private repositories get a monthly allowance that a small app rarely exceeds. Check GitHub's billing page for the current numbers. The VPS is your only fixed cost.

### Should I use an SSH action from the marketplace?

You can, but plain `ssh` with a known_hosts entry is fewer moving parts and one less third-party action holding your private key. If you use one, pin it to a commit SHA.

### How do I run database migrations during a deploy?

Run them in a separate step before restarting the app, with the new image: `docker compose run --rm web npm run migrate`. Keep migrations backward compatible so the old version still works if you roll back.

### How do I avoid downtime with Docker Compose?

Compose alone recreates containers, so there is always a gap. You need two copies behind a proxy and a health check before switching, which is what Swarm's start-first updates or a PaaS give you.

### Is it safe to store an SSH private key in GitHub secrets?

Reasonably, if the key belongs to a deploy-only user, is restricted on the server, and lives in a protected environment. An API key scoped to one service is safer still, because it cannot open a shell.

When the SSH script starts collecting health checks, rollbacks and migration steps, that is the point to hand the server side to a platform. LogiStack does that part on your own VPS: builds on push or from your CI, rolls out without downtime and keeps every deployment one click from a rollback. It is free and open source, so you can [install it](/#install) next to the setup you have now and move one app at a time.

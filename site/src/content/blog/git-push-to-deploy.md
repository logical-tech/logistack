---
title: "Git push to deploy: four ways to ship on every push"
description: "Git push to deploy explained: Heroku-style remotes, post-receive hooks, webhooks and CI pipelines, with working setups and the trade-offs of each."
date: 2026-11-08
category: Deployment
keywords: git push to deploy, push to deploy, deploy on git push, git post-receive hook deploy, heroku git push
---

Git push to deploy is the workflow Heroku made famous: you run `git push`, and a minute later the new version is live. No SSH session, no copy step, no checklist. It is still the fastest feedback loop a small team can have. There are four common ways to build it, from a twenty-line hook on a bare repository to a platform that listens for webhooks. They differ in where the build runs, what happens when it fails and how you roll back.

## The four shapes

| Approach | You push to | Build runs on | Rollback | Best for |
|---|---|---|---|---|
| Git remote on the server | The server itself | The server | Manual | One app, one box |
| Heroku-style PaaS remote | The platform's Git endpoint | The platform | Built in | Small teams, no Docker files |
| Webhook from your Git host | GitHub, GitLab, Gitea... | The platform or server | Built in on platforms | Teams with code review |
| CI pipeline | Your Git host | CI runners | Depends on the script | Teams with test gates |

All four share one property: the Git history is the deploy history. What differs is how much safety sits between the push and the live site.

## 1. A bare repository with a post-receive hook

The do-it-yourself version. The server holds a bare Git repository, and a hook runs after every push to it.

On the server:

```bash
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG docker deploy
sudo -iu deploy
git init --bare ~/app.git
mkdir -p ~/app
```

Create the hook at `~/app.git/hooks/post-receive`:

```bash
#!/usr/bin/env bash
set -euo pipefail

TARGET="$HOME/app"
GIT_DIR="$HOME/app.git"

while read -r oldrev newrev ref; do
  [ "$ref" = "refs/heads/main" ] || continue

  echo "==> checking out ${newrev:0:7}"
  git --work-tree="$TARGET" --git-dir="$GIT_DIR" checkout -f main

  echo "==> building and restarting"
  cd "$TARGET"
  docker compose up -d --build --remove-orphans
  echo "==> done"
done
```

```bash
chmod +x ~/app.git/hooks/post-receive
```

On your machine, add the server as a remote and push:

```bash
git remote add production deploy@203.0.113.10:app.git
git push production main
```

The hook's output streams back into your terminal, which feels great. The weaknesses show up later:

- The build runs on the production server and competes with live traffic.
- `docker compose up` replaces the container, so there is a short gap. If the new build fails at runtime, the site is down until you fix it.
- Rollback means pushing an older commit, which rebuilds it.
- Anyone with SSH access can deploy, and there is no review step or record of who deployed what.

It is a reasonable setup for a personal project on a single VPS. It does not scale to a team. Secure the server first with the steps in [secure a new VPS](/blog/secure-a-new-vps/).

## 2. A platform that accepts git push

Heroku, Dokku and some self-hosted tools expose a Git endpoint. You add it as a remote, push, and the platform detects the language with buildpacks or reads your Dockerfile, builds an image and runs it.

```bash
git remote add dokku dokku@203.0.113.10:storefront
git push dokku main
```

Compared with a raw hook, the platform adds build isolation, health checks, release phases and rollbacks. The model is still "push to the server": the deploy happens on your push, outside your Git host's review flow, and every developer who deploys needs a key on the platform. The [Dokku alternatives](/blog/dokku-alternatives/) post covers tools in this family.

## 3. Webhooks from your Git host

Here you push to GitHub, GitLab, Gitea, Forgejo or Bitbucket as usual. The Git host sends a webhook to your deploy platform, which fetches that commit, builds it and rolls it out.

This is the model most teams end up on, for three reasons:

- **Review stays in one place.** You merge a pull request, and the merge is the deploy. Branch protection decides who can deploy.
- **No deploy keys on laptops.** Developers only need access to the Git host.
- **The platform can wait.** Because it receives events instead of a direct push, it can hold a deployment until CI checks pass, or deploy only on tags.

### How LogiStack does it

LogiStack is webhook-based. You connect a Git provider once: GitHub through a GitHub App the setup wizard creates, or GitLab, Gitea, Forgejo and Bitbucket with an access token. When you create a service from a repository, LogiStack registers the push webhook for you and starts the first deployment. Each later push to the branch builds the image with BuildKit, pushes it with a tag named after the deployment, and rolls it out replica by replica.

Deploy triggers on each service decide what a push does:

- **Deploy on pushes** to the branch, narrowed by **watch paths** so a push only deploys when it touches files the service uses.
- **Deploy on tags** matching a glob like `v*.*.*`, or on **published releases**.
- **Wait for CI checks to pass**, with a timeout from 1 to 720 minutes. A failing check skips the deployment.
- **Skip markers**: `[skip ci]`, `[ci skip]` or `[skip deploy]` in the commit message stop a deploy.

Every held-back push still appears in the **Deployments** tab as **Skipped**, with the reason. On GitHub, each deployment also reports back as a commit status. The full reference is in [Git webhooks and deploys from CI](/docs/automation/git-webhooks/), and the setup in [deploy from Git](/docs/deploy/from-git/).

![The Deployments tab listing each deployment with its trigger, commit and status](/docs/screens/service-deployments.webp)

LogiStack has no `git push logistack main` remote. If you want the push itself to go to the server, Dokku is the closer fit. For any Git host LogiStack cannot receive webhooks from, a CI job or script can call the deploy API instead.

## 4. A CI pipeline that deploys

The fourth shape puts a CI system in the middle. A push triggers a workflow that tests, builds and pushes an image, then deploys it, either over SSH or through an API. You get full control and a place for any gate you want, at the cost of writing and maintaining the pipeline.

This is the right choice when your deploy needs steps a platform does not model, such as a signed artifact, a compliance check or a multi-region rollout. For a complete walkthrough on a single server, see [deploy to a VPS with GitHub Actions](/blog/github-actions-deploy-to-vps/). For the bigger picture of where to automate first, see [deployment automation](/blog/deployment-automation/).

## What makes push to deploy safe

The approach matters less than these properties. Check your setup against them:

1. **Every deploy is an immutable artifact.** Build once, tag it with the commit SHA or a deployment id, and never reuse the tag. Rolling back then means running an old image, not rebuilding old code.
2. **Health checks before traffic.** The new version must answer on its health endpoint before the old one stops. Otherwise a crash on startup is an outage.
3. **Automatic rollback on failure.** If the new version fails during the rollout, the old one keeps running.
4. **Migrations run once, before the rollout**, and stay compatible with the version still running.
5. **One deploy at a time per service.** A burst of pushes should build the newest commit, not race each other. LogiStack, for example, marks older queued deployments as superseded.
6. **A visible history.** Who deployed which commit, when, and what the log said.
7. **A way to stop.** Cancel a running build, or turn a trigger off during an incident.

A raw post-receive hook gives you none of these without extra work. A platform gives you most of them by default. A CI pipeline gives you exactly what you script.

## Push to deploy for production: a sensible default

For a team shipping a web app to its own servers, a good default looks like this:

- `main` is protected. Changes land through pull requests with at least one review.
- CI runs tests on every pull request and on `main`.
- The platform deploys `main` on push, waiting for CI checks to pass.
- Each pull request gets a preview environment, so reviewers see the change running before the merge.
- Staging deploys on every push; production deploys on tags, if you want a manual release step. The trade-off between the two is covered in [continuous delivery vs continuous deployment](/blog/continuous-delivery-vs-continuous-deployment/).

## FAQ

### What does git push to deploy mean?

It means pushing a commit is the only thing you do to release it. A hook, webhook or pipeline picks up the push, builds the code and replaces the running version, with no manual steps on the server.

### Is git push to deploy safe for production?

Yes, if each deploy is health-checked, rolls back automatically on failure and is gated by code review or CI. A bare hook that rebuilds on the live server is fine for side projects but not for production traffic.

### How do I set up git push to deploy on a VPS?

The quickest way is a bare Git repository with a post-receive hook that checks out the code and runs `docker compose up -d --build`. For health checks and rollbacks, install a self-hosted PaaS that deploys on webhooks from your Git host.

### Can I deploy only when tests pass?

Yes. Run tests in CI and configure the deploy side to wait for the commit's checks, or deploy from the CI pipeline after the test job succeeds.

### How do I roll back after a bad push?

On a platform with immutable image tags, redeploy the previous image in one step. With a raw hook, push a revert commit or check out the previous commit and rebuild, which takes as long as a normal build.

LogiStack gives you push to deploy on your own servers, with health-checked rolling updates, CI check gates, tag triggers and one-click rollbacks, and no feature behind a paid plan. [Install it](/#install) on a VPS and connect your first repository.

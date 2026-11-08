---
title: "Deployment automation: from manual runbook to push-to-deploy"
description: "Deployment automation explained: what to automate first, how push and pull pipelines differ, safety gates that matter, and a working CI example."
date: 2026-11-08
category: Deployment
keywords: deployment automation, automated deployment, ci/cd pipeline, gitops, deploy on push
---

Somewhere in your team there is a document called something like `DEPLOY.md`. It has twelve steps, two of them are out of date, and only one person runs it without mistakes. Deployment automation replaces that document with a pipeline that runs the same steps the same way every time, triggered by an event instead of a person.

This guide explains what to automate, in what order, how the common pipeline designs differ, and which safety gates are worth the effort. It ends with a working example you can copy.

## What is deployment automation?

Deployment automation is the practice of moving a change from version control to a running environment with no manual steps. A trigger, such as a merge or a tag, starts a pipeline. The pipeline builds an artifact, checks it, deploys it, verifies it and records what happened.

It is one part of a larger picture:

- **Continuous integration** builds and tests every change.
- **Deployment automation** gets a tested artifact running in an environment.
- **Release management** decides when users see the change, often with feature flags.

The difference between continuous delivery and continuous deployment is only whether a human approves the last step. See [continuous delivery vs continuous deployment](/blog/continuous-delivery-vs-continuous-deployment/).

## Why automate deployments

- **Fewer mistakes.** Machines do not skip step seven.
- **Smaller changes.** When deploying is cheap, people ship small batches, and small batches are easier to debug.
- **Faster recovery.** A rollback is the same pipeline pointed at an older artifact.
- **A record.** Every deploy has a log, a commit, an actor and a timestamp.
- **No single point of knowledge.** Anyone with permission can ship, and nobody needs SSH to production.

The DORA research program measures delivery performance with four metrics: deployment frequency, lead time for changes, change failure rate and time to restore service. Automation moves all four in the right direction.

## What to automate, in order

You do not need everything on day one. Each level below is useful on its own and makes the next one easier.

| Level | What is automated | What a human still does |
| --- | --- | --- |
| 0. Runbook | Nothing | Everything, from a checklist |
| 1. One-command deploy | Build and rollout from a script | Runs the script, checks the result |
| 2. Deploy on push | Trigger, build, rollout on merge to main | Watches for problems |
| 3. Gated pipeline | Tests, CI checks, migrations, health checks before traffic moves | Approves production, if you choose |
| 4. Full lifecycle | Preview environments per pull request, automatic rollback, alerts, config as code | Reviews code and config changes |

Most teams get the biggest return from level 0 to level 2. Level 3 is where deploys become boring. Level 4 is where reviewers click a preview link instead of pulling a branch.

## The building blocks

### A trigger

A push to a branch, a version tag, a published release, or an API call from another system. Pick one per environment: for example, merges to `main` deploy staging and tags `v*.*.*` deploy production.

### An immutable artifact

Build once, tag it uniquely (commit SHA or deployment ID), and promote the same artifact through environments. Never rebuild for production, and never deploy a moving tag like `latest`.

### Configuration outside the artifact

Each environment supplies its own variables and secrets at run time. The image never contains a production secret.

### Gates

Checks that must pass before traffic moves: tests in CI, a migration that succeeds, a health check on the new instances.

### A rollout strategy

Usually a rolling update with health checks. Blue-green and canary releases add safety for high-traffic services at the cost of more setup. See [zero-downtime deployments](/blog/zero-downtime-deployments/).

### Verification and rollback

Health checks, logs, metrics and alerts after the rollout, plus a rollback path that does not depend on a fresh build.

## Push-based vs pull-based pipelines

There are two broad designs for getting a change into an environment.

**Push-based.** The CI system, or the deployment platform's webhook, actively tells the target to deploy. GitHub Actions calling an API, a Git push webhook, or a script that runs `docker service update` are all push-based. They are simple to understand and easy to debug.

**Pull-based (GitOps).** An agent inside the target environment watches a Git repository that describes the desired state and pulls changes when it differs. Argo CD and Flux do this for Kubernetes. The repository becomes the single source of truth, and drift is corrected automatically.

| Aspect | Push-based | Pull-based (GitOps) |
| --- | --- | --- |
| Who starts the deploy | CI or a webhook | An agent in the cluster |
| Credentials | CI holds a deploy key or API token | The cluster holds read access to Git |
| Drift correction | Only on the next deploy | Continuous |
| Typical tools | GitHub Actions, GitLab CI, platform webhooks | Argo CD, Flux |
| Complexity | Low | Higher, especially outside Kubernetes |

The two ideas mix well. A platform that stores desired state and reconciles toward it gives you drift correction, while a push from CI still decides when a new version ships.

## Safety gates worth having

- **Wait for CI.** Do not deploy a commit whose checks failed or have not finished.
- **Pre-deploy migrations with a fail-safe.** If the migration fails, the deploy stops and the old version keeps serving.
- **Health-checked rollout.** New instances must answer before old ones stop.
- **Automatic rollback on failed rollout.** If new instances keep failing, revert without waiting for a human.
- **Skip markers.** A commit that only changes documentation should not trigger a production deploy. Watch paths and `[skip deploy]` messages handle this.
- **One deploy at a time per service.** When five pushes land in a minute, build the newest and drop the rest.
- **Review before apply.** Show a diff of pending configuration changes, with secrets hidden, before they go live.

## Environments and previews

Automation pays off most when environments are cheap. A typical flow:

1. A pull request opens a **preview environment** with its own URL, cloned from staging, with empty databases.
2. A merge to `main` deploys **staging**.
3. A tag deploys **production**, after checks pass.

Each environment differs only in its variables. Read more in [staging environment](/blog/staging-environment/) and [preview environments](/blog/preview-environments/).

## Example: build in CI, deploy through an API

When your CI already builds images, let it push the image and tell the platform to run it. This GitHub Actions workflow builds an image tagged with the commit SHA, pushes it to GitHub Container Registry, points a LogiStack service at it, deploys, and waits for the result.

```yaml
name: Build and deploy
on:
  push:
    branches: [main]

permissions:
  contents: read
  packages: write

concurrency:
  group: deploy-production
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      IMAGE: ghcr.io/${{ github.repository }}:${{ github.sha }}
      LOGISTACK_URL: ${{ vars.LOGISTACK_URL }}
      SERVICE_ID: ${{ vars.LOGISTACK_SERVICE_ID }}
      LOGISTACK_API_KEY: ${{ secrets.LOGISTACK_API_KEY }}
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ env.IMAGE }}
      - name: Point the service at the new image
        run: |
          curl -fsS -H "x-api-key: $LOGISTACK_API_KEY" "$LOGISTACK_URL/api/services/$SERVICE_ID" \
            | jq --arg image "$IMAGE" '{spec: (.spec | .source.image = $image)}' > patch.json
          curl -fsS -X PATCH "$LOGISTACK_URL/api/services/$SERVICE_ID" \
            -H "x-api-key: $LOGISTACK_API_KEY" -H "content-type: application/json" \
            --data @patch.json > /dev/null
      - name: Deploy and wait
        timeout-minutes: 15
        run: |
          id=$(curl -fsS -X POST -H "x-api-key: $LOGISTACK_API_KEY" \
            "$LOGISTACK_URL/api/services/$SERVICE_ID/deploy" | jq -r .id)
          while :; do
            status=$(curl -fsS -H "x-api-key: $LOGISTACK_API_KEY" \
              "$LOGISTACK_URL/api/deployments/$id" | jq -r .status)
            echo "status: $status"
            case $status in
              healthy) exit 0 ;;
              failed|cancelled|superseded|skipped) exit 1 ;;
            esac
            sleep 5
          done
```

Give the API key to a service account, not a person, and limit it to that one service with the Developer role, which can deploy but cannot read secrets. The [Git webhooks and CI docs](/docs/automation/git-webhooks/) cover this flow and the push-webhook alternative.

If you do not want CI to build at all, connect the repository instead: every push builds the image on your server, waits for CI checks if you ask it to, runs the pre-deploy command and rolls out with health checks.

## Automate the configuration too

Code is only half of a deployment. Domains, variables, replicas and backup policies drift when people change them by hand. Keep them in Git as well. LogiStack can export a project as a YAML manifest and apply it from CI with a dry run first; apply is idempotent, so running the same file twice changes nothing. See [project manifests](/docs/automation/project-manifests/).

## Common pitfalls

- **Automating a broken process.** If the manual deploy needs a person to fix a file by hand, the pipeline will fail at the same step. Fix the process first.
- **Shared credentials.** One admin token in every pipeline means one leak exposes everything. Use scoped, expiring keys per pipeline.
- **No ownership of failures.** A red pipeline that nobody watches is worse than no pipeline. Route failures to a channel people read.
- **Tests that take an hour.** Slow gates push people to bypass them. Keep the deploy-blocking suite fast.
- **Rollback never tested.** Run one on purpose, in staging, before you need it in production.

## FAQ

### What is the difference between CI/CD and deployment automation?

CI/CD is the whole pipeline from commit to production. Deployment automation is the part that takes a built and tested artifact and runs it in an environment, including rollout, verification and rollback.

### Do I need Kubernetes for automated deployments?

No. Any platform with an API or webhooks can be automated. Docker Swarm, a PaaS or a set of servers with a deploy tool all work. Kubernetes adds options like GitOps controllers, at a higher operational cost.

### Should production deploy automatically on merge?

If your tests and health checks are good, yes: small automatic deploys are safer than large manual ones. Many teams start with automatic staging and a manual or tag-based production step, then remove the manual step once they trust the pipeline.

### Which tools do I need?

Usually two: a CI system for tests, and a platform that builds, runs and rolls back. We compare the options in [software deployment tools](/blog/software-deployment-tools/).

LogiStack gives you the deploy half of the pipeline on your own servers: deploy on push, wait for CI checks, pre-deploy migrations, health-checked rollouts, rollbacks without rebuilds, a REST API and scoped service accounts for CI. See [all features](/features/).

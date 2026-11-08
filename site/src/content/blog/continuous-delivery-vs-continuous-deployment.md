---
title: "Continuous delivery vs continuous deployment explained"
description: "Continuous delivery vs continuous deployment: how the two practices differ, what each one needs, and how to choose the right one for your team."
date: 2026-11-08
category: Deployment
keywords: continuous delivery vs continuous deployment, continuous delivery, continuous deployment, ci/cd pipeline, release automation
---

Your pipeline builds and tests every commit, yet releases still happen on Thursday afternoons after someone clicks a button and holds their breath. Is that continuous delivery or continuous deployment? The difference between continuous delivery vs continuous deployment comes down to one question: when a commit passes every check, does a human decide when it reaches users, or does the pipeline? This post explains both practices, what each one demands from your code and your tooling, and how to pick the one that fits your team today.

## The short answer

Both practices start the same way. Every change merges into a main branch often, an automated pipeline builds it, runs the tests and produces an artifact that could go to production.

- **Continuous delivery** stops there. The artifact is ready, and a person chooses when to release it.
- **Continuous deployment** goes one step further. If every check passes, the artifact goes to production with no human in the loop.

So continuous deployment is continuous delivery with the final approval automated away. You cannot have the second without the first.

| | Continuous delivery | Continuous deployment |
|---|---|---|
| Who triggers the production release | A person | The pipeline |
| Every passing commit is releasable | Yes | Yes |
| Every passing commit is released | No | Yes |
| Typical release cadence | Daily to weekly | Many times a day |
| Main safety net | Human review before release | Automated tests, health checks, fast rollback |
| Good fit for | Regulated work, coordinated launches, young test suites | Web apps and APIs with strong test coverage |

## Where continuous integration fits

Continuous integration (CI) is the base layer under both. Developers merge small changes often, and every merge triggers a build and a test run. CI answers "does this commit work?". Delivery and deployment answer "how does a working commit reach users?".

A typical flow looks like this:

1. A developer pushes a branch and opens a pull request.
2. CI builds the code and runs unit and integration tests.
3. Reviewers approve, and the branch merges into `main`.
4. The pipeline builds a release artifact, usually a container image, and tags it.
5. The artifact goes to a staging or preview environment for a final check.
6. Production release: manual (delivery) or automatic (deployment).

Steps 1 to 5 are identical in both models. Only step 6 changes.

## What continuous delivery looks like in practice

With continuous delivery, `main` is always in a state you could ship. The release itself is a decision, not an engineering project. Someone presses **Deploy**, picks a tag, or merges a release pull request, and the same automation that built staging pushes the change to production.

This works well when:

- **Releases need coordination.** A marketing launch, a partner integration or an app-store submission sets the date, not the merge.
- **Compliance asks for a sign-off.** Some audits want a named person to approve each production change. A manual gate gives you that record.
- **Your tests are still growing.** If you don't trust the suite to catch a broken checkout flow, a human look at staging is cheap insurance.
- **Database changes are risky.** Teams often want a person watching when a migration touches a large table.

The cost is latency. Changes queue up between releases, and bigger batches are harder to debug when something breaks. If ten commits ship together and errors spike, you have ten suspects instead of one.

## What continuous deployment looks like in practice

With continuous deployment, merging is releasing. A commit that passes CI rolls out to production within minutes. Nobody schedules releases, because there is nothing to schedule.

This works well when:

- **Your test suite catches real regressions.** You need tests that fail on the bugs users would notice, not only on syntax errors.
- **Rollouts are safe by default.** New versions must start, pass a health check and take traffic before the old version stops. See [zero-downtime deployments](/blog/zero-downtime-deployments/) for how that works.
- **Rollback is fast and boring.** If a bad change slips through, going back to the previous image should take one action and no rebuild.
- **Unfinished work hides behind feature flags.** Code can ship dark and turn on later, so the deploy schedule and the launch schedule split apart.

The payoff is small batches. Each deploy carries one change, so when a metric moves you know exactly which commit did it.

## Continuous delivery vs continuous deployment: how to choose

Don't pick based on what sounds more advanced. Pick based on what your safety nets can carry.

### Start with continuous delivery if

- You can't yet say which tests would catch a broken login.
- Production incidents usually need someone to SSH into a server to fix.
- Rollback means rebuilding an old commit.
- Someone outside engineering owns the release date.

### Move to continuous deployment when

- A failed health check stops a rollout on its own, and the previous version keeps serving.
- Rolling back takes seconds and doesn't depend on the person who wrote the change.
- You watch error rates and latency after each deploy, and alerts reach the team.
- Your team already merges small pull requests several times a day.

Many teams run both at once: continuous deployment for stateless web services, continuous delivery with a manual gate for the database or a payment service. The choice can be per service, not per company.

## The building blocks you need either way

Whichever model you run, the same pieces carry the load.

### Immutable, traceable artifacts

Build once, deploy the same artifact everywhere. If staging and production run different builds of the same commit, staging proves nothing. Tag images with something unique per build, such as the commit SHA or a deployment ID, never `:latest`.

### An environment that mirrors production

A [staging environment](/blog/staging-environment/) or a per-pull-request [preview environment](/blog/preview-environments/) catches what unit tests miss: wrong environment variables, a missing migration, a broken redirect.

### Gates that read CI results

The deploy step should know whether tests passed. A deploy that starts while CI is still red defeats the point.

### Health checks and automatic rollback

The platform, not a person, should decide whether a new version is healthy. If it isn't, the old version should keep serving.

### One-click rollback

Every release should be reversible to the exact previous image, without a rebuild.

## Example: a GitHub Actions pipeline for each model

Here is a continuous deployment pipeline. Every push to `main` builds an image tagged with the commit SHA and asks the platform to deploy it.

```yaml
name: Deploy on merge
on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm test

  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - name: Trigger the deployment
        run: |
          curl -fsS -X POST -H "x-api-key: ${{ secrets.LOGISTACK_API_KEY }}" \
            "${{ vars.LOGISTACK_URL }}/api/services/${{ vars.SERVICE_ID }}/deploy"
```

To turn this into continuous delivery, change the trigger and add a manual approval. In GitHub, a protected environment with required reviewers pauses the job until someone approves:

```yaml
on:
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production   # requires a reviewer in the repo settings
    steps:
      - run: |
          curl -fsS -X POST -H "x-api-key: ${{ secrets.LOGISTACK_API_KEY }}" \
            "${{ vars.LOGISTACK_URL }}/api/services/${{ vars.SERVICE_ID }}/deploy"
```

The build and test steps don't change. Only the trigger does, which is the whole difference between the two practices.

## How LogiStack supports both models

LogiStack is an open-source, self-hosted PaaS, so the deploy step runs on your own servers. It gives you the pieces above without stitching tools together.

**For continuous deployment**, connect a Git provider and LogiStack registers the push webhook for you. Each push to the service's branch queues a deployment. You can narrow what triggers a deploy:

- **Watch paths** skip a deploy when a commit touches nothing the service uses, which matters in a monorepo.
- **Wait for CI checks to pass** holds a deployment until the commit's checks succeed, and skips it if they fail or time out.
- A commit message with `[skip ci]`, `[ci skip]` or `[skip deploy]` never deploys.

See [Git webhooks and deploys from CI](/docs/automation/git-webhooks/) for the full rules.

**For continuous delivery**, you have three options:

- Deploy on **tags matching a pattern**, such as `v*.*.*`, or on **published releases**. Cutting a release becomes the approval.
- Leave triggers off and press **Deploy** in the dashboard.
- Let your own CI call `POST /api/services/{id}/deploy` after its approval step, with an API key owned by a [service account](/docs/team/service-accounts/).

Either way, each Git build gets an image tag based on its deployment ID, so a rollback runs exactly the image it ran before. Settings you change wait as a pending diff under **Review changes** until the next deploy, so configuration changes go through the same release step as code.

![The Deployments tab with a list of deployments and the live build log of the selected one](/docs/screens/service-deployments.webp)

## FAQ

### Is continuous deployment better than continuous delivery?

Not by default. Continuous deployment ships smaller changes faster, but only works if your tests, health checks and rollback can catch problems without a person. Continuous delivery is the right call when a release needs coordination or sign-off.

### Can I use continuous deployment for some services and delivery for others?

Yes, and many teams do. Stateless web apps often deploy on every merge, while services with risky database migrations keep a manual gate. In LogiStack, deploy triggers are set per service.

### Does continuous deployment mean no code review?

No. Review happens before merge, in the pull request. Continuous deployment removes the manual step after merge, not the one before it.

### What is the difference between CI/CD and continuous deployment?

CI/CD is the umbrella term. The "CD" can mean either continuous delivery or continuous deployment, depending on whether production releases need a manual approval.

### Do I need Kubernetes for continuous deployment?

No. You need a platform that builds immutable images, rolls them out with health checks and rolls back on failure. Docker Swarm does this, and so does a PaaS built on it. See [Kubernetes alternatives](/blog/kubernetes-alternatives/) for the trade-offs.

Whichever model fits your team, the deploy step should be the least interesting part of your day. LogiStack gives you push-to-deploy, CI gates, tag-based releases and one-click rollback on servers you control, with nothing behind a paid plan. [Install it](/#install) on a single Linux server and wire your first repository in a few minutes.

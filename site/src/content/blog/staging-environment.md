---
title: "Staging environment: what it is and how to set one up"
description: "What a staging environment is, why it catches bugs tests miss, how close it must be to production, and how to set one up on your own servers."
date: 2026-11-08
category: Deployment
keywords: staging environment, staging server, staging vs production, pre-production environment, test environment
---

The tests passed, the code review was clean, and the release still broke checkout, because production had an environment variable nobody had set anywhere else. A staging environment exists to catch that class of bug: the ones that live in configuration, data shape and infrastructure rather than in your code. This guide covers what a staging environment should contain, how close to production it needs to be, the mistakes that make staging useless, and how to set one up on servers you control.

## What a staging environment is for

A staging environment is a copy of production that nobody outside your team uses. You deploy a release there first, check it, and only then promote it to production.

Unit and integration tests check your code in isolation. Staging checks the whole system together:

- The build runs with the same build arguments and base image.
- The app reads real environment variables, not test fixtures.
- Migrations run against a database with a realistic schema.
- Requests pass through the same proxy, TLS and routing rules.
- Background jobs, schedules and webhooks fire the way they will in production.

If something breaks there, it breaks in front of your team instead of your users.

## Staging vs production vs development

Most teams run at least three kinds of environments. They differ in who uses them and how much they are allowed to break.

| Environment | Who uses it | Data | Stability | Purpose |
|---|---|---|---|---|
| Development | One developer | Fake or seeded | Breaks often | Write and debug code |
| Preview | Reviewers of one pull request | Empty or seeded | Short-lived | Review a single change |
| Staging | The whole team, QA, stakeholders | Production-like, anonymized | Should stay stable | Validate a release before it ships |
| Production | Users | Real | Must stay up | Serve users |

[Preview environments](/blog/preview-environments/) and staging overlap but don't replace each other. A preview tests one branch in isolation. Staging tests what happens when every merged change runs together, which is where integration bugs show up.

## How close to production does staging need to be?

As close as you can afford. Every difference between staging and production is a place where a bug can hide.

### Match these exactly

- **The artifact.** Promote the same container image from staging to production. Never rebuild for production, because a rebuild can pull a different dependency version.
- **The runtime.** Same base image, same language version, same OS packages.
- **The service topology.** If production runs an API, a worker and a cache, so does staging.
- **The configuration keys.** Every variable production reads must exist in staging, even if the value differs.
- **The proxy and TLS setup.** Redirects, headers and HTTPS behave differently enough that a mismatch hides real bugs.

### Allowed to differ

- **Scale.** Staging can run one replica where production runs four, as long as you test multi-replica behaviour somewhere.
- **Secrets and credentials.** Staging should use test API keys for payment providers and email services, never production ones.
- **Hostnames.** `staging.example.com` instead of `example.com`.
- **Data volume.** A smaller, anonymized dataset is fine if it covers the edge cases.

### Never share

- **The database.** A staging app pointed at the production database is a production outage waiting for a bad migration.
- **Queues and caches.** A staging worker that consumes production jobs will send real emails to real users.
- **Object storage buckets.** A staging cleanup job that deletes files should not reach production files.

## Common staging mistakes

### Staging drifts from production

Someone fixes a config value in production during an incident and never back-ports it. Six months later, staging and production are different systems. The fix is to define both from the same source: a template, a manifest or a duplicate action, rather than two hand-maintained setups.

### Staging data is empty

An empty database hides slow queries, migrations that fail on existing rows, and UI that breaks with long names. Restore an anonymized copy of production data on a schedule, or seed realistic volumes.

### Staging is always broken

If staging breaks for days at a time, people stop trusting it and start testing in production. Treat a broken staging like a broken build: fix it before merging more.

### Staging and production share a network

If services in staging can reach the production database by hostname, one wrong variable is enough to connect them. Isolate environments at the network level, not only by convention.

### Nobody owns it

Staging needs an owner who keeps it in sync, watches its cost and decides when to refresh its data.

## How to set up a staging environment, step by step

The steps are the same on any platform.

1. **Copy the production configuration.** Services, build settings, health checks, resource limits and config files.
2. **Give it its own data stores.** A new database, cache and bucket, empty or restored from an anonymized backup.
3. **Override what must differ.** Test API keys, a staging public URL, lower log retention.
4. **Give it its own domains.** A subdomain like `staging.example.com`, with its own certificate.
5. **Decide what deploys it.** Usually every merge to `main` deploys to staging automatically.
6. **Decide how releases reach production.** Promote the image that passed staging, by tag or by a manual deploy.
7. **Protect it.** Staging often holds copies of real data. Put it behind basic auth or an IP allow list so search engines and strangers don't find it.

## Setting up staging with LogiStack

LogiStack, an open-source self-hosted PaaS, models staging as an **environment** inside a project. Every project starts with **Production**, and you add others with a kind: Production, Staging, Preview or Custom. Services in one environment share a private network and can't reach services in another environment, so a staging app can't talk to the production database even if a variable points at it.

### Duplicate production into staging

Open the production environment's settings menu and select **Duplicate…**. Name the copy `Staging`, pick the **Staging** kind, and choose whether to copy variables.

![The Duplicate environment wizard on its Name the copy step, copying from Production](/docs/screens/environment-duplicate.webp)

What comes over and what doesn't follows the rules above:

| Copied | Not copied |
|---|---|
| Services with their source, build, resources, health checks and config files | Domains |
| Stacks deployed from Git | Volume and database data |
| Environment and service variables, if you choose to | Backup policies |

New volumes and databases start empty. Point variables such as `DATABASE_URL` at the copy's own database, add domains, then deploy each service. To fill the staging database, restore a backup into it; see [Restore](/docs/data/restore/).

You can do the same from a script:

```bash
curl -fsS -X POST "https://stack.example.com/api/environments/env_storefront_production/duplicate" \
  -H "x-api-key: $LOGISTACK_API_KEY" \
  -H "content-type: application/json" \
  -d '{ "name": "Staging", "kind": "staging", "includeVariables": false }'
```

Start without variables when the copy must not reach the production databases or APIs, then set staging values by hand.

### Keep staging and production in sync

To avoid drift, export an environment as a YAML manifest, keep it in Git and apply it from CI. Secret values are never exported, so set them after applying. Applying is idempotent: the same file applied twice changes nothing the second time. See [Project manifests](/docs/automation/project-manifests/).

### Layer your variables

Variables can be set on the organization, the project, the environment or the service, and the more specific one wins. Put shared values on the project and staging-only overrides on the staging environment. See [Environment variables](/docs/deploy/environment-variables/).

### Protect staging from the public

Domains in LogiStack can sit behind basic auth, an IP allow list or forward auth to your own login service, so staging isn't indexed or found by accident.

## How to promote from staging to production

The safest promotion is "same image, new environment". In practice:

- **Tag-based releases.** Staging deploys every push to `main`. Production deploys only on tags such as `v*.*.*`. Testing on staging, then tagging, is the approval step.
- **CI-driven promotion.** Your pipeline builds an image once, deploys it to staging, runs smoke tests against the staging URL, then points the production service at the same image tag.

The second pattern is the one that guarantees production runs the exact bytes you tested. For how the rollout itself avoids dropped requests, read [zero-downtime deployments](/blog/zero-downtime-deployments/), and for the release model, [continuous delivery vs continuous deployment](/blog/continuous-delivery-vs-continuous-deployment/).

## FAQ

### Do small teams need a staging environment?

If you have paying users, yes. A single staging environment on the same server as production costs little and catches configuration bugs that tests can't. Very small projects can start with preview environments per pull request and add staging later.

### Can staging run on the same server as production?

It can, as long as the two are isolated: separate databases, separate networks and resource limits so a load test on staging can't starve production. A second server is safer once production traffic matters.

### Should staging use production data?

Use production-shaped data, not raw production data. Restore a backup and anonymize personal fields, or seed realistic volumes. Real customer data in staging widens the attack surface and may break privacy rules.

### What is the difference between staging and UAT?

UAT (user acceptance testing) is an activity: stakeholders confirm a feature does what they asked. It often happens in the staging environment, but some teams run a separate UAT environment for clients.

### How often should staging be refreshed?

Refresh the data on a schedule that keeps it realistic, often weekly or before a major release. Configuration should never need a refresh, because it should come from the same source as production.

A good staging environment is a duplicate of production with its own data and its own network, built from the same definition so it can't drift. LogiStack gives you that with environment kinds, one-click duplication and manifests, on your own servers and free under Apache 2.0. [Install LogiStack](/#install) and add a staging environment to your first project.

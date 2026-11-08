---
title: "Self-host Plane: an open-source Jira alternative"
description: "Self-host Plane as an open-source Jira alternative: what its 13 services do, how to deploy it with Docker, raise upload limits, and back up issues and files."
date: 2026-11-08
category: Self-hosting
keywords: self-host plane, plane project management, jira alternative, open source jira alternative, self-hosted project management
---

Your engineers want an issue tracker that loads in under a second and doesn't need a consultant to configure. Your finance team wants to stop paying per seat for Jira, and your security team wants the roadmap off yet another vendor's cloud. If you self-host Plane, you get issues, cycles, modules, views and pages in a modern interface, on a server you control. This guide explains what Plane is, how it compares with Jira, and how to run its multi-service stack reliably.

## Why teams look for a Jira alternative

Jira is the default for a reason: it handles complex workflows, huge organizations and a deep marketplace. It also brings costs teams feel daily:

- **Speed and weight.** Large Jira instances feel slow, and every screen has more fields than anyone uses.
- **Configuration debt.** Custom workflows, schemes and screens pile up until only one admin understands them.
- **Per-seat pricing.** Adding occasional users, such as designers or support, costs real money.
- **Hosting.** Atlassian has moved customers off its self-managed Server product toward its cloud, and the remaining self-managed option targets large enterprises.

If your team relies on complex workflows, deep Jira Service Management integration or many marketplace apps, staying on Jira is reasonable. If you mostly need issues, sprints and a roadmap that the team actually updates, a lighter tool will serve you better.

## What Plane offers

Plane is an open-source project management tool. The Community Edition is licensed under AGPL-3.0 and can be self-hosted for free; the company also sells a hosted version and paid self-hosted editions with more features.

Core concepts map closely to what Jira users know:

| Plane | Jira equivalent | What it is |
| --- | --- | --- |
| Workspace | Site | Your organization |
| Project | Project | A team or product |
| Work item (issue) | Issue | A unit of work with state, priority, assignee, labels |
| Cycle | Sprint | A time-boxed set of work |
| Module | Epic, roughly | A group of work toward a feature or goal |
| Views | Filters / boards | Saved list, kanban, calendar, spreadsheet or Gantt views |
| Pages | Confluence pages, lightly | Docs that live next to the work |

Plane also has an API and webhooks for integrations, and a GitHub integration for linking work items to pull requests. Some features, such as advanced workflows and certain importers, depend on the edition. Check Plane's pricing page for what the free Community Edition includes before you plan a migration around it.

## Plane vs Jira and other open-source trackers

| Tool | License | Strength | Consider it when |
| --- | --- | --- | --- |
| Jira | Proprietary | Workflows, scale, marketplace | You need complex processes or JSM |
| Plane CE | AGPL-3.0 | Fast modern UI, cycles, modules, pages | You want a Linear-like tool you can host |
| OpenProject | GPL-3.0 | Gantt, time tracking, classic PM | You manage projects with a PMO and budgets |
| Leantime | AGPL-3.0 | Strategy to tasks, friendly for non-engineers | Mixed teams, simpler needs |
| Linear | Proprietary | Speed, opinionated workflow | You are fine with SaaS only |

LogiStack also has a [Leantime template](/templates/leantime/) if Plane is more than you need.

## What the Plane template deploys

Plane is not a single container. The [Plane template](/templates/plane/) creates 13 services, all on Plane v1.3.0 images except the infrastructure:

| Service | Role |
| --- | --- |
| `proxy` | Plane's own proxy; the only public service, on port 80 |
| `web` | The main web app |
| `space` | Public, shareable project boards |
| `admin` | The instance admin panel ("God mode") |
| `live` | Realtime collaboration for pages |
| `api` | The Django API |
| `worker` | Background jobs |
| `beat-worker` | Scheduled jobs |
| `migrator` | Runs database migrations, then exits |
| `plane-db` | PostgreSQL 15 |
| `plane-redis` | Valkey 7.2, Redis-compatible cache |
| `plane-mq` | RabbitMQ message queue |
| `plane-minio` | S3-compatible storage for uploads |

The template generates eight credentials for you: the database user and password, the RabbitMQ user and password, the storage user and password, the app secret key and the live server secret. You only enter the domain.

Traffic flows like this: Caddy terminates HTTPS for your domain and forwards to Plane's `proxy`, which routes to `web`, `api`, `space`, `admin`, `live` and the upload bucket by path. Every other service is reachable only on the environment's internal network.

## Deploy Plane step by step

Plane needs more resources than a single-container app. With 13 services, a 2 GB server is too small. Plan for at least 4 GB of RAM and two CPU cores for Plane alone, and more for larger teams.

Install LogiStack:

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

Then deploy:

1. Create an A record such as `plane.example.com` pointing at the server.
2. In a project, select **New service** › **Templates** and search `plane`.
3. On **What it creates**, review the 13 services, their start order and volumes.
4. Enter `plane.example.com` as the public URL. Leave every credential on **Auto-generated**.
5. Review and **Deploy**.

Services start in dependency order: data stores first, then the migrator and API, then the front ends and the proxy. The first start takes a few minutes while the migrator builds the schema. Follow it in the stack's **Logs** tab, which shows every container on one timeline. The [templates guide](/docs/deploy/templates/) and [compose stacks](/docs/deploy/compose-stacks/) docs cover the stack view.

![A compose stack's logs from every container on one timeline](/docs/screens/stack-logs.webp)

### Set up the instance and the first workspace

Open `https://plane.example.com/god-mode/` to set up the instance admin. Then create your workspace and first project from the main URL. In the admin panel, configure:

- **Email (SMTP)**, so invitations and notifications go out.
- **Authentication**: email and password, magic links, or Google, GitHub and GitLab OAuth.
- **Sign-up**: restrict it so only invited people can join.

## Settings to change after the first deploy

### Raise the upload limit

The template sets `FILE_SIZE_LIMIT` to 5242880 bytes, which is 5 MB. Screenshots and screen recordings often exceed that. To allow 50 MB, set `FILE_SIZE_LIMIT=52428800` on both the `proxy` and `api` services in their **Environment** tabs, then deploy both. You can see every service's effective settings, with secrets masked, on the stack's **Compose** tab.

### Scale the API workers

The template runs the API with `GUNICORN_WORKERS=1`. That is fine for a small team. For more concurrent users, raise it to 2 or 4 on the `api` service and give the service more memory. Change one thing at a time and watch the service metrics.

### Pin upgrades and read release notes

All Plane images share one version tag. Upgrade all of them together: change the tag on every `makeplane/*` service in its settings, then deploy them. Mixing versions between the API and the front ends breaks things. The `migrator` runs the new migrations on start. Back up first, because migrations do not roll back on their own.

## Import from Jira

Plane offers importers for Jira and other tools in some editions. If your edition does not include one, you have two routes:

- **CSV**: export issues from Jira as CSV and bring them in with a small script against Plane's API, mapping statuses, priorities and assignees.
- **API to API**: for larger migrations, a script that reads from Jira's REST API and writes to Plane's keeps comments and links.

Whichever route you take, migrate one project first, have the team work in it for a sprint, and only then move the rest. Workflows rarely map one to one, and that pilot is where you find the gaps.

## Back up Plane

Two services hold data you cannot rebuild:

- **`plane-db`** (PostgreSQL): issues, comments, projects, users. Create a volume backup policy for its `pgdata` volume with **Stop plane-db while archiving** turned on, or run `pg_dump` on a schedule inside the service.
- **`plane-minio`**: attachments and images in the `uploads` volume. Add a second volume backup policy for it.

Redis and RabbitMQ hold transient state. You do not need to back them up. Send both backups to a destination on another server, and test a restore into a second environment before you rely on them. The [backups guide](/docs/data/backups/) covers destinations, retention and encryption. Our post on [database backup](/blog/database-backup/) explains why an untested backup is not one.

## FAQ

### Is Plane really free to self-host?

The Community Edition is open source under AGPL-3.0 and free to self-host with unlimited users. Plane sells paid editions with extra features. Check Plane's plan comparison for features such as advanced workflows or importers.

### How much server does Plane need?

Plan for at least 4 GB of RAM and two CPU cores for a small team, because the stack runs 13 containers including PostgreSQL, RabbitMQ and object storage. Add memory as you add users and raise API workers.

### Can Plane replace Jira?

For engineering teams using issues, sprints, epics and boards, often yes. For complex approval workflows, service desks or heavy marketplace use, Jira is still the stronger tool.

### Does Plane have a mobile app?

Plane offers mobile apps for its cloud product. Check Plane's documentation for current support of self-hosted instances. The web app works in a mobile browser.

### Can I use my own S3 storage with Plane?

Yes. Plane talks to S3 through the `AWS_*` variables on the `api` and `worker` services. The template points them at its bundled storage service, and you can point them at an external bucket instead.

Plane gives your team a fast, modern tracker without per-seat pricing or a vendor cloud. [Install LogiStack](/#install), deploy the Plane template, and manage all 13 services, their logs and backups from one dashboard. If you are moving several internal tools in-house, read our guide on [deploying Docker Compose in production](/blog/deploy-docker-compose-in-production/).

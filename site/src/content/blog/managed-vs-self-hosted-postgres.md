---
title: "Managed vs self-hosted Postgres: how to decide"
description: "Managed vs self-hosted Postgres compared on cost, uptime, backups, extensions, control and team time, with a checklist to pick the right one."
date: 2026-11-08
category: Databases
keywords: managed vs self-hosted postgres, self-hosted postgres, managed postgres, rds vs self-hosted, postgres hosting
---

The managed vs self-hosted Postgres question usually shows up on an invoice. The database bill has become the biggest line on the hosting statement, or a provider won't load the extension you need, or a customer asks where their data physically lives. Both answers are reasonable. This guide lays out what you actually buy with a managed service, what you take on when you run Postgres yourself, and how to decide for your team and your workload.

## The short answer

Choose **managed Postgres** when you need automatic failover, point-in-time recovery without building it, or when nobody on the team wants to own the database at night.

Choose **self-hosted Postgres** when cost matters more than a few minutes of downtime on hardware failure, when you need extensions or settings a provider won't allow, or when the data must stay on infrastructure you control. Self-hosting is a good fit for most early products, internal tools, staging environments and side projects, as long as someone owns backups and tests restores.

Many teams run both: managed for the one database that pays the bills, self-hosted for everything else.

## What a managed Postgres service gives you

Strip away the marketing and a managed Postgres service sells five things:

1. **Provisioning.** A database with sane defaults in a minute, without picking a disk, an image or kernel settings.
2. **Backups with point-in-time recovery.** Continuous WAL archiving, so you can restore to any second within the retention window. This is the feature most teams underestimate.
3. **High availability.** A standby replica in another zone and automatic failover, usually in under a minute or two.
4. **Patching.** Minor version updates applied in a maintenance window you choose.
5. **Someone else's pager.** When the underlying hardware fails, it is their incident.

Examples include AWS RDS and Aurora, Google Cloud SQL, Azure Database for PostgreSQL, DigitalOcean Managed Databases, Neon, Supabase and Crunchy Bridge. They differ a lot in architecture: Neon and Aurora separate storage from compute, RDS runs Postgres on block storage, Supabase bundles auth and APIs around the database. [Heroku Postgres alternatives](/blog/heroku-postgres-alternatives/) compares them in detail.

What managed services don't give you: tuning for your workload, query optimization, schema design, or protection from your own `DELETE` without a `WHERE`. Those stay your job either way.

## What self-hosting Postgres means

Self-hosted means you run the PostgreSQL process on a machine you rent or own, usually in a container. You decide the version, the extensions, the settings and the hardware. In exchange, you own:

- **Backups**: scheduling, encryption, off-site storage, retention, and restore tests.
- **Upgrades**: minor versions often, major versions once a year or so.
- **Monitoring**: disk space, connections, replication lag if you have replicas, slow queries.
- **Recovery**: when the server dies, you restore from backup or fail over to a replica you set up.

None of it is hard on its own. The risk is that it is easy to skip. A backup cron job that silently stopped working is the classic self-hosting failure. The [self-host PostgreSQL guide](/blog/self-host-postgresql/) covers the production setup step by step.

## Managed vs self-hosted Postgres compared

| | Managed Postgres | Self-hosted Postgres |
| --- | --- | --- |
| Setup time | Minutes | Minutes with a PaaS, hours by hand |
| Cost model | Per instance size, storage and IOPS, often with egress and backup storage on top | The server you rent, plus object storage for backups |
| Automatic failover | Usually included on HA tiers | You build it (Patroni, an operator) or accept restore-based recovery |
| Point-in-time recovery | Included | You add WAL archiving (pgBackRest, WAL-G) |
| Extensions | A provider-approved list | Anything you can install |
| Superuser access | No, a restricted admin role | Yes |
| Config changes | Through parameter groups or a dashboard, some locked | Any setting |
| Major upgrades | Often a button, still with downtime or a migration | You run them |
| Data location | The provider's regions | Wherever your server is |
| Who gets paged | The provider for infrastructure, you for everything else | You |
| Lock-in | Low for vanilla Postgres, higher with proprietary features | None |

## Cost: compare the right numbers

Exact prices change and vary by region, so do the math with your own quote. What changes the comparison:

- **Managed pricing scales with instance size, and HA doubles it.** A standby replica is a second full instance. Storage, provisioned IOPS, backup storage beyond a free allowance and data transfer are often billed separately.
- **Self-hosted cost is mostly the server.** Dedicated servers and VPS plans give far more RAM and NVMe per euro than managed database instances of the same size. Add object storage for backups, which is cheap per gigabyte.
- **Your time is a cost.** Budget a few hours a month for updates, checks and a restore drill. If that time comes from an engineer who would otherwise ship product, count it.

A useful rule: the gap grows with size. For a tiny database, managed tiers are cheap enough that self-hosting saves little. Once you need 16 GB of RAM or more, or HA, the difference often pays for meaningful engineering time.

The broader version of this argument, for the whole stack rather than just the database, is in [Heroku vs self-hosted](/blog/heroku-vs-self-hosted/).

## Uptime: be honest about what you need

Managed HA protects you from one class of failure: the server or zone going away. It does not protect you from bad deploys, slow queries, lock contention or accidental deletes, which cause most real outages in small teams.

Ask what a 30-minute outage on hardware failure would cost. If the answer is "an apology email", a single self-hosted instance with a well-tested restore is fine. If the answer is "contractual penalties", you need failover, and the cheapest reliable way to get it is usually a managed service.

You can also build HA yourself. Patroni with etcd, or a Kubernetes operator such as CloudNativePG, gives you replicas and automatic failover. They work well, but they are systems you have to understand under stress. Don't adopt them for a database that would be fine with a restore.

## Control and extensions

This is where self-hosting wins clearly:

- **Any extension.** Managed providers support popular ones like pgvector and PostGIS, but versions lag, and niche extensions are often missing.
- **Superuser.** Needed for some migrations, some extensions, and for logical replication setups that providers restrict.
- **Every setting.** `shared_preload_libraries`, WAL settings, autovacuum tuning, all without a support ticket.
- **Data residency.** The data sits on a disk in a data center you chose, under a contract you signed. For EU companies with strict requirements, that is often simpler than auditing a US provider's regions. See choosing a VPS in Europe if that applies to you.

## Backups and recovery in both models

Managed services make backups invisible, which is both their strength and a trap: teams often never test a restore until the day they need one. Self-hosting forces you to think about it, and you can match most of what managed gives you:

| Need | Managed | Self-hosted |
| --- | --- | --- |
| Daily snapshots | Automatic | `pg_dump` on a schedule to S3 |
| Point-in-time recovery | Automatic within retention | pgBackRest or WAL-G with WAL archiving |
| Off-site copy | Same provider, often same region | Any bucket at any provider |
| Restore test | Manual | Scripted, on a schedule |
| Survives losing the account | No, unless you export | Yes, if the bucket is elsewhere |

That last row is easy to forget. A managed database and its backups live in the same account. A billing dispute or a compromised root key can take both. A nightly `pg_dump` to a bucket at a second provider is cheap insurance, managed or not. [Database backup](/blog/database-backup/) covers the full strategy.

## A decision checklist

Answer these in order. The first "yes" in the managed column usually settles it.

1. Do you need automatic failover in under a few minutes? **Managed**, unless you already run Patroni or an operator with confidence.
2. Do you need point-in-time recovery and lack the time to set up WAL archiving? **Managed**, or a PaaS that handles it.
3. Is there no one who will own backups and restore tests? **Managed.**
4. Do you need extensions, superuser or settings a provider won't allow? **Self-hosted.**
5. Must the data stay on hardware or in a jurisdiction you choose? **Self-hosted**, or a regional provider.
6. Is the database bill a large share of your infrastructure cost? **Self-hosted** is worth pricing out.
7. Is it a staging, preview or internal database? **Self-hosted** almost always.

## The middle path: a self-hosted PaaS

The gap between "click a button" and "write Compose files and cron jobs" is where a self-hosted PaaS fits. You get managed-style provisioning on your own servers.

[LogiStack](/features/) is one option, open source under Apache 2.0. On a server you own, it creates PostgreSQL 17, 16 or 15 (and MySQL, MariaDB, MongoDB, Redis and libSQL) from **New service** › **Database**, with generated credentials stored as encrypted secrets and no public port ([docs](/docs/deploy/databases/)). The **Backups** tab schedules encrypted `pg_dump` uploads to S3, prunes them by retention, and restores the newest one into a throwaway container on a schedule to prove it works ([backups docs](/docs/data/backups/)). A built-in editor handles tables, SQL and per-app roles.

What it does not do, and you should know before choosing it: there is no replication or automatic failover, and no point-in-time recovery. A database runs as one instance on Docker Swarm, so a node failure means a restore. LogiStack is also a young project with a smaller community than the big clouds. For a database where minutes of downtime cost real money, a managed service is the better fit.

## FAQ

### Is self-hosted Postgres cheaper than managed?

Usually, once the database needs more than a few gigabytes of RAM or you would pay for HA. The server costs less than an equivalent managed instance. The saving shrinks if you count engineering time carefully, so price both with real quotes.

### Is self-hosted Postgres less reliable?

A single self-hosted instance has no automatic failover, so a hardware failure means downtime while you restore or repair. Day to day, Postgres itself is equally reliable in both models. Most outages come from application changes, which neither model prevents.

### Can I move from managed to self-hosted later, or back?

Yes. Vanilla Postgres moves with `pg_dump` and `pg_restore`, or with logical replication for a short cutover. Avoid provider-only features if you want that door to stay open.

### Do managed Postgres providers support pgvector?

Most major ones do, though the version can lag behind the latest release. If you need the newest index types or tuning options, self-hosting gets them first. The pgvector guide covers the setup.

If the self-hosted column fits your project, [install LogiStack](/#install) on a server you control and create your first Postgres with backups in a few minutes. If it doesn't, a managed service is a fine choice, and nothing here stops you from moving later.

---
title: "Database migration: move your data with a plan and a way back"
description: "A database migration guide for moving Postgres or MySQL between servers: choose a strategy, limit downtime, verify the data and keep a rollback."
date: 2026-11-08
category: Databases
keywords: database migration, migrate postgres to new server, mysql migration, zero downtime database migration, logical replication
---

You need to move a database. Maybe the VPS is too small, the cloud bill grew, you are leaving a managed provider, or you need a new major version. A database migration is the one infrastructure change where a mistake can't be fixed with a redeploy: lost rows stay lost. This guide walks through a migration you can plan, rehearse and undo, with commands for PostgreSQL and MySQL.

## Two things called database migration

The phrase means two different jobs, and it helps to keep them apart.

- **Schema migrations** change the structure inside a database: add a column, create an index, split a table. They run with every release, usually through a framework tool. We compare those tools in [database migration tools](/blog/database-migration-tools/).
- **Data migrations** move a whole database somewhere else: another server, another provider, another major version, sometimes another engine.

This article is about the second kind. It also covers how schema changes interact with a move, because the two often overlap during a cutover.

## Choose a migration strategy

There are three common ways to move a database. The right one depends on size and how much downtime you can accept.

| Strategy | Downtime | Complexity | Good fit |
| --- | --- | --- | --- |
| Dump and restore | Minutes to hours, grows with size | Low | Databases up to tens of GB, maintenance window available |
| Replication, then cutover | Seconds to a minute | Medium | Large databases, or apps that can't pause long |
| Dual writes or change data capture | Near zero | High | Engine changes, very large or always-on systems |

Most teams should start with dump and restore. Measure how long it takes in a rehearsal. If the number is acceptable, stop there. Replication adds moving parts, and every moving part is something to debug at 2 a.m.

## Plan before you touch anything

Write a short runbook. The act of writing it surfaces the questions you would otherwise meet halfway through.

1. **Inventory.** Database size, engine and exact version on both sides, extensions (`postgis`, `pgvector`, `pg_trgm`), character sets and collations for MySQL, and any cron jobs or workers that write.
2. **Clients.** Every app, worker, BI tool and script that connects. Each one needs the new connection string at cutover.
3. **Downtime budget.** Agree on a number with whoever owns the product. "As little as possible" isn't a number.
4. **Write freeze.** Decide how writes stop during the final copy: maintenance mode in the app, scaled-down workers, or a read-only role.
5. **Verification.** Decide in advance which checks prove the copy is good.
6. **Rollback.** Decide what triggers a rollback and how long the old database stays available.

Take a fresh backup before you start, even if you don't plan to touch the source. See [database backup](/blog/database-backup/) for a routine that restores.

## Dump and restore, step by step

### PostgreSQL

Use custom format so the restore can run in parallel.

```bash
# 1. Rehearsal: copy without stopping anything, time it
time pg_dump --format=custom --no-owner --no-privileges \
  --dbname="postgres://app:secret@old-host:5432/shop" \
  --file=shop.dump

# 2. Create the target database and any extensions
psql "postgres://postgres:secret@new-host:5432/postgres" \
  -c "create database shop;"
psql "postgres://postgres:secret@new-host:5432/shop" \
  -c "create extension if not exists pg_trgm;"

# 3. Restore with 4 parallel jobs
time pg_restore --no-owner --no-privileges --jobs=4 \
  --dbname="postgres://postgres:secret@new-host:5432/shop" shop.dump
```

On cutover day, repeat the same steps after the write freeze. Run a `pg_dump` at least as new as the source server. Dumps restore into newer versions, not older ones.

### MySQL and MariaDB

```bash
mysqldump --single-transaction --routines --triggers --events \
  --set-gtid-purged=OFF -h old-host -u root -p shop > shop.sql

mysql -h new-host -u root -p -e "create database shop character set utf8mb4 collate utf8mb4_0900_ai_ci;"
mysql -h new-host -u root -p shop < shop.sql
```

Check the collation on the source first with `show create database shop;` and match it on the target. A mismatch can change sort order and uniqueness checks. MariaDB uses different default collations from MySQL 8, so copy the source value rather than the example above. Drop `--set-gtid-purged` for MariaDB, which doesn't know the flag.

## Cut downtime with logical replication

For a large PostgreSQL database, copy while the app keeps running and only pause for the last few seconds of changes. Built-in logical replication handles this between Postgres 10 and later, including across major versions.

```sql
-- On the source (needs wal_level = logical and a restart if it was off)
create publication shop_pub for all tables;

-- On the target, after restoring the schema only:
--   pg_dump --schema-only ... | psql ...
create subscription shop_sub
  connection 'host=old-host dbname=shop user=replicator password=secret'
  publication shop_pub;

-- Watch the initial copy, then the lag
select * from pg_stat_subscription;
```

At cutover: freeze writes, wait for lag to reach zero, then fix sequences. Logical replication copies rows, not sequence values, so the new database would hand out IDs that already exist.

```sql
-- Run on the target for each serial or identity column
select setval('orders_id_seq', (select max(id) from orders));
```

Then drop the subscription and point clients at the new host. MySQL has an equivalent path: set the new server up as a replica of the old one with GTID-based replication, let it catch up, then promote it.

## Major version upgrades

A move is a good moment to upgrade, since you are already copying. A dump from PostgreSQL 15 restores fine into 17. A few cautions:

- Read the release notes for every major version you skip. Removed functions and changed defaults show up there.
- Rehearse with the real application test suite pointed at the new version, not just a restore.
- Run `ANALYZE` after the restore. Fresh statistics avoid slow query plans on the first day.

For MySQL, go from 8.0 to 8.4 LTS rather than skipping series, and run the upgrade checker in MySQL Shell (`util.checkForServerUpgrade()`) first.

## Verify the copy

Don't trust "the restore finished without errors". Check data, not just exit codes.

- **Row counts** per table on both sides, taken during the write freeze.
- **Checksums** on critical tables, such as `select md5(string_agg(t::text, '' order by id)) from orders t;` in Postgres, run on both sides.
- **Sequences** set past the current maximum.
- **Extensions and functions** present with the same versions.
- **Application smoke test**: log in, place an order, read it back.

Write the expected numbers into the runbook before you start, so the check is a comparison, not a judgment call.

## Cutover and rollback

The cutover is short if the plan is good:

1. Announce the window and enable maintenance mode.
2. Stop workers and scheduled jobs that write.
3. Take the final dump, or wait for replication lag to hit zero.
4. Run the verification checks.
5. Switch connection strings, deploy, and turn maintenance mode off.
6. Watch error rates and slow queries for an hour.

Keep the old database running and untouched, read-only if you can, for at least a few days. If something is wrong, rolling back is just pointing the connection strings back. Be honest about one limit: any writes that landed on the new database after cutover don't exist on the old one. The longer you wait to roll back, the more you have to copy back by hand.

## Schema changes during a move

Avoid shipping schema changes in the same window as a move. If you must, use the expand and contract pattern so old and new code both work:

1. **Expand:** add the new column or table, nullable, without removing anything.
2. **Migrate:** backfill data, deploy code that writes to both.
3. **Contract:** in a later release, remove the old column.

Each step is safe to roll back on its own. The same rule keeps zero-downtime deploys safe in daily work.

## Database migration on LogiStack

LogiStack gives you the pieces above inside the dashboard, so a move needs fewer hand-run commands:

- **Restore a dump into a new database.** Create a managed database, open its **Database** tab, and use **Dump & restore** › **Restore from file…** with a `.dump`, `.sql` or `.archive` file. The dialog shows upload and restore progress. See the [database editor docs](/docs/data/database-editor/).
- **Restore beside the original.** The backup restore wizard can load any backup into a new service next to the current one, so you can compare before you switch. See [Restore](/docs/data/restore/).
- **Schema migrations with every deploy.** A **pre-deploy command** runs on the new image before any replica is replaced, for example `npx prisma migrate deploy`. If it fails, the deployment fails and the current version keeps serving. See [Deployments](/docs/deploy/deployments/).
- **Moving off another self-hosted PaaS.** On a server that runs Coolify or Dokploy, the migration wizard moves databases first and adopts the same Docker volume, so the data isn't copied at all, and each service can be rolled back until you switch traffic. See [Migrate from Coolify](/docs/operations/migrate-from-coolify/).

One honest limit: LogiStack doesn't run replication-based cutovers for you. For a large database that can't take a dump-and-restore window, set up logical replication yourself as shown above.

## FAQ

### How long does a database migration take?

For dump and restore, roughly the dump time plus the restore time, and the restore is usually slower because indexes are rebuilt. Rehearse once with production-sized data to get a real number. A 10 GB PostgreSQL database often takes minutes; a 500 GB one can take hours, which is when replication becomes worth it.

### Can I migrate a database with zero downtime?

You can get very close. Replication copies the data while the app runs, and the only pause is the moment you switch connection strings. Truly zero downtime needs dual writes or change data capture, which adds real complexity.

### How do I migrate from MySQL to PostgreSQL?

Use a tool built for engine changes, such as pgloader, which converts types and copies data in one pass. Then test the application carefully: SQL dialects, case sensitivity and implicit type casts differ. Read [Postgres vs MySQL](/blog/postgres-vs-mysql/) first to know where the engines behave differently.

### What should I do with the old database after migrating?

Keep it read-only for a few days as your rollback path, then take a final backup and remove it. Store that final backup with your normal retention, in case someone finds a missing record weeks later.

A database migration goes well when it is boring: rehearsed, measured, verified and reversible. If you are moving to your own servers, [install LogiStack](/#install) on the target first, create the database there, and rehearse the restore before the real cutover.

---
title: "Database management for app teams: tasks, tools and habits"
description: "What database management means for a small team: access control, schema changes, queries, performance, backups and the tools that make it safe."
date: 2026-11-08
category: Databases
keywords: database management, database management tools, manage postgres, database administration, pgadmin alternative, web database editor
---

Your team has no DBA. The database still needs one. Someone has to create users, fix a bad row at 11 p.m., find out why the dashboard query got slow, and make sure last night's backup exists. Database management is that set of jobs, done well enough that nobody notices. This guide breaks it into the tasks that matter for app teams, the tools for each, and the habits that keep production data safe while several people touch it.

## What database management covers

The textbook meaning of a database management system (DBMS) is the engine itself: PostgreSQL, MySQL, MongoDB. In daily work, "database management" means the human side: what you do to keep a running database correct, fast, secure and recoverable. For most product teams, that comes down to seven jobs.

| Job | The question it answers | How often |
| --- | --- | --- |
| Provisioning | Which engine and version, where, with what resources? | Once per database, then on upgrades |
| Access control | Who and what can read or change which data? | Every new app, teammate or departure |
| Schema changes | How does the structure evolve without breaking the app? | Every few releases |
| Data inspection and fixes | What does the data say, and how do I correct a bad record? | Weekly, sometimes daily |
| Performance | Why is this slow, and what index or query fixes it? | When something degrades |
| Backup and recovery | Can we get the data back, and how fast? | Continuous, tested on a schedule |
| Monitoring and security | Is it healthy, is it full, is it exposed? | Continuous |

The rest of this article takes them in order.

## Provisioning

Decide engine, version and placement once, carefully. Pin a major version, give the database a persistent volume on local SSD, keep it on a private network, and set memory limits that leave room for the operating system's cache. If you're still choosing an engine, read [Postgres vs MySQL](/blog/postgres-vs-mysql/). The full production checklist is in [database deployment](/blog/database-deployment/).

## Access control

Most database incidents in small teams aren't attacks. They are an app with superuser rights running a bad migration, or a teammate who meant to query staging. Least privilege prevents both.

- **One role per app.** Each service gets its own user with only the tables and rights it needs.
- **People get read access by default.** Write access is the exception, and it is logged.
- **Superuser is for administration only.** No app connection string should contain it.
- **Rotate on departure.** When someone leaves, rotate any password they could have seen.

In PostgreSQL, a read-and-write app role looks like this:

```sql
create role storefront_web login password 'generated-long-random-value';
grant connect on database shop to storefront_web;
grant usage on schema public to storefront_web;
grant select, insert, update, delete on all tables in schema public to storefront_web;
grant usage, select on all sequences in schema public to storefront_web;

-- Cover tables created later by the migration role
alter default privileges in schema public
  grant select, insert, update, delete on tables to storefront_web;
```

And a read-only role for analytics:

```sql
create role analyst login password 'another-generated-value';
grant connect on database shop to analyst;
grant usage on schema public to analyst;
grant select on all tables in schema public to analyst;
alter default privileges in schema public grant select on tables to analyst;
```

## Schema changes

Every schema change belongs in version control and runs through a migration tool, once per deploy, before new code serves traffic. Hand-run `ALTER TABLE` statements in production create schemas nobody can reproduce. Our [database migration tools](/blog/database-migration-tools/) guide compares the options and covers safe patterns for large tables.

## Data inspection and fixes

This is the job people do most and plan least. Support asks why an order shows the wrong status. Someone needs a CSV of last month's signups. A customer's email has a typo. The risks are real: an `UPDATE` without a `WHERE`, a query that locks a hot table, or a production password pasted into a desktop client on an unencrypted laptop.

Good habits:

- **Read-only by default.** Open sessions in a read-only transaction and switch to writes deliberately.
- **Transactions for fixes.** Run the change, check the row count, then commit.

```sql
begin;
update orders set status = 'refunded' where id = 48213;
-- Expect: UPDATE 1
select id, status, updated_at from orders where id = 48213;
commit;  -- or rollback;
```

- **Statement timeouts.** A 30-second limit stops an accidental full scan before it hurts.
- **An audit trail.** Record who changed what, so a wrong fix can be traced and undone.
- **No public port.** Reach the database through a tunnel, a VPN, or a tool that already runs inside the private network.

## Performance

Slow queries are a database management job, not only a code problem. Start with data, not guesses.

- **PostgreSQL:** enable `pg_stat_statements` and sort by total time to find the queries that cost the most overall.
- **MySQL:** turn on the slow query log with a threshold such as one second, then group results with `pt-query-digest`.
- **Explain the plan** before adding an index:

```sql
explain (analyze, buffers)
select * from orders where customer_id = 1042 order by created_at desc limit 20;
```

- **Watch table bloat and autovacuum** on Postgres, and buffer pool hit rate on MySQL.
- **Size connection pools** from the database side, so a scale-up of app replicas doesn't exhaust connections.

## Backup and recovery

Scheduled dumps, encrypted, stored at another provider, with restores tested on a schedule. Nothing else on this list matters if this one fails. The [database backup](/blog/database-backup/) guide covers the full routine.

## Monitoring and security

Track at least:

- Disk usage and free space on the data volume. A full disk is the most common outage.
- Memory against the container limit, and restarts from out-of-memory kills.
- Connection count against the maximum.
- Backup and restore-check results, with alerts on failure.
- Whether the database port is reachable from the internet. It shouldn't be.

## Database management tools compared

Most teams use a mix: a GUI for browsing and fixes, the CLI for scripts, and the migration tool for schema. Here are the common GUI options.

| Tool | Engines | Runs as | License | Good at |
| --- | --- | --- | --- | --- |
| pgAdmin | PostgreSQL | Desktop or web server | Open source | Deep Postgres administration |
| DBeaver | Most SQL engines, more in paid editions | Desktop | Community edition open source | One client for many engines |
| DataGrip | Most SQL engines, MongoDB | Desktop | Paid | Code completion and refactoring for SQL-heavy work |
| TablePlus | SQL engines, Redis, MongoDB | Desktop | Paid, limited free tier | Fast native UI |
| Beekeeper Studio | SQL engines | Desktop | Community edition open source | Simple, friendly editor |
| Adminer | MySQL, PostgreSQL, SQLite and more | Single PHP file on a server | Open source | Quick web access |
| phpMyAdmin | MySQL, MariaDB | Web app | Open source | Classic MySQL web admin |
| MongoDB Compass | MongoDB | Desktop | Free | Document browsing and aggregation builder |
| Redis Insight | Redis | Desktop or web | Free | Key browsing and memory analysis |

Two patterns to watch with these tools:

- **Desktop clients need network access to the database.** That means an open port, a VPN or an SSH tunnel on every teammate's machine, plus credentials stored locally.
- **Self-hosted web tools are a target.** An Adminer or phpMyAdmin exposed on a public URL is a login form in front of your data. Put it behind authentication and never leave it public by accident.

## Database management in LogiStack

[LogiStack](/features/) builds the daily part of database management into the dashboard, next to the services that use the data. Every managed database (PostgreSQL, MySQL, MariaDB, MongoDB, Redis and libSQL) has a **Database** tab that runs inside the private network, so no port is opened and no client is installed.

![The Database tab of a PostgreSQL service, with the schema tree on the left and the rows of public.customers in the grid](/docs/screens/database-postgres.webp)

- **Table editor:** browse rows, filter and sort, edit cells and add rows. Changes are staged and saved in one transaction, and a conflict with someone else's edit saves nothing.
- **SQL console:** read-only by default, with a toggle to let writes commit. Each run is one transaction with a 30-second limit and up to 1,000 rows per statement, and you can cancel a long query.
- **Schema diagram** of tables and foreign keys.
- **Roles wizard:** create a database user with per-schema access, see the SQL before it runs, and rotate passwords.
- **MongoDB documents and Redis keys,** with dangerous Redis commands such as `FLUSHALL` and `CONFIG` refused.
- **Dump and restore** from the browser.
- **Permissions and audit:** browsing needs read access, writes and SQL need write access, restores and roles need admin. SQL writes, row changes and restores are recorded in the [audit log](/docs/team/audit-log/).

Backups and scheduled restore checks sit in the same service, on the **Backups** tab. The full reference is in the [database editor docs](/docs/data/database-editor/).

What it isn't: a replacement for a full IDE like DataGrip when you write complex SQL all day, or for engine-specific tuning tools. Many teams use both: the built-in editor for quick, audited fixes and access management, and a desktop client for deep work.

## FAQ

### What is the difference between a DBMS and database management?

A DBMS is the software that stores and queries data, such as PostgreSQL or MySQL. Database management is the work of running it: access, schema changes, performance, backups and monitoring. You choose a DBMS once; you manage the database every week.

### Do small teams need a DBA?

Usually not full time. A developer who owns the checklist in this article covers most needs, especially with tools that make the safe path the default. Bring in a specialist for large migrations, replication setups or hard performance problems.

### Is it safe to edit production data from a web interface?

It can be safer than a desktop client, if the tool runs inside the private network, enforces permissions, defaults to read-only and keeps an audit log. It is unsafe when the tool is public, shares one superuser login, or has no record of who changed what.

### What should I monitor on a database first?

Free disk space on the data volume, memory against the limit, connection count, and backup results. Those four catch most outages before users notice. Add query-level metrics such as `pg_stat_statements` once the basics are in place.

Good database management is a short list of habits applied every time: least privilege, versioned schema changes, careful fixes, measured tuning, tested backups. If you want those habits built into the place you already deploy from, [install LogiStack](/#install) and open the **Database** tab on your first managed database.

---
title: "Postgres vs MySQL: how to choose for a new project in 2026"
description: "Postgres vs MySQL compared on features, performance, JSON, replication, licensing and operations, with clear advice on which to pick for your app."
date: 2026-11-08
category: Comparisons
keywords: postgres vs mysql, postgresql vs mysql, mysql or postgres, mariadb vs postgres, best database for web app
---

You are starting a new app and the stack template asks for a database URL. Postgres or MySQL? Both are mature, free, fast enough for nearly every workload, and run some of the largest sites on the internet. The Postgres vs MySQL decision still matters, because it shapes the features you can use, the operational work you take on, and which tools fit around your data. This guide compares them on the points that change real projects and ends with a clear recommendation.

## The short answer

For a new application with no constraints, pick **PostgreSQL**. It has the richer feature set, the larger extension ecosystem, stricter defaults and a permissive license, and most modern frameworks and tools treat it as the first choice.

Pick **MySQL** (or MariaDB) when the software you run expects it, such as WordPress and much of the PHP world, when your team already knows it deeply, or when you plan to scale through MySQL-specific tooling such as Vitess.

The rest of this article explains why, so you can check whether your case is the exception.

## Postgres vs MySQL at a glance

| | PostgreSQL | MySQL |
| --- | --- | --- |
| License | PostgreSQL License (permissive, BSD-style) | GPLv2 community edition, commercial editions from Oracle |
| Governance | Community project, no single owner | Owned and developed by Oracle |
| Main fork | None needed | MariaDB, now its own product with diverging features |
| Concurrency model | MVCC with row versions in the table, cleaned by VACUUM | MVCC in InnoDB with undo logs |
| Connections | One process per connection, a pooler helps past a few hundred | One thread per connection, cheaper per connection |
| Transactional DDL | Yes: `ALTER TABLE` can roll back | No: DDL commits implicitly |
| JSON | `jsonb`, indexable with GIN, rich operators | `JSON` type, index through generated columns |
| Partial indexes | Yes | No |
| Extensions | Large ecosystem: PostGIS, pgvector, TimescaleDB, pg_trgm | Plugins, far smaller ecosystem |
| Default string comparison | Case-sensitive | Case-insensitive with default collations |
| Horizontal scaling | Citus, read replicas | Vitess, Group Replication, read replicas |

## Features that change day-to-day work

### Data types and constraints

Postgres has more ways to describe data precisely: arrays, ranges, `uuid`, `inet`, enums, composite types, domains, and exclusion constraints. A booking system can forbid overlapping reservations at the database level:

```sql
create extension if not exists btree_gist;

create table bookings (
  room_id int not null,
  during tstzrange not null,
  exclude using gist (room_id with =, during with &&)
);
```

MySQL covers the common types well and added CHECK constraints in 8.0.16. For most CRUD apps you won't miss anything. You notice the difference when the domain has intervals, geography or many invariants you'd rather enforce in the database than in every service.

### JSON

Both store JSON. Postgres `jsonb` is a binary format with containment operators and GIN indexes that cover any key:

```sql
create index on events using gin (payload jsonb_path_ops);
select * from events where payload @> '{"type": "checkout"}';
```

In MySQL, you index a specific path by adding a generated column first:

```sql
alter table events
  add column event_type varchar(64)
    generated always as (payload->>'$.type') stored,
  add index idx_event_type (event_type);
```

If semi-structured data is a big part of your model, Postgres is more comfortable.

### Transactional schema changes

In Postgres, a migration that fails halfway rolls back completely, `ALTER TABLE` included. In MySQL, each DDL statement commits on its own, so a failed migration can leave the schema half changed. That matters every week if you deploy often. Our [database migration tools](/blog/database-migration-tools/) guide covers how to keep migrations safe on either engine.

### Strictness and surprises

Modern MySQL runs in strict mode by default, which removed most of the old silent truncation problems. One difference still catches people: default MySQL collations compare strings without regard to case or accents, so `'Anna' = 'anna'` is true and a unique index treats them as equal. Postgres compares exactly unless you ask otherwise (with `citext` or a nondeterministic collation). Neither is wrong, but moving an app between them changes behavior.

### Extensions

This is Postgres's biggest advantage. One `create extension` adds:

- **PostGIS** for geospatial queries, the de facto standard in open-source GIS.
- **pgvector** for embeddings and similarity search, so AI features don't need a separate vector database.
- **TimescaleDB** for time series.
- **pg_trgm** for fuzzy text search.

MySQL added a `VECTOR` type in the 9.x releases, but the ecosystem around pgvector is much larger today.

## Performance

Benchmarks that crown a winner usually measure a configuration, not an engine. In practice:

- **Simple reads by primary key** at high concurrency are a classic MySQL strength. InnoDB stores rows in primary key order, and threads are cheap.
- **Complex queries** with many joins, CTEs, window functions and analytical aggregates tend to favor the Postgres planner.
- **Write-heavy workloads with many updates** need attention on Postgres: each update writes a new row version, and autovacuum must keep up. Tune it rather than fight it.
- **Many short-lived connections** are cheaper on MySQL. On Postgres, put PgBouncer or your framework's pool in front once you pass a few hundred connections.

For a typical web app, both are fast enough, and your indexes and queries matter far more than the engine. Pick on features and operations, then measure your own workload.

## Replication and high availability

Both engines offer streaming replication to read replicas.

- **PostgreSQL** has physical streaming replication and built-in logical replication, which also lets you upgrade major versions with little downtime. Automatic failover needs an external tool such as Patroni.
- **MySQL** has binlog replication with GTIDs, and Group Replication with InnoDB Cluster for built-in failover. Vitess shards MySQL horizontally and powers some of the largest MySQL deployments.

If you expect to shard a single database across many machines, MySQL with Vitess is the more proven path today. Citus does the same for Postgres. Most apps never get there; a single well-sized server plus a replica goes a long way.

## Licensing and governance

PostgreSQL is developed by a community and released under a permissive license. You can embed it, fork it and sell services on it without conditions. MySQL's community edition is GPLv2 and owned by Oracle, which also sells MySQL Enterprise and HeatWave. MariaDB began as a fork by MySQL's original authors and has drifted enough that it should be treated as a third database, not a drop-in clone. If governance risk matters to your company, it is a point for Postgres.

## Versions to pick in 2026

- **PostgreSQL:** run a currently supported major version. Each major release is supported for five years.
- **MySQL:** use the 8.4 LTS series. MySQL 8.0 reached end of life in April 2026, so plan an upgrade if you still run it. The 9.x innovation releases move faster and suit teams that upgrade often.
- **MariaDB:** use a long-term release such as 11.4 or 11.8.

## When MySQL is the better choice

Choose MySQL or MariaDB when:

- You run WordPress, Magento, Nextcloud-style PHP apps or any software that lists MySQL as its first-class database.
- Your team has years of MySQL operations experience and runbooks. Familiarity prevents outages.
- You plan to scale with Vitess or a MySQL-compatible hosted service.
- Your workload is mostly simple reads with very high connection counts.

## When PostgreSQL is the better choice

Choose PostgreSQL when:

- You start fresh with a modern framework: Rails, Django, Laravel, Phoenix, Next.js with Prisma or Drizzle all support it fully.
- You need geospatial, vector search, time series or rich JSON queries.
- You want transactional migrations and strict, explicit behavior.
- License and governance independence matter.

## Run either one on your own server

With [LogiStack](/features/), the choice doesn't lock you into extra tooling. Both engines deploy as managed databases in a few clicks from the same wizard: PostgreSQL 17, 16 and 15, MySQL 8.4 and 8.0, and MariaDB 11.8, 11.4 and 10.11, with generated credentials and a private hostname on the environment network. See [create a managed database](/docs/deploy/databases/).

![The Database tab of a PostgreSQL service, with the schema tree on the left and the customers table's rows on the right](/docs/screens/database-postgres.webp)

Every database gets the same tools: a built-in table editor and SQL console, a schema diagram, a roles wizard for app-specific users, and scheduled, encrypted backups to S3 with restore checks. Details are in the [database editor](/docs/data/database-editor/) and [backups](/docs/data/backups/) docs. If you're comparing engines for a real app, you can deploy both side by side, load the same sample dataset, and run your own queries before you commit.

## FAQ

### Is PostgreSQL faster than MySQL?

Neither is faster in general. MySQL often wins at simple primary-key reads with many connections, while Postgres often wins at complex queries and analytics. Indexes, queries and configuration matter more than the engine for most web apps.

### Is it hard to switch from MySQL to Postgres later?

It takes work but is common. Tools like pgloader convert the schema and copy the data, and the bigger job is testing SQL differences in your app, such as case sensitivity and type casting. Our [database migration](/blog/database-migration/) guide covers how to plan the move.

### Is MariaDB the same as MySQL?

No longer. MariaDB started as a fork and stays mostly compatible for common SQL, but features, defaults, JSON handling and replication have diverged. Test your app against the exact engine you will run in production.

### Which database is better for AI features?

Postgres, mainly because of pgvector, which stores embeddings next to your relational data and supports approximate nearest neighbor indexes. That lets you add semantic search without running a second database.

Both are good databases, and either can carry a business for years. If you're unsure, start with Postgres, and let a concrete requirement push you toward MySQL. Whichever you pick, you can [install LogiStack](/#install) and run it on your own server with backups and an editor included, then read our [database deployment](/blog/database-deployment/) guide to set it up well.

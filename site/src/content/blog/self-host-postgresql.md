---
title: "How to self-host PostgreSQL in production with Docker"
description: "Self-host PostgreSQL on your own server: a pinned Docker setup, memory tuning, private networking, app roles, backups, monitoring and upgrades."
date: 2026-11-08
category: Databases
keywords: self-host postgresql, self-hosted postgres, postgres docker production, postgresql on vps, postgres tuning
---

You want to self-host PostgreSQL because the managed bill grew faster than your data, or because you need an extension your provider won't load, or because the data has to stay on hardware you control. The database itself is the easy part: Postgres is stable, well documented and happy in a container. The work is everything around it. This guide walks through a production setup on one server, from the first `docker run` to tuning, roles, backups, monitoring and major upgrades.

If you are still deciding whether to run it yourself at all, read [managed vs self-hosted Postgres](/blog/managed-vs-self-hosted-postgres/) first. If you want the general checklist that applies to every database engine (volumes, private networks, health checks), [database deployment](/blog/database-deployment/) covers it. This post stays on what is specific to PostgreSQL.

## What you need before you start

- A Linux server with enough RAM for your working set. For a small SaaS, 4 GB is a comfortable floor; Postgres uses spare memory as cache, so more RAM means fewer disk reads.
- Fast local disk. NVMe beats network block storage on latency, and Postgres feels latency on every commit.
- Docker, or a platform that runs containers for you.
- An off-site place for backups, usually an S3-compatible bucket at a different provider.

Pick a major version and stay on it on purpose. PostgreSQL ships a major release every year and supports each one for five years. For new projects in late 2026, 17 is the conservative choice and 18 is the newest. Whatever you pick, pin the full tag in production.

## Run PostgreSQL in Docker

The official `postgres` image is maintained by the Docker community with the PostgreSQL project's packaging, and it is the default for good reason. A minimal production-shaped Compose file looks like this:

```yaml
services:
  db:
    image: postgres:17.6
    restart: unless-stopped
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD_FILE: /run/secrets/pg_password
      POSTGRES_DB: app
    secrets:
      - pg_password
    volumes:
      - pgdata:/var/lib/postgresql/data
    command:
      - postgres
      - -c
      - shared_buffers=1GB
      - -c
      - effective_cache_size=3GB
      - -c
      - max_connections=100
      - -c
      - shared_preload_libraries=pg_stat_statements
    shm_size: 256mb
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d app"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - internal

volumes:
  pgdata:

networks:
  internal:

secrets:
  pg_password:
    file: ./pg_password.txt
```

Three details in that file matter more than they look:

- **No `ports:` section.** Apps on the `internal` network reach the database at `db:5432`. Nothing on the internet does.
- **`shm_size`.** Docker gives containers 64 MB of `/dev/shm` by default. Postgres uses shared memory for parallel queries, and a too-small segment shows up as `could not resize shared memory segment` errors under load.
- **`POSTGRES_PASSWORD_FILE`.** The password stays out of the Compose file and out of `docker inspect` output for the environment.

The image reads `POSTGRES_PASSWORD` only when it initializes an empty data directory. Changing the variable later does nothing. To rotate the password, run `ALTER ROLE` inside the database, then update the secret your apps use.

Note the volume path: images for PostgreSQL 17 and earlier keep data in `/var/lib/postgresql/data`. The PostgreSQL 18 images moved the default to a versioned directory under `/var/lib/postgresql`, so mount `/var/lib/postgresql` for 18. Check the image documentation for your version before you mount a volume, because a wrong path writes your data into the container layer, where the next redeploy deletes it.

## Tune memory and connections

Postgres ships with defaults sized for a small machine from many years ago. A handful of settings cover most of the gain:

| Setting | Starting point | What it does |
| --- | --- | --- |
| `shared_buffers` | 25% of RAM | Postgres's own page cache |
| `effective_cache_size` | 50 to 75% of RAM | A planner hint about the OS cache; allocates nothing |
| `work_mem` | 8 to 32 MB | Memory per sort or hash, per operation, per connection |
| `maintenance_work_mem` | 256 MB to 1 GB | `VACUUM`, `CREATE INDEX`, foreign key checks |
| `max_connections` | 100 or less | Each connection is a process with its own memory |
| `random_page_cost` | 1.1 on SSD | Tells the planner random reads are cheap |
| `wal_compression` | `on` | Smaller WAL, at a small CPU cost |

`work_mem` is the one that bites. It applies per sort node, so a complex query on 50 connections can use many multiples of it. Raise it per session for a heavy report (`SET work_mem = '256MB'`) instead of globally.

If you run the container with a memory limit, keep `shared_buffers` plus a realistic `work_mem` budget well under it. When a container hits its limit, the kernel kills a backend process, and Postgres restarts every connection to protect shared memory.

Keep `max_connections` low and put a pooler in front when your apps need more. The [PgBouncer guide](/blog/pgbouncer-connection-pooling/) explains the pool modes and the arithmetic.

## Lock down access

A self-hosted Postgres gets attacked within minutes of exposing port 5432. Scanners try `postgres` with common passwords all day. The defenses are simple:

1. **Keep it off the public internet.** Use a private Docker network, a VPN or a tailnet for admin access. If you must expose it, restrict the source IPs in the firewall and require TLS.
2. **Use `scram-sha-256` authentication.** It is the default in current versions. Check `password_encryption` and that `pg_hba.conf` has no `trust` lines for network connections.
3. **Give each app its own role.** The superuser is for you, not for the app.

```sql
-- One role per app, owning its own schema
CREATE ROLE shop_app LOGIN PASSWORD 'generated-long-random-value';
CREATE SCHEMA shop AUTHORIZATION shop_app;
ALTER ROLE shop_app SET search_path = shop;

-- A read-only role for analytics or support tools
CREATE ROLE shop_readonly LOGIN PASSWORD 'another-generated-value';
GRANT USAGE ON SCHEMA shop TO shop_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA shop TO shop_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE shop_app IN SCHEMA shop
  GRANT SELECT ON TABLES TO shop_readonly;
```

Since PostgreSQL 15, ordinary roles can no longer create objects in the `public` schema by default. That change breaks some older tutorials. A schema owned by the app role, as above, avoids the issue cleanly.

## Extensions worth knowing

Self-hosting lets you load any extension, which is one of the main reasons people do it. The ones you are most likely to want:

- **`pg_stat_statements`**: query statistics. Turn it on from day one; it needs `shared_preload_libraries` and a restart.
- **`pgvector`**: vector similarity search for embeddings. See the pgvector guide.
- **PostGIS**: geospatial types and indexes.
- **`pg_cron`**: cron jobs inside the database.
- **`pg_trgm`**: trigram indexes for fuzzy `LIKE` and `ILIKE` searches. It ships with Postgres, so you only run `CREATE EXTENSION`.

The official image includes the contrib extensions (`pg_stat_statements`, `pg_trgm`, `uuid-ossp`, `hstore` and others) but not third-party ones like pgvector or PostGIS. For those, use an image that bundles them, such as `pgvector/pgvector` or `postgis/postgis`, or build your own on top of `postgres`.

## Backups that leave the server

Your backup is the only thing between a dead disk and a lost business. The minimum for a self-hosted Postgres:

- A `pg_dump` in custom format on a schedule, encrypted, copied to object storage at another provider.
- `pg_dumpall --globals-only` alongside it, because `pg_dump` does not include roles.
- A restore test on a schedule, into a throwaway instance.

The strategy side (RPO, retention, encryption, where to store) is in [database backup](/blog/database-backup/). The exact Postgres commands and scripts are in [Postgres backup to S3](/blog/postgres-backup-to-s3/). If you need recovery to a specific minute, add WAL archiving with a tool like pgBackRest or WAL-G on top of dumps.

## Keep it healthy: vacuum and monitoring

Postgres keeps old row versions until `VACUUM` clears them. Autovacuum does this for you, and the main job is not turning it off. On large, busy tables, make it more aggressive per table:

```sql
ALTER TABLE events SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.01
);
```

Watch a few numbers. These queries answer most "why is it slow" questions:

```sql
-- The 10 queries that take the most total time
SELECT calls, round(total_exec_time) AS total_ms,
       round(mean_exec_time, 1) AS mean_ms, left(query, 80) AS query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;

-- Tables with the most dead rows
SELECT relname, n_dead_tup, last_autovacuum
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC
LIMIT 10;

-- Who is connected and what they are doing
SELECT state, count(*) FROM pg_stat_activity GROUP BY state;
```

At the host level, track disk free space (a full disk stops Postgres from writing WAL), memory, and the connection count against `max_connections`. Alert before the disk is full, not after.

## Upgrades: minor and major

**Minor versions** (17.5 to 17.6) contain bug and security fixes only. Change the tag, redeploy, done. Do it promptly; the release notes list CVEs.

**Major versions** change the on-disk format. You cannot point a `postgres:18` container at a volume created by 17. Your options:

- **Dump and restore** into a new instance. Simple and safe; the downtime is the restore time.
- **`pg_upgrade`** in a container that has both versions' binaries. Fast, but more moving parts in Docker.
- **Logical replication** from the old instance to a new one, then switch. Near-zero downtime, more setup.

Whichever you choose, rehearse on a copy restored from last night's backup. The database migration guide walks through each path.

## When self-hosting Postgres is the wrong call

Be honest with yourself about three cases:

- **You need automatic failover.** A single self-hosted instance goes down with its server. Building high availability with Patroni or a Kubernetes operator is real work and real practice. Managed services include it.
- **Nobody owns it.** If no one on the team will read an alert at 3 a.m. or test a restore, pay someone who will.
- **Compliance needs certified controls** you can't document yourself.

For many products, a single well-backed-up instance with a tested restore is enough, and a short outage on hardware failure is an acceptable trade for a much smaller bill.

## Self-host PostgreSQL with LogiStack

LogiStack is an open-source PaaS you install on your own server. It runs the setup above for you. From **New service** › **Database** you pick PostgreSQL and a version (17, 16 or 15 on the official `postgres` image), and a name. LogiStack generates the credentials, stores them as encrypted secret variables, puts the data on a persistent volume, and keeps the database reachable only by its service name inside the environment's private network. See [create a managed database](/docs/deploy/databases/).

![The Database tab of a PostgreSQL service, with the schema tree and the customers table's rows](/docs/screens/database-postgres.webp)

Every database gets a **Database** tab with a table editor, an SQL console and a **Roles** view to create per-app users, so the role setup above takes a minute. The **Backups** tab schedules `pg_dump` to S3 with age encryption, retention and scheduled restore checks.

For Postgres 18 with extensions like pgvector, PostGIS and TimescaleDB preinstalled, the [PostgreSQL with 80+ extensions template](/templates/postgres-extensor/) deploys in one step.

The trade-offs are the ones above: LogiStack runs a database as a single instance on Docker Swarm, with no replication or automatic failover. Plan on restores, and test them.

## FAQ

### Is it safe to run PostgreSQL in Docker in production?

Yes, as long as the data lives on a named volume or a mounted disk and not in the container's writable layer. Docker adds almost no overhead to disk or CPU for Postgres. The risks are the usual ones: a wrong volume path, a public port, and no tested backup.

### How much RAM does a self-hosted PostgreSQL need?

It depends on the working set: the tables and indexes your queries touch often. Postgres runs in 512 MB, but if the hot data doesn't fit in memory, every query waits on disk. Start with 4 GB for a small production app and watch the cache hit ratio in `pg_stat_database`.

### Should I expose port 5432 to connect from my laptop?

No. Use a VPN, a tailnet, or an SSH tunnel (`ssh -L 5432:localhost:5432 server`) to reach the private port. If you must open it, limit source IPs in the firewall and require TLS.

### Which PostgreSQL version should I self-host?

A supported major version you can stay on for a few years. In late 2026 that means 17 for a conservative choice or 18 for the newest features. Pin the full tag and apply minor updates as they ship.

### How do I back up a self-hosted Postgres?

Run `pg_dump` in custom format on a schedule, encrypt the file, and copy it to object storage at another provider. Test a restore on a schedule. Add WAL archiving with pgBackRest or WAL-G when you need point-in-time recovery.

If you'd rather click through this setup than maintain the Compose file, scripts and cron jobs, [install LogiStack](/#install) on a server you own: one command, and your first Postgres runs with backups configured in a few minutes.

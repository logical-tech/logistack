---
title: "PgBouncer connection pooling: setup, pool modes and sizing"
description: "Set up PgBouncer connection pooling for Postgres in Docker: pick a pool mode, size pools, handle prepared statements, and avoid the common traps."
date: 2026-11-08
category: Databases
keywords: pgbouncer connection pooling, pgbouncer docker, postgres connection pooling, pgbouncer transaction mode, too many connections postgres
---

Your Postgres logs say `FATAL: sorry, too many clients already`, or memory climbs every time you scale the app, and the obvious fix (raising `max_connections`) makes things slower, not faster. PgBouncer connection pooling is the standard answer. It sits between your apps and Postgres, accepts thousands of client connections, and multiplexes them onto a small number of real database connections. This guide explains when you need it, how the pool modes differ, how to run it in Docker, how to size pools, and the traps that catch teams on their first deploy.

## Why Postgres needs a connection pooler

Postgres forks a new backend process for every connection. Each one carries its own memory for catalog caches and query state, typically a few megabytes, more with large `work_mem` sorts. A few hundred idle connections waste memory, and a few hundred active ones fight over CPU and locks. Throughput usually peaks when active connections are somewhere around a small multiple of the CPU core count, then falls.

Modern app architectures multiply connections quickly:

- Each app replica keeps its own pool. Ten replicas with a pool of 20 open 200 connections.
- Background workers, cron jobs and admin tools add their own.
- Serverless functions and autoscaled containers open connections in bursts.

An application-side pool (in your ORM or driver) limits connections per process. A server-side pooler like PgBouncer limits them across **all** processes. You usually want both: a small app pool, and PgBouncer in front of the database.

## Pool modes: session, transaction, statement

The pool mode decides when PgBouncer gives a server connection back to the pool. It is the most important setting.

| Mode | Server connection returned | Multiplexing | What breaks |
| --- | --- | --- | --- |
| `session` | When the client disconnects | Low; only helps with connection churn | Nothing |
| `transaction` | When each transaction ends | High; the usual choice | Session state between transactions |
| `statement` | After each statement | Highest | Multi-statement transactions; rarely used |

**Session mode** is safe for everything and helps mainly when clients connect and disconnect often. It doesn't reduce the number of server connections you need for long-lived app pools.

**Transaction mode** is where the gains are. A client holds a server connection only for the length of a transaction, so 1,000 mostly-idle clients can share 20 server connections. The cost: anything that lives on the session outside a transaction can leak to another client or disappear. That includes:

- `SET` without `LOCAL` (use `SET LOCAL` inside a transaction instead)
- Session-level advisory locks (`pg_advisory_lock`; use `pg_advisory_xact_lock`)
- `LISTEN` / `NOTIFY` listeners
- Temporary tables that outlive a transaction
- `WITH HOLD` cursors

Check your app and its libraries for these before you switch. Things that need a real session, like a `LISTEN` worker or migrations that take session locks, can connect to Postgres directly or through a separate session-mode pool.

### Prepared statements in transaction mode

For years, transaction mode broke prepared statements, which many drivers use by default. PgBouncer 1.21 added support for protocol-level prepared statements in transaction mode. Turn it on with `max_prepared_statements`:

```ini
max_prepared_statements = 200
```

This covers drivers that prepare through the extended protocol (most modern ones, such as `pgx`, `node-postgres` with named queries, and JDBC). SQL-level `PREPARE` statements are still not tracked. If you run an older PgBouncer, disable prepared statements in the driver instead: for example `prepare_threshold=None` in psycopg 3, or `?pgbouncer=true` in Prisma's connection string.

## Run PgBouncer in Docker

PgBouncer is a single small process. Run it next to the database, on the same private network:

```yaml
services:
  db:
    image: postgres:17.6
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    command: ["postgres", "-c", "max_connections=100"]
    networks: [internal]

  pgbouncer:
    image: edoburu/pgbouncer:v1.24.1-p1  # pin to a current release tag
    depends_on: [db]
    volumes:
      - ./pgbouncer.ini:/etc/pgbouncer/pgbouncer.ini:ro
      - ./userlist.txt:/etc/pgbouncer/userlist.txt:ro
    networks: [internal]

volumes:
  pgdata:

networks:
  internal:
```

```ini
; pgbouncer.ini
[databases]
app = host=db port=5432 dbname=app

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt

pool_mode = transaction
max_client_conn = 2000
default_pool_size = 20
min_pool_size = 5
reserve_pool_size = 5
reserve_pool_timeout = 3
max_db_connections = 60
max_prepared_statements = 200

server_idle_timeout = 300
query_wait_timeout = 30
admin_users = pgbouncer_admin
```

Apps then connect to `pgbouncer:6432` instead of `db:5432`. Nothing else in the connection string changes.

The `userlist.txt` holds one line per user, with the password or its SCRAM secret. You can copy the SCRAM verifier straight from Postgres, so the plain password never appears in the file:

```sql
SELECT '"' || rolname || '" "' || rolpassword || '"'
FROM pg_authid WHERE rolname = 'app';
```

For many users, `auth_query` lets PgBouncer look up credentials in Postgres at login instead of keeping a file in sync. It needs a dedicated lookup role and a `SECURITY DEFINER` function; the PgBouncer docs show the pattern.

## Size your pools

Work from the database side, not the app side.

1. **Decide how many connections Postgres should serve.** A starting point is two to four times the CPU cores for active work. On an 8-core server, 20 to 30 active connections is plenty for most OLTP workloads.
2. **Set `max_connections` in Postgres above that**, with room for admin sessions, replication, backups and migrations that bypass the pooler. 100 is fine.
3. **Set `default_pool_size`** per database and user pair, so the sum across your pools stays under the target. `max_db_connections` is the hard cap per database.
4. **Set `max_client_conn` high.** Client connections to PgBouncer are cheap. Make sure the container's open-file limit allows it.
5. **Keep app-side pools small.** With PgBouncer in transaction mode, each replica needs only a handful of connections, since they are released after each transaction.

Example: 12 app replicas with a driver pool of 10 make 120 client connections to PgBouncer. PgBouncer serves them over a pool of 20 server connections. Postgres sees 20, plus a few direct ones, with `max_connections = 100`.

If clients wait on the pool (`cl_waiting` in stats, below), the answer is usually faster queries or shorter transactions, not a bigger pool. A transaction that stays open while your app calls an external API holds a server connection the whole time.

## Monitor PgBouncer

Connect to the admin console, the special `pgbouncer` database, as a user listed in `admin_users`:

```bash
psql "postgres://pgbouncer_admin:secret@pgbouncer:6432/pgbouncer" -c "SHOW POOLS;"
psql "postgres://pgbouncer_admin:secret@pgbouncer:6432/pgbouncer" -c "SHOW STATS;"
```

Watch these numbers:

- **`cl_waiting`** in `SHOW POOLS`: clients waiting for a server connection. Should be zero most of the time.
- **`maxwait`**: how long the oldest waiting client has waited. Seconds here means users feel it.
- **`sv_active` vs pool size**: a pool always at its limit means it is the bottleneck.
- **`avg_xact_time`** in `SHOW STATS`: rising transaction times often explain rising waits.

`RELOAD;` applies config changes without dropping connections, and `PAUSE;` / `RESUME;` let you restart Postgres behind PgBouncer while clients queue instead of failing.

## Common traps

- **Pointing migrations at PgBouncer.** Migration tools often use session-level advisory locks. Run them against Postgres directly.
- **Two poolers fighting.** An ORM pool with long idle timeouts holds client slots in PgBouncer, which is fine, but an ORM that pings on checkout adds a round trip to every query. Turn checkout pings off or set a long interval.
- **Single point of failure.** If PgBouncer stops, every app loses the database. Run it with a restart policy and a health check, or run more than one instance.
- **TLS assumptions.** If clients need TLS, set `client_tls_*` in PgBouncer; if Postgres requires TLS, set `server_tls_sslmode`. They are separate legs.
- **Statement timeouts.** `statement_timeout` set with `SET` leaks across clients in transaction mode. Set it per role with `ALTER ROLE app SET statement_timeout = '15s'` instead.

## PgBouncer alternatives

| Pooler | Notes |
| --- | --- |
| PgBouncer | Single-threaded, tiny, the long-time standard |
| PgCat | Multi-threaded, written in Rust; adds load balancing and sharding |
| PgDog | Multi-threaded Rust pooler and proxy with load balancing and sharding |
| Supavisor | Elixir pooler built by Supabase for many tenants |
| Odyssey | Multi-threaded pooler from Yandex |
| RDS Proxy and similar | Managed poolers on cloud databases |

PgBouncer's single thread is rarely the limit below tens of thousands of transactions per second. If it becomes one, you can run several PgBouncer processes with `so_reuseport`, or move to a multi-threaded pooler.

## Connection pooling on LogiStack

[LogiStack](/features/) is an open-source PaaS for your own servers. Its managed PostgreSQL databases (17, 16 and 15) don't include a built-in pooler, so you add one as a service in the same environment. The services share a private network, so apps reach the pooler by its service name, and neither the pooler nor the database needs a public port ([create a managed database](/docs/deploy/databases/)).

Two ways to set it up:

- **The [PostgreSQL with PgDog template](/templates/postgres-pgdog/)** deploys Postgres 18 and the PgDog pooler together, with the config files written for you. Apps connect to the pooler on port 6432.
- **PgBouncer as a Docker image service** next to your managed database, from **New service** › **Docker image** ([deploy a Docker image](/docs/deploy/from-image/)), or with the Compose file above as a [Compose stack](/docs/deploy/compose-stacks/). Store the connection string your apps use as a secret variable, for example `DATABASE_URL=postgres://app:...@pgbouncer:6432/app` ([environment variables](/docs/deploy/environment-variables/)).

Keep running migrations against the database service directly, with a second variable such as `DIRECT_DATABASE_URL` that points at port 5432.

For the rest of the Postgres setup (tuning, roles, backups), see [self-host PostgreSQL](/blog/self-host-postgresql/).

## FAQ

### Do I need PgBouncer if my ORM already pools connections?

An ORM pool limits connections per process. Once you run several replicas, workers and cron jobs, their pools add up, and PgBouncer caps the total that reaches Postgres. Small apps on one or two processes often don't need it yet.

### Which PgBouncer pool mode should I use?

Transaction mode for web apps, after checking that your code doesn't depend on session state such as `SET`, session advisory locks or `LISTEN`. Use session mode for clients that need a real session, through a separate pool or a direct connection.

### Does PgBouncer support prepared statements?

Since version 1.21, yes, in transaction mode, for protocol-level prepared statements. Set `max_prepared_statements` to a non-zero value. On older versions, disable prepared statements in your driver.

### How many connections should Postgres allow behind PgBouncer?

Size the server pool to a small multiple of CPU cores, often 20 to 40 on a mid-sized server, and set `max_connections` above that to leave room for admin and maintenance sessions. More active connections than the hardware can run usually makes queries slower.

When you'd rather spend your time on queries than on wiring containers, [install LogiStack](/#install), create a Postgres database, and put a pooler in front of it in the same environment.

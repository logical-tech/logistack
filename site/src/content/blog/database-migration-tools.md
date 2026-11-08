---
title: "Database migration tools: Flyway, Liquibase, Prisma and more"
description: "Compare database migration tools for schema changes and data moves, from Flyway and Liquibase to Prisma, Drizzle, Alembic, Atlas and pgloader."
date: 2026-11-08
category: Databases
keywords: database migration tools, schema migration tool, flyway vs liquibase, prisma migrate, drizzle kit, alembic, atlas schema
---

Your app's schema changes every few weeks. Someone adds a column on their laptop, someone else forgets to run it on staging, and production ends up with a table nobody can reproduce. Database migration tools fix that by turning every schema change into a versioned file that runs the same way everywhere. This guide compares the main options, explains the two styles they follow, and shows how to run migrations safely on deploy.

## What a database migration tool does

At its core, a schema migration tool keeps a list of changes and a record of which ones a database has already applied. Most store that record in a table such as `flyway_schema_history`, `alembic_version`, `_prisma_migrations` or `schema_migrations`. On each run, the tool compares the list with the table and applies what is missing, in order.

That gives you three things you don't get from running SQL by hand:

- **Repeatability.** A new laptop, a CI job and production reach the same schema from the same files.
- **Review.** Schema changes go through pull requests like any other code.
- **History.** You can see when a change landed, and on which database.

A second family of tools moves data rather than structure: copying a database to another server or another engine. We cover those at the end, and the process around them in [database migration](/blog/database-migration/).

## Two styles: versioned and declarative

Every tool on this list follows one of two models, and the choice shapes your workflow more than the brand does.

**Versioned (imperative) migrations.** You write a numbered file for each change: `V7__add_status_to_orders.sql`. The tool runs the files in order. You see exactly what will run, and you control every statement. The cost is that the current schema only exists as the sum of all the files.

**Declarative (state-based) migrations.** You describe the schema you want, and the tool diffs it against the live database and generates the statements. Schema files stay readable, and you skip writing `ALTER` by hand. The cost is trust: a diff can decide to drop and recreate a column when you meant to rename it.

Many modern tools mix both. Prisma, Drizzle and Atlas let you declare the schema, generate a versioned SQL file from the diff, review it, and commit that file. That hybrid is a good default for most teams.

## The main tools at a glance

| Tool | Ecosystem | Style | Down migrations | Good fit |
| --- | --- | --- | --- | --- |
| Flyway | Java CLI, any language | Versioned SQL | Paid editions | Teams that want plain SQL files and a mature runner |
| Liquibase | Java CLI, any language | Versioned changelogs (XML, YAML, JSON, SQL) | Yes, per changeset | Enterprises with many databases and audit needs |
| Atlas | Go CLI, any language | Declarative, generates versioned files | Generated | Schema-as-code, linting of risky changes |
| Prisma Migrate | Node.js, TypeScript | Declarative schema, versioned SQL output | No built-in down | Prisma ORM projects |
| Drizzle Kit | Node.js, TypeScript | Declarative TS schema, versioned SQL output | No built-in down | Drizzle ORM projects |
| Alembic | Python, SQLAlchemy | Versioned Python scripts, autogenerate | Yes | SQLAlchemy and FastAPI apps |
| Django migrations | Python, Django | Versioned, generated from models | Yes, most operations | Django apps |
| Rails migrations | Ruby, Active Record | Versioned Ruby DSL | Yes | Rails apps |
| golang-migrate | Go CLI and library | Versioned up/down SQL | Yes | Go services, small footprint |
| dbmate | Single binary | Versioned SQL with up and down sections | Yes | Polyglot teams who want one small tool |
| Sqitch | Perl CLI, any database | Change scripts with deploy, revert, verify | Yes | Teams that want explicit dependencies between changes |

A few notes the table can't hold:

- **Flyway** is maintained by Redgate. The community edition covers versioned migrations; features such as undo migrations sit in paid editions.
- **Liquibase** changed its license in 2025. If an OSI-approved license matters to your company, read the current terms before you adopt it.
- **Atlas** has an open-source CLI and a commercial cloud. Its migration linting catches destructive and locking changes before they ship.
- **Down migrations** sound safer than they are. Dropping a column in a "down" step doesn't bring back the data the "up" step removed. Many teams write forward-only migrations and fix mistakes with a new migration.

## If you already use an ORM, start there

The best tool is often the one your framework ships. Rails, Django, Prisma, Drizzle and SQLAlchemy all know your models, so they generate most migrations for you and keep types in sync. Pick a standalone tool when:

- Several services in different languages share one database.
- Your DBA team owns the schema and wants plain SQL.
- You need features the ORM tool lacks, such as linting, dependency ordering or multi-database runs.

Here is what the common ORM workflows look like:

```bash
# Prisma: generate a migration from schema.prisma, then apply in production
npx prisma migrate dev --name add_order_status
npx prisma migrate deploy

# Drizzle: generate SQL from the TypeScript schema, then apply
npx drizzle-kit generate
npx drizzle-kit migrate

# Alembic: autogenerate from SQLAlchemy models, review, then upgrade
alembic revision --autogenerate -m "add order status"
alembic upgrade head

# Django
python manage.py makemigrations
python manage.py migrate
```

And a standalone runner, with plain SQL files:

```sql
-- db/migrations/20261108093000_add_order_status.sql (dbmate format)
-- migrate:up
alter table orders add column status text not null default 'pending';

-- migrate:down
alter table orders drop column status;
```

```bash
dbmate --url "$DATABASE_URL" up
```

## How to choose

Ask these questions in order:

1. **Does your framework have a migration tool?** Use it unless one of the reasons above applies.
2. **Who writes migrations?** Developers who think in models prefer generated migrations. DBAs prefer SQL they can read line by line.
3. **How many databases and engines?** One Postgres for one app needs little. Twenty databases across engines favor Flyway, Liquibase or Atlas.
4. **Do you need review gates?** Linting for locking operations is worth a lot once tables reach millions of rows. Atlas has it built in; for Postgres, the open-source `squawk` linter checks plain SQL files.
5. **What license can you accept?** Check before you build your workflow around a tool.

## Run migrations safely on deploy

Picking a tool is the easy half. Running it at the right moment is where outages come from.

### Run once, before new code serves traffic

Migrations should run once per deploy, against the new code's files, before any new replica takes requests. Running them in the app's startup code means every replica races to apply them, and a crash loop can apply half a migration several times. Use a dedicated release step instead.

### Keep old code working

During a rolling deploy, old and new versions run at the same time. A migration that renames a column breaks the old version instantly. Follow expand and contract: add first, backfill, switch code, remove in a later release. This is what makes [zero-downtime deployments](/blog/zero-downtime-deployments/) possible with a database underneath.

### Watch for locks

Some statements lock a whole table while they run. On a big table, that is an outage. In PostgreSQL:

```sql
-- Fail fast instead of queueing behind a long transaction
set lock_timeout = '5s';

-- Build indexes without blocking writes (not inside a transaction)
create index concurrently idx_orders_status on orders (status);

-- Add a NOT NULL constraint in two steps on large tables
alter table orders add constraint orders_status_not_null
  check (status is not null) not valid;
alter table orders validate constraint orders_status_not_null;
```

### Back up first

Take a backup before a migration that rewrites or drops data. An application rollback restores code, not rows. Our [database backup](/blog/database-backup/) guide covers a routine you can trust.

## Running migrations on LogiStack

[LogiStack](/features/) doesn't replace your migration tool. It gives the tool the right place to run. Each service has **release commands** under **Settings**:

- A **pre-deploy command** runs once on the new image, with the service's variables and network, before any replica is replaced. If it fails, the deployment fails and the current version keeps serving.
- A **post-deploy command** runs after the new replicas are healthy, for jobs like cache warm-up.

You write one argument per line, or use a shell:

```text
sh
-c
npx prisma migrate deploy
```

Preview environments get an empty database each, so the same pre-deploy command builds their schema on every pull request. Details are in the [deployments docs](/docs/deploy/deployments/) and [preview environments](/docs/deploy/preview-environments/). One caution from the docs is worth repeating: a rollback in LogiStack restores the image, not the schema. Roll the schema back yourself first, or keep migrations backward compatible so you never have to.

## Tools for moving data between servers

When the job is moving a database rather than changing its schema, use a different set of tools:

| Tool | Job |
| --- | --- |
| `pg_dump` and `pg_restore` | Copy a PostgreSQL database, including to a newer major version |
| `mysqldump`, `mariadb-dump`, mydumper | Copy MySQL or MariaDB, mydumper in parallel |
| PostgreSQL logical replication | Copy while the source keeps taking writes, then cut over |
| pgloader | Move MySQL, SQLite or MS SQL data into PostgreSQL with type conversion |
| Debezium | Stream row changes (CDC) into Kafka for dual-run migrations |
| AWS DMS | Managed copy and replication when either side is on AWS |

On LogiStack, a managed database's **Database** tab can restore a `.dump`, `.sql` or `.archive` file straight from the browser. See the [database editor docs](/docs/data/database-editor/).

## FAQ

### What is the best database migration tool?

The one your framework already ships, for most teams. If several services share a database or your DBAs want plain SQL, Flyway, dbmate or Atlas are strong choices. Pick by workflow and license, not by feature count.

### Should I write down migrations?

Write them when they are truly reversible, like adding an index. For changes that drop or rewrite data, a down migration gives false comfort, because it can't recover what was removed. A tested backup and forward-only fixes are more reliable.

### When should migrations run during a deployment?

Once, before the new version receives traffic, as a dedicated release step. Not in application startup, where several replicas race each other. Keep the change compatible with the old version that is still running.

### Can I mix declarative and versioned migrations?

Yes, and many teams do. Declare the schema, let the tool generate a versioned SQL file, review and commit that file, and apply only committed files in production. You get readable schemas and predictable deploys.

The tool matters less than the habits around it: every change in version control, one run per deploy, compatible with the code still running, and a backup before anything destructive. If you want a place where that release step and the backups are built in, [install LogiStack](/#install) and point a pre-deploy command at the tool you already use.

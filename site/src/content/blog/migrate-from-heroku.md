---
title: "Migrate from Heroku: a step-by-step guide"
description: "Migrate from Heroku to your own server step by step: inventory the app, map dynos and add-ons, move Postgres, cut over DNS and keep a rollback path."
date: 2026-11-08
category: Deployment
keywords: migrate from heroku, heroku migration, leave heroku, move off heroku, heroku to docker, heroku postgres migration
---

You have decided to migrate from Heroku. The cost, the data location or the add-on sprawl tipped the balance, and now you need a plan that does not end with a weekend of downtime. This guide is that plan: a step-by-step migration of one Heroku app, with its dynos, config vars, Postgres database, Redis, scheduled jobs and domains, to a self-hosted platform on your own server.

If you are still deciding whether to leave at all, read [Heroku vs self-hosted](/blog/heroku-vs-self-hosted/) first. This post assumes the decision is made and focuses on how.

The example app is a Node.js API with a Procfile like this:

```text
web: node dist/server.js
worker: node dist/worker.js
release: npx prisma migrate deploy
```

It uses Heroku Postgres, Heroku Key-Value Store (Redis), Heroku Scheduler and a custom domain. The same steps apply to Rails, Django, Laravel or Go apps; only the commands inside change.

## What you need before you start

- The Heroku CLI, logged in, with access to the app.
- A Linux server with Ubuntu 22.04 or later or Debian 12 or later, at least 2 GB of RAM (4 GB is more comfortable for builds), and ports 80 and 443 open.
- Access to your DNS provider.
- A maintenance window of 15 to 60 minutes for the final database sync, depending on database size.

## Step 1: inventory the Heroku app

Write down everything the app depends on. Surprises during cutover come from things you forgot existed.

```bash
heroku apps:info --app my-app
heroku ps --app my-app
heroku addons --app my-app
heroku buildpacks --app my-app
heroku domains --app my-app
heroku config --app my-app --shell > heroku.env
heroku pg:info --app my-app
```

From this, build a short list:

| Item | Example value | Notes |
| --- | --- | --- |
| Process types and counts | `web` x2, `worker` x1 | From `heroku ps` |
| Dyno size | Standard-2X | Gives you the memory to plan for |
| Buildpacks | `heroku/nodejs` | Tells you what the build needs |
| Add-ons | Postgres, Key-Value Store, Scheduler, a logging add-on | Each needs a counterpart or a decision to keep it |
| Config vars | 23 variables | Some come from add-ons and will change |
| Domains | `api.example.com` | And the DNS target Heroku gave you |
| Database size | 6 GB | Sets your dump and restore time |

`heroku.env` contains secrets. Keep it out of Git and delete it when the migration is done.

## Step 2: map Heroku concepts to the new platform

The table below maps the example app to LogiStack. Other self-hosted platforms have similar concepts under different names.

| Heroku | LogiStack |
| --- | --- |
| App | A project, with a Production environment |
| `web` process | An application service from Git, with a domain |
| `worker` process | A second service from the same repository, with its own **Command** and no domain |
| `release` process | A **Pre-deploy command** on the web service |
| Dyno count | Replicas, or automatic scaling on CPU |
| Config vars | Environment variables at environment or service level, secrets encrypted |
| Heroku Postgres | A managed Postgres service in the same environment |
| Heroku Key-Value Store | A managed Redis service |
| Heroku Scheduler | Schedules with cron, timezone and run history |
| Logging add-on | Built-in logs, plus log drains to Loki, Datadog, OpenTelemetry, syslog or HTTP |
| ACM certificates | Automatic Let's Encrypt certificates through Caddy |
| `heroku run bash` | A terminal in the running container, in the browser |
| Rollback | Roll back to any earlier deployment's image |

Add-ons for email, error tracking or search usually stay as they are. They are external services with an API key; you copy the key and keep going.

## Step 3: install the platform

Install LogiStack on the server:

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

The installer sets up Docker and Swarm if they are missing, then the setup wizard walks you through the instance URL and how generated hostnames work. If you plan to test on generated hostnames for more than a day, choose a per-server wildcard domain in the wizard; it avoids the shared Let's Encrypt limits on sslip.io. See the [install guide](/docs/getting-started/install/).

## Step 4: make the build container-ready

You have two options.

**Railpack, no Dockerfile.** Railpack detects the language and builds an image, similar in spirit to buildpacks. It works for many Node, Python, Ruby, Go and PHP apps. Try it first if your Heroku build was standard.

**Your own Dockerfile.** More control and more predictable builds. For the example app:

```dockerfile
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

Three Heroku habits to check in your code:

- **`PORT`.** Heroku assigns a random port. Your app probably reads `process.env.PORT` already, so set `PORT=3000` and use the same value as the service's container port.
- **Ephemeral filesystem.** You may have avoided local files because Heroku wipes them. That habit is good; keep it. Store uploads in object storage, not on the container's disk, so the service can run more than one replica.
- **TLS to the database.** Heroku Postgres requires SSL, so connection strings often include `sslmode=require`. A database on the same private network may not have TLS enabled. Remove the flag, or configure TLS on the database, before you connect.

[Build types](/docs/deploy/build-types/) covers Railpack, Dockerfiles and build-time secrets in detail.

## Step 5: create the services

In a new project, create the services in this order.

**1. Postgres.** New service, database, PostgreSQL, the same major version as Heroku (`heroku pg:info` shows it). Name it `postgres`. Its hostname on the environment network is its service name.

**2. Redis.** New service, database, Redis. Name it `redis`.

**3. Web.** New service, Git repository. Pick the repository and branch, the builder, and container port `3000`. Under **Release commands**, set the pre-deploy command, one argument per line:

```text
npx
prisma
migrate
deploy
```

The pre-deploy command runs once on the new image before any replica is replaced. If it fails, the deployment fails and the old version keeps serving, which is the same guarantee Heroku's release phase gives you.

For now, pick a **Generated hostname** on the domain step. You switch to your real domain at the end.

**4. Worker.** Another Git service from the same repository and branch. Choose **No public domain**, then under **Settings**, **Command and ports**, set the command:

```text
node
dist/worker.js
```

See [Deploy from Git](/docs/deploy/from-git/) for each field.

## Step 6: move the config vars

Open `heroku.env` and sort the variables into three groups:

1. **Keep as is:** API keys for external services, feature flags, your own settings.
2. **Replace:** variables an add-on set, such as `DATABASE_URL`, `REDIS_URL`, `REDIS_TLS_URL` and logging tokens.
3. **Drop:** Heroku-only variables such as `PAPERTRAIL_API_TOKEN` if you replace that add-on.

Add the first group as variables. Put values shared by `web` and `worker` at the environment level so you set them once, and mark credentials as secrets. Then set the replaced ones to the new internal addresses:

```bash
DATABASE_URL=postgres://app:<password>@postgres:5432/app
REDIS_URL=redis://:<password>@redis:6379
```

The database page shows the exact connection strings with the generated credentials. Note that Heroku's Redis URLs often use `rediss://` (TLS). The internal one uses plain `redis://` on the private network.

## Step 7: do a rehearsal with real data

Take a fresh backup on Heroku and download it:

```bash
heroku pg:backups:capture --app my-app
curl -o latest.dump "$(heroku pg:backups:url --app my-app)"
```

Heroku's backups are in `pg_dump` custom format, the same `.dump` format LogiStack's Postgres restore accepts. Open the Postgres service's **Database** tab and restore `latest.dump` from the browser. See [Restore](/docs/data/restore/) for the other ways.

Now deploy `web` and `worker` and test on the generated hostname:

- Sign in, create and edit records, trigger background jobs.
- Watch the worker's logs while you do it.
- Time the restore. That number is most of your maintenance window.

Fix whatever breaks here, not during cutover.

## Step 8: recreate scheduled jobs

Each Heroku Scheduler job becomes a schedule. Heroku Scheduler offers every 10 minutes, hourly or daily; a cron expression can do the same or anything finer. Create the schedule to run inside the `web` service, so it gets the same environment:

```text
Name:            Send daily digest
When it runs:    Cron, 0 7 * * *
Time zone:       Europe/Rome
Where it runs:   Inside a service, web
Script:          node dist/jobs/daily-digest.js
```

Run it once by hand and check the run history. See [Schedules](/docs/data/schedules/).

## Step 9: set up backups before cutover

Do not go live without them. Add an S3-compatible destination such as Cloudflare R2, Backblaze B2 or AWS S3, then a backup policy on the Postgres service with a schedule and retention. Turn on the scheduled restore check, which restores the latest backup into a throwaway container and reports whether it worked. See [Backups](/docs/data/backups/).

## Step 10: cut over

1. **A day before:** lower the TTL of your domain's DNS record to 60 seconds.
2. **Add the real domain** to the `web` service, for example `api.example.com`, with HTTPS on. It stays pending until DNS points at the server.
3. **Start the window.** Turn on maintenance mode and stop the dynos that write to the database:

   ```bash
   heroku maintenance:on --app my-app
   heroku ps:scale worker=0 --app my-app
   ```

4. **Take and restore the final dump.** Capture, download and restore as in step 7.
5. **Switch DNS.** Point `api.example.com` at the server's IP with an A record, replacing the CNAME to Heroku's DNS target. Caddy issues the certificate on the first request once the record resolves.
6. **Verify.** Test the critical paths, check logs on both services, confirm a scheduled job runs.

## Step 11: keep a way back, then decommission

Leave the Heroku app in maintenance mode for a week, with its database intact. If something serious appears, you can point DNS back, at the cost of writes made since cutover. After a week of normal operation:

```bash
heroku ps:scale web=0 worker=0 --app my-app
```

Take one last backup of the Heroku database and keep it somewhere safe. Then remove the add-ons and the app.

## Common problems

- **`502` on the domain after deploy:** the container port does not match the port the app listens on. Check `PORT` and the service's container port.
- **`could not translate host name "postgres"`:** the app and the database are in different environments. Each environment has its own private network.
- **SSL errors connecting to Postgres:** remove `sslmode=require` from the connection string, or enable TLS on the database.
- **Worker exits right away:** its command is wrong, or it reads a variable you only set on `web`. Move shared variables to the environment level.
- **Release command fails on first deploy:** the database is empty. Restore the dump before the first deploy of `web`, or let the migration create the schema and restore data afterwards.

## FAQ

### How long does a Heroku migration take?

For one app with Postgres and Redis, plan a day for setup and rehearsal, and a short maintenance window for the final cutover. Most of the window is the final database dump and restore, so its length depends on database size.

### Can I migrate from Heroku with zero downtime?

Close to it, with logical replication from Heroku Postgres to the new database, then a switch that only waits for replication to catch up. That needs replication access that Heroku Postgres plans do not always grant. A short write freeze with dump and restore is simpler and fine for most apps.

### Do I need to rewrite my Procfile?

No. Each process type becomes a service with its own command, and the release process becomes a pre-deploy command. Your code does not change, apart from connection strings and possibly the TLS flag.

### What do I do with add-ons that have no self-hosted equivalent?

Keep them. Most add-ons are third-party services you can sign up for directly and connect with an API key. Move them to a direct account with the vendor so they no longer depend on your Heroku account.

Ready to move your first app? Install LogiStack with [one command](/#install), follow the steps above with a non-critical app first, and keep Heroku running until the new copy has proved itself. Every feature, including backups, schedules and preview environments, is in the free, open-source build.

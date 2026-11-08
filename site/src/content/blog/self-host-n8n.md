---
title: "Self-host n8n: a production setup with Docker and Postgres"
description: "Self-host n8n on your own server with Docker: pick SQLite or Postgres, set the webhook URL, get HTTPS, protect the encryption key and back it up."
date: 2026-11-08
category: Self-hosting
keywords: self-host n8n, n8n docker, n8n self hosted, n8n postgres, n8n webhook url, n8n encryption key
---

Your automations started in n8n Cloud, and now they touch customer data, internal APIs and a growing list of credentials. You want them on a server you control, with no per-execution pricing and no third party holding your API keys. Self-hosting n8n is a good fit for that, as long as you get four details right: the database, the public webhook URL, the encryption key and backups.

This guide walks through a production setup of self-hosted n8n with Docker. It uses the two n8n templates in LogiStack as the working example, and explains each setting so you can apply the same ideas to a plain compose file.

## Why self-host n8n

n8n is a workflow automation tool: you connect triggers (a webhook, a schedule, a new row in a database) to actions (call an API, send a message, write to a sheet) on a visual canvas, with JavaScript or Python where the nodes run out. Teams self-host it for three reasons:

- **Credentials stay with you.** Every API key and OAuth token you add lives in your database, encrypted with a key on your disk.
- **Internal network access.** A workflow on your server can reach a private database or an internal service without opening it to the internet.
- **Predictable cost.** You pay for the server, not per execution.

One point to know before you start: n8n is published under the Sustainable Use License, a fair-code license. You can self-host it for your own business at no cost, but it is not an OSI-approved open source license, and reselling n8n as a hosted service is restricted. Read the license if you plan to offer n8n to clients.

## SQLite or Postgres: which database for n8n

n8n stores workflows, credentials and execution history in a database. It supports two in practice.

| | SQLite | PostgreSQL |
| --- | --- | --- |
| Setup | Nothing to configure, one file in the n8n volume | A second service with its own volume |
| Good for | One user, light workloads, trying n8n | Teams, many executions, long history |
| Concurrency | One writer at a time | Many concurrent writers |
| Backups | Archive the volume | Database dump plus the volume |
| Scaling path | None | Queue mode with workers (needs Redis) |

If you are the only user and run a few dozen workflows, SQLite is fine. Once several people edit workflows or executions run in parallel all day, use Postgres. Moving from SQLite to Postgres later means exporting and importing workflows and credentials with the n8n CLI, so pick Postgres up front if you expect growth.

LogiStack ships both layouts as templates:

- [n8n](/templates/n8n/): n8n on SQLite, plus a separate `task-runners` service that executes Code node scripts outside the main process.
- [n8n with Postgres](/templates/n8n-with-postgres/): n8n backed by a managed PostgreSQL 17 database.

## Deploy n8n with Docker on your server

You need one Linux server with Docker, a domain name, and ports 80 and 443 open. If you do not have a platform on the server yet, install LogiStack:

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

The installer sets up Docker and Swarm when they are missing, then starts the dashboard. See [the install section](/#install) for requirements.

Then deploy the template:

1. Open a project and environment, select **New service**, then the **Templates** tile.
2. Search for `n8n` and pick **n8n** or **n8n with Postgres**.
3. The **What it creates** step lists each service with its image, port and volume. Check it and continue.
4. In **Settings**, enter your hostname in **Public URL**, for example `n8n.example.com`. Leave the credentials on **Auto-generated**.
5. Review and select **Deploy**.

![The n8n template on its What it creates step, listing the n8n service and the task-runners service](/docs/screens/template-detail.webp)

Point an `A` record for `n8n.example.com` at the server before or right after the deploy. Caddy requests a Let's Encrypt certificate as soon as the record resolves. If you leave the URL empty, you get a generated `sslip.io` hostname that works immediately. It is fine for a test, but those hostnames share one certificate rate limit with every other user, so use your own domain for anything real. The [Let's Encrypt rate limits](/blog/lets-encrypt-rate-limits/) post explains why.

The full template flow is documented in [Deploy an app from a template](/docs/deploy/templates/).

### What the SQLite template sets

The n8n template runs `n8nio/n8n` pinned to a version, with these settings worth understanding:

```bash
N8N_HOST=n8n.example.com
N8N_PROTOCOL=https
N8N_EDITOR_BASE_URL=https://n8n.example.com
WEBHOOK_URL=https://n8n.example.com
N8N_PROXY_HOPS=1
N8N_RUNNERS_ENABLED=true
N8N_RUNNERS_MODE=external
N8N_RUNNERS_AUTH_TOKEN=<generated>
N8N_BLOCK_ENV_ACCESS_IN_NODE=true
GENERIC_TIMEZONE=UTC
```

`N8N_PROXY_HOPS=1` tells n8n to trust one reverse proxy in front of it, so it reads the client IP and protocol from Caddy's forwarded headers. `N8N_BLOCK_ENV_ACCESS_IN_NODE` stops Code nodes from reading the container's environment, which matters because that environment holds secrets. The `task-runners` service connects to n8n on port 5679 with the shared auth token and runs user code in a separate container.

### What the Postgres template sets

The Postgres template adds a managed database and points n8n at it:

```bash
DB_TYPE=postgresdb
DB_POSTGRESDB_HOST=postgres
DB_POSTGRESDB_PORT=5432
DB_POSTGRESDB_DATABASE=n8n
DB_POSTGRESDB_USER=<generated>
DB_POSTGRESDB_PASSWORD=<generated>
N8N_ENCRYPTION_KEY=<generated, 64 random bytes>
WEBHOOK_URL=https://n8n.example.com/
GENERIC_TIMEZONE=<Timezone setting, UTC by default>
N8N_PROXY_HOPS=1
```

Set **Timezone** to your own zone, for example `Europe/Rome`, when you deploy, or change `GENERIC_TIMEZONE` later on the service's **Environment** tab. Schedule trigger nodes use it, so a workflow set to run "every day at 08:00" runs at 08:00 in that zone.

n8n itself listens on plain HTTP behind the proxy (`N8N_PROTOCOL=http`), and Caddy serves the editor over HTTPS. `N8N_PROXY_HOPS=1` tells n8n to trust the proxy's forwarded headers, so the session cookie keeps n8n's default `Secure` flag.

## Set the webhook URL correctly

The most common self-hosted n8n bug is a webhook node that shows `http://localhost:5678/webhook/...` as its production URL. External services then call an address they can never reach.

n8n builds webhook URLs from `WEBHOOK_URL`. Both templates set it from the domain you enter, so the URLs come out as `https://n8n.example.com/webhook/<path>`. If you change the domain later:

1. Add the new domain on the service's **Domains** tab.
2. Update `WEBHOOK_URL`, `N8N_HOST` and, on the SQLite template, `N8N_EDITOR_BASE_URL`.
3. Select **Save and redeploy**.
4. Update the webhook URL in every external service that calls you. n8n does not do this for you.

Test with a minimal workflow: a Webhook node, set to `POST`, activated. Then call it from your laptop:

```bash
curl -X POST https://n8n.example.com/webhook/ping \
  -H "Content-Type: application/json" \
  -d '{"hello": "world"}'
```

A `200` with n8n's default response means DNS, HTTPS and the webhook URL are all correct.

## Protect the encryption key

n8n encrypts every saved credential with an encryption key. Lose the key and every credential in the database becomes unreadable, even if the database itself is intact.

- On the **Postgres template**, the key is `N8N_ENCRYPTION_KEY`, generated at deploy time and stored as a secret variable. Reveal it once on the **Environment** tab and keep a copy in your password manager.
- On the **SQLite template**, n8n generates a key on first start and writes it to `/home/node/.n8n/config` inside the `n8n-data` volume. Back up that volume and the key comes with it.

Never change the key on a running instance with saved credentials. If you migrate n8n to another server, carry the same key over.

## Back up self-hosted n8n

Your workflows and credentials are the whole value of an n8n instance. Back them up from day one, to storage that is not on the same server.

For the Postgres template, create two backup policies on the service's **Backups** tab:

- A **database dump** of `postgres`, daily. This holds workflows, credentials and execution history.
- A **volume archive** of `n8n-data` on the n8n service, weekly. This holds the config file and any binary data n8n keeps on disk.

For the SQLite template, one policy covers everything: a volume archive of `n8n-data`, with **Stop n8n while archiving** turned on so the SQLite file is not copied mid-write. The service is down for the few seconds the archive takes.

Turn on encryption in the wizard and save the backup key outside the server. See [Back up a database or volume](/docs/data/backups/) for retention and scheduled restore tests, and the [database backup](/blog/database-backup/) post for the general strategy.

Two settings keep the database from growing without limit. n8n stores the input and output of every execution, which adds up fast:

```bash
EXECUTIONS_DATA_PRUNE=true
EXECUTIONS_DATA_MAX_AGE=336
```

That keeps 14 days (336 hours) of execution history. Add them on the **Environment** tab and redeploy.

## Keep n8n updated

n8n releases often, and breaking changes happen between major versions. The templates pin a specific image (a version tag or a digest), so nothing upgrades behind your back.

To upgrade:

1. Read the n8n release notes for every version between yours and the target.
2. Run the backup policies with **Run now**.
3. Change the image tag on the service and redeploy. The database migrations run on start.
4. Watch the **Logs** tab for migration errors, then open a few workflows.

On the SQLite template, upgrade `n8n` and `task-runners` to the same version. The runner image must match the main n8n version.

## Scale n8n beyond one container

A single n8n container handles a lot: hundreds of workflows and steady webhook traffic. When executions start queuing, n8n's queue mode splits the work: the main instance receives triggers and puts jobs on Redis, and separate worker containers run them. Queue mode requires Postgres, a Redis service and `EXECUTIONS_MODE=queue` on every n8n container. Neither template sets it up, so start with the Postgres template and add Redis and workers when you need them. On LogiStack you can add a managed Redis next to the stack in one click.

Before you scale out, check the obvious: long-running workflows that poll every minute, huge execution payloads, and Code nodes doing heavy work. Fixing those is usually cheaper than more workers.

## Self-hosted n8n checklist

- Your own domain, with HTTPS working.
- `WEBHOOK_URL` matches the public URL.
- Timezone set for schedule triggers.
- Encryption key saved outside the server.
- Daily backups to off-site storage, with a tested restore.
- Execution pruning on.
- Image pinned, upgrades done on purpose.
- An account owner created right after the first deploy. The editor asks for one on first visit, and until you complete it, anyone who finds the URL can.

## FAQ

### Is self-hosted n8n free?

Yes, the self-hosted Community Edition is free for internal use under the Sustainable Use License. Some enterprise features, such as SSO and environments, need a paid n8n license key. Your only other cost is the server.

### How much server do I need for n8n?

A small VPS runs n8n with SQLite for one person. For a team on Postgres, give n8n and the database a few gigabytes of RAM between them and watch memory during your heaviest workflows. Large file processing in workflows needs more.

### Why do my n8n webhooks show localhost?

`WEBHOOK_URL` is missing or wrong. Set it to your public HTTPS URL, redeploy, and reopen the workflow. External services must use the new production URL.

### Can I move from n8n Cloud to self-hosted?

Yes. Export your workflows from n8n Cloud as JSON and import them into your instance. Credentials do not transfer, because they are encrypted with a different key, so you re-enter them once.

### Can I run n8n without exposing it to the internet?

Yes, if no external service needs to call your webhooks. Publish n8n only on your private network with [Tailscale](/docs/networking/tailscale/), or keep it public and put an [IP allowlist](/docs/networking/access-control/) on the editor domain.

Running n8n is one service; running it well means a domain, certificates, secrets and backups that keep working while you build workflows. LogiStack gives you all of that from one dashboard on your own server, for n8n and the [500+ other templates](/templates/) in its catalog. [Install it](/#install) and deploy n8n in a few minutes.

---
title: "Self-host Grafana with Docker: dashboards on your own server"
description: "Self-host Grafana with Docker: deploy it with persistent storage or Postgres, connect Prometheus and SQL data sources, secure the login and back it up."
date: 2026-11-08
category: Monitoring
keywords: self-host grafana, grafana docker, grafana self-hosted, grafana prometheus, open source dashboards
---

You have numbers in three places: Prometheus metrics, a Postgres table of orders, a JSON API from a vendor. You want one screen that shows all of them, alerts when something drifts, and doesn't send your data to a SaaS. If you self-host Grafana, you get exactly that: a dashboard and alerting layer that queries your data where it lives. This guide covers running Grafana with Docker on your own server, choosing its storage, connecting data sources and keeping it secure.

## What Grafana is good at, and what it is not

Grafana does not store metrics or logs. It reads them from data sources and draws them. That split matters when you plan a setup:

- **Grafana** is the UI: dashboards, panels, variables, alert rules, users and folders.
- **A data source** holds the data: Prometheus or VictoriaMetrics for metrics, Loki for logs, PostgreSQL or MySQL for business data, plus plugins for cloud APIs and more.

So "self-host Grafana" usually means "self-host Grafana plus at least one data source". If all you need is CPU and memory per container, you may not need Grafana at all; most platforms, LogiStack included, show those numbers built in. Grafana earns its place when you want custom dashboards, business metrics next to system metrics, or alert rules across sources.

## Grafana editions and licenses

Grafana OSS is licensed under AGPL-3.0. Grafana Labs also publishes a Grafana Enterprise image that is free to run without a license key and behaves like OSS until you add one; Enterprise features such as extra data source plugins and reporting need a paid license. Grafana Cloud is the hosted service.

| Option | Where it runs | Cost model | Choose it when |
| --- | --- | --- | --- |
| Grafana OSS | Your server | Free | You want the open-source build only |
| Grafana Enterprise image | Your server | Free without a key, paid features with one | You might buy Enterprise later and want to avoid a migration |
| Grafana Cloud | Grafana Labs | Free tier, then usage-based | You don't want to run Grafana or its storage |

## Two LogiStack templates, two storage choices

Grafana keeps its own state (users, dashboards, data source settings, alert rules) in a database. By default that is SQLite inside `/var/lib/grafana`. You pick between two templates based on where you want that state:

| Template | Services | Grafana state in | Fits |
| --- | --- | --- | --- |
| [Grafana](/templates/grafana/) | `grafana` (image `grafana/grafana-enterprise:12.4`) | SQLite in the `grafana-storage` volume | One user or a small team, simplest setup |
| Grafana with PostgreSQL | `grafana` (OSS image, pinned by digest) + `postgresql` 16 | PostgreSQL | Several editors, more alert rules, cleaner backups |

The PostgreSQL template also sets `GF_SERVER_ROOT_URL`, `GF_SERVER_DOMAIN` and a generated `GF_SECURITY_ADMIN_PASSWORD`, so you never log in with a default password. With the single-container template, Grafana starts with its default `admin` / `admin` login and asks you to change it on first sign-in. Do that before you share the URL.

## Deploy Grafana step by step

If you do not have a server running LogiStack yet:

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

Then deploy the template:

1. Point `grafana.example.com` at your server with an A record.
2. In your project, select **New service** › **Templates** and search `grafana`.
3. Pick **Grafana with PostgreSQL** for a team, or **Grafana** for a single-user setup.
4. On **Settings**, set the public URL. Leave the admin and database passwords on **Auto-generated**.
5. Review and **Deploy**.

When the services are healthy, open the URL. Find the generated admin password on the `grafana` service's **Environment** tab, behind the eye icon. The [templates guide](/docs/deploy/templates/) shows every step with screenshots.

### Running Grafana with Docker by hand

If you want to see what the template does under the hood, this is the plain Docker equivalent of the single-container version:

```bash
docker volume create grafana-storage
docker run -d --name grafana \
  -p 3000:3000 \
  -v grafana-storage:/var/lib/grafana \
  -e GF_SERVER_ROOT_URL=https://grafana.example.com \
  -e GF_SECURITY_ADMIN_PASSWORD='change-me-now' \
  grafana/grafana-oss:12.4.0
```

You would still need a reverse proxy with HTTPS in front, a backup job and an upgrade routine. That is the work a PaaS template removes. Our post on Docker volumes explains why the named volume matters.

## Connect your first data sources

Open **Connections** › **Data sources** › **Add data source**. Data sources running in the same LogiStack environment are reachable by their service name on the internal network, so you never expose them publicly.

### Prometheus or VictoriaMetrics

Deploy the [Prometheus template](/templates/prometheus/) or VictoriaMetrics in the same environment. In Grafana, add a Prometheus data source with the URL:

```text
http://prometheus:9090
```

Use the service name the template created. VictoriaMetrics speaks the Prometheus query API, so the same data source type works with its own port.

Prometheus only collects what its scrape config lists, and the image's default config scrapes nothing but Prometheus itself. Write a `prometheus.yml` with your targets, for example a Node Exporter on each server or the `/metrics` endpoint of your own app, and mount it into the service as a config file. LogiStack stores config files encrypted and rolls out a new deployment when you edit one.

### PostgreSQL for business metrics

Point Grafana at a read replica or a read-only role, never at your primary with an admin user. Create the role in your database:

```sql
CREATE ROLE grafana_reader LOGIN PASSWORD 'use-a-generated-password';
GRANT CONNECT ON DATABASE app TO grafana_reader;
GRANT USAGE ON SCHEMA public TO grafana_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO grafana_reader;
```

If the database is a managed LogiStack database, you can create the role with per-table permissions from the database editor instead. Then add a PostgreSQL data source with the internal hostname, and write panels in SQL:

```sql
SELECT date_trunc('day', created_at) AS time, count(*) AS signups
FROM users
WHERE $__timeFilter(created_at)
GROUP BY 1
ORDER BY 1;
```

`$__timeFilter` is a Grafana macro that applies the dashboard's time range.

### Import a community dashboard

Under **Dashboards** › **New** › **Import**, paste a dashboard ID from grafana.com. The Node Exporter Full dashboard is a common first import for host metrics. Treat imported dashboards as a starting point and delete panels you never look at.

## Secure a self-hosted Grafana

Grafana often ends up with read access to your most sensitive databases. Lock it down:

- **Turn off sign-up.** Set `GF_USERS_ALLOW_SIGN_UP=false` on the service. Invite users from **Administration** › **Users**.
- **Turn off anonymous access** unless you want a public wall display. It is off by default; keep it off.
- **Use read-only data source users**, as above.
- **Add a gate in front.** For an internal tool, put an IP allowlist or a sign-in gateway in front of the domain. LogiStack's [access control](/docs/networking/access-control/) adds basic auth, IP allowlists or forward auth at the proxy, before a request reaches Grafana.
- **Single sign-on.** Grafana OSS supports generic OAuth, GitHub, GitLab and Google sign-in through `GF_AUTH_*` environment variables.

## Grafana alerting

Grafana can evaluate alert rules on any data source and send them to email, Slack, Mattermost, webhooks and other contact points. Configure SMTP with the `GF_SMTP_*` variables if you want email.

Keep a clear split so you don't get paged twice for the same thing. Let your platform alert on platform events (a failed deploy, a full disk, a node that went offline) and use Grafana for application and business signals: error rate above 2 percent, signups dropping to zero, queue depth growing for 15 minutes. Our post on [container monitoring](/blog/container-monitoring/) goes deeper on which signals to alert on.

## Back up Grafana

What to back up depends on the template:

- **Grafana with PostgreSQL**: back up the `postgresql` service's data volume. Turn on **Stop postgresql while archiving** for a consistent copy, or run a scheduled `pg_dump` with a schedule inside the service.
- **Grafana (SQLite)**: back up the `grafana-storage` volume with **Stop grafana while archiving** turned on, since SQLite writes to it constantly. Grafana is down for the seconds the archive takes.

Either way, the [backups guide](/docs/data/backups/) covers destinations and retention. Many teams also keep dashboards as JSON in Git and load them with Grafana's provisioning, which turns dashboards into code you can review.

## FAQ

### Is self-hosted Grafana free?

Yes. Grafana OSS is AGPL-3.0 and free to run. The Enterprise image is also free to run without a license key; you pay only if you activate Enterprise features.

### What is the difference between Grafana and Prometheus?

Prometheus collects and stores metrics and evaluates queries. Grafana draws dashboards and alerts on top of Prometheus and many other sources. Most self-hosted monitoring setups run both.

### Can Grafana show logs?

Yes, with a log data source such as Loki or Elasticsearch. Grafana itself stores no logs. If you only need to read container logs, a platform's built-in log viewer may be enough.

### How much memory does Grafana need?

Grafana itself is light; a few hundred megabytes is typical for a small team. The data sources behind it, Prometheus especially, need more as your number of series grows.

### Should I use SQLite or PostgreSQL for Grafana?

SQLite is fine for one or two users. Use PostgreSQL when several people edit dashboards, when you run many alert rules, or when you want database dumps rather than volume archives.

Grafana turns scattered numbers into one view you control. [Install LogiStack](/#install), deploy Grafana next to Prometheus, and you have dashboards with HTTPS, access control and backups in one place. For the bigger picture of what to watch on a server, read our guide to [server monitoring](/blog/server-monitoring/).

---
title: "Self-host Uptime Kuma: monitoring and status pages with Docker"
description: "Self-host Uptime Kuma with Docker: deploy version 2, put it on the right server, add monitors and alerts, publish a status page and back up its data."
date: 2026-11-08
category: Self-hosting
keywords: self-host uptime kuma, uptime kuma docker, uptime kuma status page, uptime kuma v2, self-hosted uptime monitoring
---

You find out your site is down when a customer emails you. A hosted uptime service would catch it, but the free tiers check every few minutes, cap the number of monitors, and put their logo on your status page. Self-hosting Uptime Kuma fixes all three: one small container checks as many endpoints as you like, as often as you like, and serves a status page on your own domain.

This guide covers a production setup of self-hosted Uptime Kuma with Docker: where to run it, how to deploy version 2, which monitors and notifications to set up first, the status page, and backups.

## What Uptime Kuma does

Uptime Kuma is an open source (MIT) monitoring tool with a web interface. It checks targets on an interval and alerts you when one fails. It supports, among others:

- **HTTP(S)** checks, with keyword or JSON matching on the response body.
- **TCP port**, **ping** and **DNS** checks.
- **Push** monitors, where your cron job or backup script calls Uptime Kuma, and silence means failure.
- **Database** checks for PostgreSQL, MySQL, MongoDB and Redis.
- **Docker container** checks against a Docker host.
- **TLS certificate expiry** warnings on HTTPS monitors.

Alerts go to dozens of channels: email, Slack, Discord, Telegram, Microsoft Teams, ntfy, webhooks and more. Public status pages show selected monitors with history and incident notes.

What it is not: a metrics system. It answers "is it up and how fast does it respond", not "why is the CPU at 90%". For that you want host and container metrics; the [server monitoring](/blog/server-monitoring/) post covers the difference.

## Where to run Uptime Kuma

This decision matters more than any setting. A monitor that lives on the server it watches goes down with it, and then nobody sends the alert.

| Placement | Catches | Misses |
| --- | --- | --- |
| Same server as your apps | App crashes, bad deploys | Server, network or provider outages |
| A second server, other provider or region | Everything above, plus server and provider outages | Outages of the monitor's own provider |
| A machine at home or in the office | Public reachability from a real network | Your home connection going down looks like an outage |

The good default is a small, cheap server at a different provider from your apps. Uptime Kuma needs very little memory and CPU, so the smallest VPS tier of most providers is enough. If you already run a LogiStack cluster with nodes at two providers, you can pin Uptime Kuma to the node at the other one.

## Deploy Uptime Kuma with Docker

On a fresh server, install LogiStack first:

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

It installs Docker and Swarm if they are missing. Then deploy the template:

1. Open a project, select **New service**, then the **Templates** tile.
2. Search for `uptime kuma` and select [Uptime Kuma](/templates/uptime-kuma/).
3. Enter your hostname in **Public URL**, for example `status.example.com`.
4. Review and select **Deploy**.

The template runs one service from the `louislam/uptime-kuma:2` image, listening on port 3001 behind Caddy, with its data in a volume named `uptime-kuma-data` mounted at `/app/data`. A healthcheck runs the image's own `extra/healthcheck` script, so the dashboard shows the service as healthy only when Uptime Kuma answers.

Point an `A` record for the hostname at the server. Caddy gets the Let's Encrypt certificate on its own once DNS resolves. Details are in [Add a domain to a service](/docs/networking/domains/).

If you prefer a plain compose file, the equivalent is short:

```yaml
services:
  uptime-kuma:
    image: louislam/uptime-kuma:2
    volumes:
      - uptime-kuma-data:/app/data
    restart: unless-stopped
volumes:
  uptime-kuma-data:
```

You still need a reverse proxy with HTTPS and WebSocket support in front of it. The interface runs over a WebSocket (Socket.IO), and a proxy that drops the upgrade leaves you with a login page that never loads. Caddy proxies WebSockets with no extra config.

## SQLite or MariaDB in Uptime Kuma 2

Version 1 stored everything in SQLite. Version 2 asks on first start which database to use:

- **SQLite**: one file in `/app/data`. Fine for most setups, up to a few hundred monitors.
- **Embedded MariaDB**: a MariaDB server inside the same container, data still in `/app/data`.
- **External MariaDB or MySQL**: a separate database service.

For a single monitoring instance, SQLite is the simple choice and the one this guide assumes. If you want a separate database service from the start, LogiStack also has [Uptime Kuma with MariaDB](/templates/uptime-kuma-with-mariadb/) and [Uptime Kuma with MySQL](/templates/uptime-kuma-with-mysql/) templates.

Upgrading from version 1 runs a data migration on first start. On a large SQLite file with long history it can take a while. Back up the volume first and do not stop the container mid-migration.

## First login and the monitors to add first

Open the URL right after the deploy and create the admin account. Until you do, the setup page is open to anyone who finds it. Then turn on two-factor authentication under **Settings › Security**.

Start with a short list that covers the real failure modes:

1. **HTTP(S) on each public site**, with a keyword match on text that only appears when the page renders correctly. A `200` from an error page or a parked domain is not "up".
2. **An API health endpoint**, with a JSON query on the status field if your API returns one.
3. **TCP or database checks** on critical internal services, if Uptime Kuma can reach them over a private network.
4. **Push monitors for scheduled jobs.** Your nightly job calls the push URL at the end; if the call does not arrive within the interval, you get an alert.

A push call is one line at the end of a script:

```bash
curl -fsS "https://status.example.com/api/push/AbC123xYz?status=up&msg=OK"
```

Set intervals to match how fast you need to know. Sixty seconds is a reasonable default for public sites. Set **Retries** to 1 or 2 so a single slow response does not page you at night.

## Notifications that reach you

Add at least two channels in **Settings › Notifications**, on different systems, for example a chat channel for the team and an email or push notification to your phone. Use **Test** on each one before you trust it. Then apply them to your monitors, or set one as the default for new monitors.

Uptime Kuma's alerts complement the platform's own. LogiStack sends its alerts (failed deployments, failed backups, node and service thresholds) through its own [notification channels](/docs/operations/alerts-and-notifications/). Uptime Kuma checks from the outside, the way a user sees your site. Run both. The [uptime monitoring](/blog/uptime-monitoring/) guide covers how they fit together.

## Publish a status page on your own domain

A status page tells users what is broken before they open a ticket.

1. In Uptime Kuma, select **Status Pages › New Status Page**, give it a name and a slug.
2. Add groups and pick the monitors to show. Leave internal monitors off a public page.
3. Under the page's settings, add your status domain, such as `status.example.com`.

The dashboard and the status pages share one service. If you want the dashboard on one hostname and the status page on another, add both hostnames to the service on its **Domains** tab, and set the status page's domain in Uptime Kuma. Then restrict the admin hostname with an [IP allowlist](/docs/networking/access-control/) so only your office or VPN can reach the login.

## Back up Uptime Kuma

All state lives in `/app/data`: monitors, notification settings, history, status pages and, with SQLite, the database itself. Back up that one volume.

On LogiStack, open the service's **Backups** tab and create a policy for the `uptime-kuma-data` volume:

- **Schedule**: daily is enough.
- **Consistency**: turn on **Stop uptime-kuma while archiving**, so the SQLite file is not copied while it is being written. The monitor pauses for a few seconds.
- **Destination**: a bucket at another provider.
- **Encryption**: keep it on, and save the key.

See [Back up a database or volume](/docs/data/backups/). To restore onto a new server, deploy the same template and restore the volume archive into it from the **Backups** tab.

History grows with every check. Under **Settings › Monitor History**, set how many days to keep. Thirty to ninety days is plenty for most teams.

## Keep it updated

The template uses the `2` tag, which follows version 2 releases. Read the release notes before a redeploy pulls a newer image, and back up first. If you want full control over when changes land, pin a specific version tag on the service instead.

## FAQ

### Is Uptime Kuma free?

Yes. Uptime Kuma is open source under the MIT license, with no paid edition. Your only cost is the server it runs on.

### Can Uptime Kuma monitor services that are not public?

Yes, if the Uptime Kuma container can reach them. Services on the same LogiStack environment network are reachable by name, and you can join the monitoring server to a private network such as Tailscale for the rest.

### How many monitors can Uptime Kuma handle?

Hundreds on a small server with SQLite. Very short intervals across many monitors raise CPU use and database size, so prefer 60-second intervals and prune history.

### Should I use Uptime Kuma or a hosted uptime service?

A hosted service is better if you want checks from many regions with no server to maintain. Uptime Kuma is better if you want unlimited monitors, push monitors for internal jobs, and a status page on your domain at a fixed cost. Some teams run both.

### Does Uptime Kuma support multiple users?

No. It has one admin account. If several people need access, share the account through a password manager or let them use the public status page.

Uptime Kuma is one of the [500+ templates](/templates/) LogiStack deploys with a domain, HTTPS and backups set up for you. [Install LogiStack](/#install) on a second server and you have an outside view of everything else you run.

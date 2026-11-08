---
title: "Uptime monitoring: what to check, how often, and with what"
description: "A practical guide to uptime monitoring: which checks catch real outages, how to avoid false alarms, the uptime math, and self-hosted tools that do it well."
date: 2026-11-08
category: Monitoring
keywords: uptime monitoring, website uptime monitoring, uptime monitor, self-hosted uptime monitoring, status page
---

Your dashboards are green, CPU is at 20%, and the database answers every query. Meanwhile a customer emails to say the site has shown a certificate error since breakfast. Internal metrics describe how your servers feel. Uptime monitoring answers a different question: can a user, somewhere on the internet, reach your app and get the right answer right now? This guide covers which checks to run, how often, how to keep false alarms out of your phone, and which tools to use, including ones you can host yourself.

## What uptime monitoring actually measures

An uptime monitor sends a request to your service from outside your network on a fixed interval and records whether the answer was acceptable. That outside view matters. A server can be healthy while the DNS record points somewhere else, the load balancer drops connections, or a firewall change blocks port 443. None of those show up in host metrics.

The output is a time series of up and down, from which you get three things:

- **Alerts** when a check fails, so someone acts before users pile up in support.
- **Availability numbers** per week, month or quarter, which you can compare to a target.
- **A record of incidents** with start and end times, useful for postmortems and for customers who ask.

If you want the inside view too, read our guide to [server monitoring](/blog/server-monitoring/). The two complement each other: uptime checks tell you that something is wrong, metrics and logs tell you why.

## The checks worth running

Not every check is an HTTP ping. Pick the ones that match how your service can fail.

| Check | What it catches | Typical target |
| --- | --- | --- |
| HTTP status | Server down, proxy errors, 5xx after a bad deploy | `https://app.example.com/healthz` expects 200 |
| Keyword or JSON body | Page serves 200 but shows an error or empty state | Body contains `"status":"ok"` |
| TLS certificate expiry | Renewal that silently failed | Warn at 14 days, alert at 7 |
| DNS record | Record deleted, changed or hijacked | `A app.example.com` equals your IP |
| TCP port | Non-HTTP services: SMTP, game servers, databases you expose on purpose | `mail.example.com:587` accepts a connection |
| Heartbeat (push) | Cron jobs and workers that stop running | The job calls a URL on every run; silence is the alert |

### Check a health endpoint, not just the home page

A home page served from a CDN cache can answer 200 while your backend is down. Give the app a small endpoint that touches its real dependencies:

```ts
// GET /healthz: cheap, fast, and honest about dependencies
app.get("/healthz", async (c) => {
	await db.execute("select 1");
	await redis.ping();
	return c.json({ status: "ok" });
});
```

Keep it fast (under 100 ms) and unauthenticated, but make it return nothing sensitive. If a dependency is optional, report it in the body instead of failing the whole check.

### Heartbeats for things that do not listen

Background workers and scheduled jobs have no URL to poll. Flip the direction: the job calls a unique URL when it finishes, and the monitor alerts when a call does not arrive in time. A nightly backup that stopped running three weeks ago is one of the most common silent failures, and a heartbeat catches it on the first missed night.

```sh
#!/bin/sh
set -eu
pg_dump "$DATABASE_URL" | gzip > /backups/nightly.sql.gz
curl -fsS --retry 3 https://hc.example.com/ping/0f3c1a9e-nightly-backup
```

Because of `set -eu`, the ping only happens when the dump succeeds.

## How often to check

The interval sets how quickly you learn about an outage and how much noise you get.

- **30 to 60 seconds** for user-facing apps and APIs. Most outages that matter last longer than a minute.
- **5 minutes** for internal tools, docs sites and anything nobody pays for.
- **Daily** for certificate expiry and DNS records. They change slowly.

Shorter intervals look attractive but rarely change the outcome. Nobody fixes an incident in the 30 seconds a 30-second interval saves over a 60-second one. They do increase the chance of alerting on a single dropped packet.

## Avoid false alarms

An uptime monitor that pages for nothing gets muted, and then it pages for nothing when something is actually down. A few rules keep it trustworthy:

1. **Retry before alerting.** Require two or three consecutive failures. A single timeout is often the network between the monitor and you.
2. **Check from more than one location.** Alert only when at least two locations agree. One region's routing problem is not your outage.
3. **Set realistic timeouts.** 10 seconds for a page, 5 for a health endpoint. A 1-second timeout on a cold start produces false alarms every morning.
4. **Pause checks during planned maintenance.** Most tools have maintenance windows. Use them.
5. **Alert on recovery too.** A "resolved" message closes the loop, so nobody keeps investigating a problem that ended.

## The uptime math

Availability targets sound close together but mean very different amounts of downtime. Here is the budget for a 30-day month and a year:

| Availability | Downtime per month | Downtime per year |
| --- | --- | --- |
| 99% | 7 h 12 min | 3 days 15 h |
| 99.5% | 3 h 36 min | 1 day 19 h |
| 99.9% | 43 min | 8 h 46 min |
| 99.95% | 22 min | 4 h 23 min |
| 99.99% | 4 min 19 s | 52 min |

Two consequences follow. First, a single server with a 30-minute maintenance window each month already spends most of a 99.9% budget. Second, measuring 99.99% honestly needs a check interval well under a minute and several locations, because one missed outage of five minutes breaks the month.

Pick a target you can defend with your architecture. For a single-node setup, 99.5% to 99.9% is realistic. Higher numbers need redundancy: several nodes, health-checked rolling updates, and a database that survives a node loss. Our guide to [zero-downtime deployments](/blog/zero-downtime-deployments/) covers the deploy side.

## Status pages

A status page is uptime data you show to users. It saves your support inbox during an incident and builds trust the rest of the time.

- **Host it somewhere else.** A status page on the same server as the app goes down with it.
- **Show components users recognize**: "Dashboard", "API", "Email delivery", not "web-2".
- **Write incident updates by hand.** Automated green and red dots are a start. A sentence like "Payments fail for some cards, we are rolling back" is what users want.

## Uptime monitoring tools

You can rent uptime monitoring or run it yourself. Both are reasonable, and the right answer often mixes them.

| Tool | Hosting | Good at |
| --- | --- | --- |
| Uptime Kuma | Self-hosted, open source | Friendly UI, many check types, status pages, many notification channels |
| Gatus | Self-hosted, open source | Checks defined in YAML, conditions on status, body, latency and certificate |
| Healthchecks | Self-hosted or hosted, open source | Heartbeat monitoring for cron jobs and workers |
| UptimeRobot, Better Stack, Pingdom | Hosted SaaS | Checks from many regions, no infrastructure to run |

### Self-hosted: put it somewhere else

The one rule for a self-hosted monitor: do not run it on the servers it watches. If the server dies, the monitor dies with it and stays quiet. Run it on a small separate VPS, in another provider or region if you can. A 1 GB machine is plenty for Uptime Kuma or Gatus watching dozens of endpoints.

Uptime Kuma, Gatus and Healthchecks are all in LogiStack's [template catalog](/templates/), as [`uptime-kuma`](/templates/uptime-kuma/), `gatus` and `healthchecks`. Our walkthrough on how to [self-host Uptime Kuma](/blog/self-host-uptime-kuma/) covers the setup step by step.

### Hosted: when it is the better fit

A hosted service is the better choice when you have no second server, when you need checks from many continents, or when nobody on the team wants to maintain one more app. Many teams run both: a hosted monitor watches the public endpoints and the self-hosted monitor, and the self-hosted one watches everything internal.

## Where LogiStack fits

LogiStack is an open-source, self-hosted PaaS on Docker Swarm. It is not an external uptime monitor, and it does not probe your URLs from the internet. It watches the inside, and it does so without setup:

- **Health checks gate every rollout.** A service can define an HTTP, TCP or command health check in its [settings](/docs/deploy/service-settings/). A new replica takes traffic only once the check passes, so a broken build never replaces a working one.
- **Crash loops raise an event.** When a service's tasks keep failing, LogiStack emits `service.crash_loop`, and again when it settles.
- **Node down after 30 seconds.** A built-in alert fires when a node's agent misses heartbeats for 30 seconds.
- **Certificate events.** Expiring and failed certificates each have their own event.
- **Failed schedules and backups** send events too, which covers much of what you would otherwise wire up with heartbeats.

Rules route those events to Slack, Discord, email, Telegram, Microsoft Teams, Mattermost, ntfy, Gotify, Pushover or a signed webhook. See [alerts and notifications](/docs/operations/alerts-and-notifications/).

![LogiStack monitoring settings with node thresholds and a service memory threshold](/docs/screens/monitoring-alerts.webp)

Pair those internal signals with one external monitor on a separate machine. You can deploy that monitor from the same LogiStack template catalog onto a second, independent LogiStack install or any small VPS.

## FAQ

### What is the difference between uptime monitoring and server monitoring?

Uptime monitoring checks from the outside whether users can reach your service and get a correct answer. Server monitoring records CPU, memory, disk and network from the inside. You need both: uptime checks catch DNS, TLS and network failures that metrics miss, and metrics explain why a check failed.

### How often should an uptime monitor check my site?

Every 30 to 60 seconds for user-facing apps, every 5 minutes for internal tools, and once a day for certificate expiry and DNS. Combine short intervals with two or three retries so a single dropped request does not page anyone.

### Can I self-host uptime monitoring?

Yes. Uptime Kuma and Gatus are open source and run in a single container. Run them on a different server, ideally a different provider, from the apps they watch, or they go down together.

### What uptime percentage should I promise?

Promise what your architecture supports. A single server with occasional maintenance lands around 99.5% to 99.9%. Going higher needs multiple nodes, health-checked rolling deploys and a database that survives losing a machine.

### How do I monitor cron jobs?

Use heartbeat checks. The job calls a unique URL when it succeeds, and the monitor alerts when the call does not arrive on time. Healthchecks is built for this, and most uptime tools support push monitors.

If you want the internal half handled for you, health-checked rollouts, crash-loop and node-down alerts included, [install LogiStack](/#install) on your server and add an external monitor from the template catalog on a second one.

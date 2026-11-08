---
title: "Self-host Umami: a privacy-friendly Google Analytics alternative"
description: "Self-host Umami analytics on your own server: deploy it with Postgres, add the tracking script and keep visitor data out of third-party hands."
date: 2026-11-08
category: Self-hosting
keywords: self-host umami, umami analytics, google analytics alternative, privacy-friendly analytics, cookieless analytics
---

You want to know which pages people read and where they come from. You do not want a cookie banner, a 40 KB tracking script, or a third party building profiles of your visitors. If you self-host Umami, you get the numbers that matter (page views, referrers, countries, devices, custom events) in a dashboard you own, with visitor data that never leaves your server. This guide shows how to run Umami as a Google Analytics alternative, from the first deploy to the tracking script and the backups.

## Why teams replace Google Analytics with Umami

Google Analytics 4 is free and detailed, and for a marketing team running paid campaigns it is often still the right tool. For most product sites, docs and blogs, it is more than you need and it comes with costs that are not on an invoice:

- **Consent.** GA sets cookies and sends data to Google. In the EU and UK that usually means a consent banner, and a share of visitors who decline and vanish from your numbers.
- **Complexity.** GA4's event model and reports take time to learn. Most people want five numbers and a chart.
- **Weight.** The GA tag plus Google Tag Manager adds noticeable script weight. Umami's tracker is a small script.
- **Ownership.** Your traffic data sits in someone else's account, under their retention rules.

Umami takes the opposite approach. It does not set cookies, it does not store IP addresses, and it builds a visitor ID from a hash that rotates, so it can count unique visitors without tracking a person across days. It is open source under the MIT license, written in TypeScript on Next.js, and stores its data in PostgreSQL.

A fair caveat: "cookieless" is not the same as "no legal review needed". Many teams run Umami without a consent banner, but whether that holds for you depends on your jurisdiction and what else your site does. Ask whoever handles privacy for your company.

## Umami vs. other privacy-friendly analytics

Umami is one of several good options. Pick by what you want to run and maintain.

| Tool | License | Storage | Strength | Consider it when |
| --- | --- | --- | --- | --- |
| Umami | MIT | PostgreSQL | Simple UI, custom events, multiple sites and teams | You want a light dashboard on a database you already know |
| Plausible CE | AGPL-3.0 | PostgreSQL + ClickHouse | Polished reports, fast at high volume | You expect very large traffic and accept running ClickHouse |
| Matomo | GPL-3.0 | MySQL or MariaDB | Closest feature set to GA, heatmaps via plugins | You need GA-style depth and goals, and can run PHP |
| GoatCounter | EUPL | PostgreSQL or SQLite | Tiny, almost no setup | You want the bare minimum |
| Google Analytics 4 | Proprietary | Google | Ads integration, funnels, audiences | You run paid acquisition and need attribution |

LogiStack ships templates for [Matomo](/templates/matomo/), [GoatCounter](/templates/goatcounter/) and Rybbit too, so you can try two side by side before you commit.

## What the Umami template deploys

The [Umami template](/templates/umami/) creates two services:

| Service | Image | What it does |
| --- | --- | --- |
| `umami` | `ghcr.io/umami-software/umami:3.4.0` | The app, listening on port 3000, with a health check on `/api/heartbeat` |
| `db` | Managed PostgreSQL 15 | Stores sites, users and events in the `db-data` volume |

It asks for three values: the public domain, an app secret and a database password. The secret (64 random bytes) and the password are generated for you and stored as encrypted secret variables. You only type the domain.

Because the database is a managed LogiStack database rather than a plain container, it gets the built-in database editor and `pg_dump` backups, which matters later.

## Deploy Umami step by step

You need a LogiStack server first. If you do not have one, install it on any Ubuntu or Debian VPS with 2 GB of RAM:

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

Then:

1. Point a DNS record such as `stats.example.com` at your server's IP. An A record is enough.
2. Open a project and environment, select **New service**, then the **Templates** tile.
3. Search for `umami` and select the card. The **What it creates** step lists both services and the volume.
4. On **Settings**, enter `stats.example.com` as the public URL. Leave the credentials on **Auto-generated**.
5. On **Review**, select **Deploy**.

LogiStack starts the database first, then Umami. When both are healthy you see a link to the app. Caddy has already requested a Let's Encrypt certificate for the hostname. The full flow, with screenshots, is in the [templates guide](/docs/deploy/templates/).

![The LogiStack template gallery with search, category filters and app cards](/docs/screens/templates.webp)

If you skip the domain, you get a generated `sslip.io` address. That is fine for a quick look, but those hostnames share one Let's Encrypt quota with the whole internet. Our post on [Let's Encrypt rate limits](/blog/lets-encrypt-rate-limits/) explains why you should use your own domain for anything you keep.

### Sign in and change the default password

Umami creates a default account on first start: user `admin`, password `umami`. Sign in right away, open **Settings** › **Profile** and change the password. Then create a personal user for each teammate under **Settings** › **Users** instead of sharing the admin login.

## Add the tracking script to your site

In Umami, open **Settings** › **Websites** › **Add website**, enter a name and the domain you want to track, and save. Open the website's **Tracking code** tab. It gives you a snippet like this:

```html
<script defer src="https://stats.example.com/script.js"
  data-website-id="3f6c2a1e-8d4b-4c2e-9a71-5b0f6e2d9c84"></script>
```

Paste it in the `<head>` of every page. In a Next.js app, put it in the root layout with `next/script` and `strategy="afterInteractive"`. In a static site, put it in the base template.

Useful attributes on the script tag:

- `data-domains="example.com,www.example.com"` only records hits from those hostnames, so staging and localhost do not pollute your numbers.
- `data-auto-track="false"` turns off automatic page views when you want to send them yourself, for example in a single-page app with a custom router.

### Track events

Page views come for free. For clicks and conversions, add a data attribute to the element:

```html
<button data-umami-event="signup-click" data-umami-event-plan="pro">
  Start free trial
</button>
```

Or call the tracker from your code:

```js
umami.track("checkout-complete", { plan: "pro", seats: 5 });
```

Events show up on the website's **Events** tab, with their properties.

## Will ad blockers block self-hosted Umami?

Some will. Filter lists include common analytics paths such as `/script.js` on known Umami hosts. Running Umami on your own subdomain already helps, because you are not on a shared public host. You can go further:

- Rename the tracker file with the `TRACKER_SCRIPT_NAME` environment variable, for example `TRACKER_SCRIPT_NAME=app.js`, and update the `src` in your snippet.
- Serve the script and the collect endpoint from your main domain through a path proxy, so the request is first-party.

Set `TRACKER_SCRIPT_NAME` on the `umami` service in its **Environment** tab. The change waits as a pending diff until you deploy it.

Be honest with yourself about the goal. Hiding analytics from people who chose to block it is a choice some readers dislike. Many teams accept a few percent of blocked hits and leave it there.

## Back up your analytics data

Your Umami data is the `db` service. Losing it means losing your history, so set up a backup policy before you forget:

1. Add an S3 destination (Cloudflare R2, Backblaze B2, AWS S3 or a bucket on another server).
2. Open the `db` service, select **Backups**, then **Set up backups**.
3. Pick the database, the destination and a schedule. The default runs daily at 03:00 and keeps the newest 14 dumps.
4. Leave **Verify on a schedule** on. A verify restores the newest dump into a throwaway container and runs a sanity query, without touching the live database.

The [backups guide](/docs/data/backups/) covers encryption and retention. The `umami` service itself holds no data, so you do not need a volume backup for it.

## Keep Umami fast as traffic grows

Umami on PostgreSQL handles a lot of traffic for a small server. A few habits keep it that way:

- **Give the database the memory.** Most of the load is Postgres. Set CPU and memory limits on the `umami` service and leave headroom for `db`.
- **Watch disk.** Every page view is a row. Check the service metrics and add a disk threshold alert on the node.
- **Upgrade in steps.** The template pins `3.4.0`. To upgrade, change the image tag in the service settings and deploy. Read Umami's release notes first: major versions run database migrations on start.
- **Keep one replica.** Umami does not need several replicas at small scale, and one replica keeps migrations simple.

If you outgrow PostgreSQL at very high volume, Umami also supports ClickHouse for event storage. Most sites never get there.

## FAQ

### Is Umami really free?

Yes. Umami is MIT-licensed and the self-hosted version has no feature limits. The company behind it sells Umami Cloud for people who do not want to host it. When you self-host, your only cost is the server.

### Is Umami GDPR compliant?

Umami does not use cookies, does not store IP addresses and does not track visitors across days, which removes the usual reasons for a consent banner. Compliance depends on your whole setup, though, so check with your privacy lead rather than relying on a tool's claim.

### Can Umami track several websites?

Yes. One Umami install tracks any number of sites. Each gets its own website ID and snippet, and you can share a site with a team or through a public link without giving out the admin login.

### Can I import my Google Analytics history?

Not directly. Umami starts counting from the day you add the script. Many teams run GA and Umami side by side for a month, compare the numbers, then remove GA.

### How much server do I need?

A 2 GB VPS runs LogiStack, Umami and its database for a typical blog or product site. Add memory for the database as traffic grows, and keep the backup on a different server.

Umami gives you the analytics most sites need without handing your visitors to an ad company. [Install LogiStack](/#install), deploy the template, and you have private analytics with HTTPS and daily backups in a few minutes. If you are building out a small stack of tools, our guide to [homelab self-hosting](/blog/homelab-self-hosting/) is a good next read.

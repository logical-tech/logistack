---
title: "Self-host Ghost: run your blog and newsletter with Docker"
description: "Self-host Ghost with Docker and MySQL: set the site URL, secure the database, configure email for members and newsletters, and back up content and data."
date: 2026-11-08
category: Self-hosting
keywords: self-host ghost, ghost docker, ghost cms self hosted, ghost mysql, ghost newsletter self hosted, ghost mailgun
---

You want a blog and a newsletter on your own domain, with members, without a platform taking a cut of your subscriptions or deciding what your theme can do. Ghost covers that, and Ghost(Pro) hosts it for you, but the monthly price climbs with your member count. Self-hosting Ghost puts the same software on a server you pay for directly. The template sets the site URL and generates the database password; the work left is email, backups and updates.

This guide shows how to self-host Ghost with Docker and MySQL in production, using the LogiStack Ghost template as the starting point, then adding what a template cannot know about your setup.

## What you get with self-hosted Ghost

Ghost is an open source (MIT) publishing platform written in Node.js. The self-hosted version has the same core as Ghost(Pro):

- A fast editor with cards for images, embeds, code, buttons and paywalls.
- **Members and newsletters**: free and paid tiers, sign-up forms, email delivery of posts.
- **Paid subscriptions** through your own Stripe account. Ghost takes no percentage.
- Themes in Handlebars, a Content API for headless use, and an Admin API for automation.

What changes when you self-host: you run updates, backups and email delivery yourself, and you need a separate service for bulk newsletter sending (more on that below). If you never want to think about any of that and your list is small, Ghost(Pro) is a reasonable choice and it funds the project. Self-hosting pays off when you want full control, run several sites, or have a large free list.

## What the Ghost template deploys

The [Ghost](/templates/ghost/) template creates two services:

| Service | Image | Port | Volume |
| --- | --- | --- | --- |
| `ghost` | `ghost:6-alpine` | 2368, public | `ghost` at `/var/lib/ghost/content` |
| `db` | Managed MySQL 8.0 | internal only | `db` at `/var/lib/mysql` |

Ghost's official image reads its config from environment variables, using double underscores for nesting. The template sets:

```bash
database__client=mysql
database__connection__host=db
database__connection__user=root
database__connection__password=<generated>
database__connection__database=ghost
url=https://blog.example.com
```

The database password is generated at deploy time and shared by both services, and `url` is the HTTPS address of the domain you enter. What the template cannot know about is your email setup and, if you want one, a database user with fewer rights than root. Both are covered below.

MySQL 8 is the only database Ghost supports in production. SQLite works for local development only.

## Deploy Ghost on your server

You need a Linux server with Docker, a domain, and ports 80 and 443 open. Install LogiStack if the server is new:

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

Then:

1. Open a project, select **New service**, then the **Templates** tile.
2. Search for `ghost` and select the card. Check **What it creates**.
3. Enter your hostname in **Public URL**, for example `blog.example.com`.
4. Review and select **Deploy**.
5. Point an `A` record for the hostname at the server. Caddy gets the certificate once it resolves.

The full flow, including where generated values live, is in [Deploy an app from a template](/docs/deploy/templates/).

## The Ghost URL

Ghost uses `url` to build every link it renders: post URLs, image URLs, the sitemap, RSS, and the links in newsletter emails. The template sets it to `https://` plus your domain, so links and emails point at the secure address.

Caddy terminates HTTPS and forwards the request to Ghost with `X-Forwarded-Proto: https`, so Ghost knows the request was secure and does not redirect in a loop.

If you later move to a new domain, change `url` on the `ghost` service's **Environment** tab, select **Save and redeploy**, and add the new hostname on the **Domains** tab. Ghost stores absolute URLs only in a few places, so most content follows the new value. Set up a redirect from the old hostname so existing links and search rankings carry over.

## Give Ghost its own database user

The template generates the MySQL root password and Ghost connects as root. The database is not exposed outside the environment network, so that is safe to start with. If you want Ghost to have only the rights it needs, give it its own user. MySQL reads `MYSQL_ROOT_PASSWORD` only when it creates an empty data directory, so to change the root password later, change it inside the database first, then on the `db` service.

1. Open the `db` service and its **Database** tab. In the **Roles** view, create a user, for example `ghost`, with a long random password and rights on the `ghost` database.
2. On the `ghost` service's **Environment** tab, set `database__connection__user=ghost` and `database__connection__password` to the new password, marked as secret. Save and redeploy.

If you prefer SQL, open the `db` service's **Terminal** tab and run:

```sql
CREATE USER 'ghost'@'%' IDENTIFIED BY 'a-long-generated-password';
GRANT ALL PRIVILEGES ON ghost.* TO 'ghost'@'%';
FLUSH PRIVILEGES;
```

See [Deploy a database](/docs/deploy/databases/) for how credentials work on managed databases.

## Create the owner account

Open `https://blog.example.com/ghost/` right after the deploy and create the owner account. Until you do, anyone who reaches that page can claim the site. Then add staff users under **Settings › Staff** instead of sharing the owner login.

## Configure email: transactional and newsletters

Ghost sends two kinds of email, and they use different settings.

**Transactional email** covers sign-in links for members, staff invitations and password resets. Members sign in with magic links, so without working transactional email nobody can log in to your membership. Configure it with SMTP environment variables on the `ghost` service:

```bash
mail__transport=SMTP
mail__from=Example Blog <noreply@example.com>
mail__options__host=smtp.example-provider.com
mail__options__port=587
mail__options__secure=false
mail__options__auth__user=postmaster@example.com
mail__options__auth__pass=<your SMTP password>
```

Any transactional email provider with SMTP works. Mark the password as secret when you add it.

**Newsletter delivery** (sending posts by email to your members) does not use SMTP. Ghost sends bulk email through Mailgun's API only. Add your Mailgun domain and API key in Ghost Admin under **Settings › Email newsletter**. Without it, you can publish and accept members, but posts are not emailed.

Set up SPF, DKIM and DMARC records for your sending domain with both providers. Most deliverability problems trace back to a missing record.

## Store images and themes safely

Everything you upload lives in the `ghost` volume at `/var/lib/ghost/content`: images, themes, uploaded files, and logs. The database holds posts, members, settings and newsletter history. You need both to restore a site.

Themes are uploaded as zip files in **Settings › Design**. If you edit theme files directly in the volume, the next theme upload overwrites them, so keep your theme in Git and upload a new zip to deploy changes.

## Back up self-hosted Ghost

Create two backup policies on LogiStack, both to a bucket at another provider:

- **Database dump** of `db`, daily. A `mysqldump --single-transaction` is consistent without stopping Ghost.
- **Volume archive** of the `ghost` volume, daily or weekly depending on how often you upload images.

Keep encryption on and save the key outside the server. Scheduled restore tests check that the newest database dump actually restores. Setup is in [Back up a database or volume](/docs/data/backups/).

Ghost also has its own export under **Settings › Advanced › Import/Export**: a JSON file with posts, tags and settings, plus a members CSV. Download one before major upgrades. It is a good portable copy, but it does not include images or themes, so it does not replace the volume backup.

## Update Ghost

The template uses the `6-alpine` tag, so a redeploy picks up the latest Ghost 6 release. Ghost runs its database migrations on start.

Before a major version (6 to 7, for example):

1. Read Ghost's upgrade notes. Major versions can drop old theme helpers.
2. Check your theme with Ghost's theme validator, GScan.
3. Run both backup policies with **Run now** and download a JSON export.
4. Change the image tag on the `ghost` service and redeploy.
5. Watch the **Logs** tab for migration errors.

## Performance and caching

A single Ghost container serves a typical blog comfortably on a small server. If a post goes viral, put a CDN in front of the domain. With Cloudflare proxying the hostname, use a [Cloudflare origin certificate](/docs/networking/https-certificates/) between Cloudflare and your server. Ghost Admin and member endpoints must not be cached, so cache only public pages and assets.

## FAQ

### Is self-hosted Ghost free?

Yes. Ghost is open source under the MIT license and the self-hosted version includes members, paid subscriptions and newsletters. You pay for the server, your email provider, and Stripe's payment fees.

### Can Ghost use PostgreSQL or MariaDB?

No. Ghost supports MySQL 8 in production. MariaDB is not supported and can break migrations. SQLite is for local development only.

### Why do my Ghost member sign-in emails not arrive?

Transactional email is not configured, or the provider rejects the sender. Set the `mail__` variables, check the `ghost` service logs for SMTP errors, and verify SPF and DKIM for the sending domain.

### Can I move from Ghost(Pro) to self-hosted Ghost?

Yes. Export your content JSON and members CSV from Ghost(Pro), download your theme and images, then import them on your instance. Reconnect Stripe and Mailgun in the settings.

### How do I run several Ghost sites on one server?

Deploy the template once per site, each in its own environment or project. Each site gets its own database, volume and domain, and LogiStack routes them through the same Caddy proxy.

A self-hosted Ghost site needs HTTPS, a database, backups and updates that do not break on a Sunday. LogiStack handles the platform side so you can spend the time writing. Browse the [templates](/templates/), read the [features](/features/), or [install it](/#install) on your server.

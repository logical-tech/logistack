---
title: "Self-host Nextcloud with Docker: Postgres, Redis and HTTPS"
description: "Self-host Nextcloud with Docker in production: Postgres and Redis, HTTPS behind a proxy, trusted domains, background jobs, storage planning and backups."
date: 2026-11-08
category: Self-hosting
keywords: self-host nextcloud, nextcloud docker, nextcloud postgres, nextcloud redis, nextcloud reverse proxy, nextcloud docker compose
---

You want your files, calendars and contacts off a big tech cloud, synced across laptops and phones, on storage you own. Nextcloud does that, and much more through its apps. It also has a reputation for being slow and fussy to run. Most of that reputation comes from installs that skip three things: a real database, a memory cache, and background jobs that actually run.

This guide shows how to self-host Nextcloud with Docker in production: Postgres, Redis, HTTPS behind a reverse proxy, the settings the admin overview warns about, storage planning, and backups. It uses the Nextcloud templates in LogiStack as the example.

## What self-hosted Nextcloud gives you

Nextcloud is an open source (AGPLv3) collaboration suite written in PHP. The core is file sync and share, with desktop and mobile clients. On top of that, apps add:

- **Calendar and contacts** over CalDAV and CardDAV, compatible with phone and desktop clients.
- **Office editing** in the browser, through Nextcloud Office or another document server.
- **Talk** for chat and calls, **Deck** for boards, **Notes**, **Photos** and many more.
- **External storage** mounts for S3, SFTP, SMB and other sources.

Every app you enable adds load and update risk. Start with files, calendar and contacts, get those stable, then add more.

If you only need file sync between your own devices, a lighter tool may serve you better. Nextcloud earns its weight when several people share files, calendars and documents.

## Choose a Nextcloud template

LogiStack ships Nextcloud with each database it supports. Two are worth comparing:

| | [Nextcloud](/templates/nextcloud/) | [Nextcloud with Postgres](/templates/nextcloud-with-postgres/) |
| --- | --- | --- |
| Services | 1 | 3: Nextcloud, managed PostgreSQL 16, Redis 7.4 |
| Database | SQLite (or one you add later) | PostgreSQL |
| Memory cache and file locking | None | Redis |
| Good for | Trying Nextcloud, one user | Real use, several users, sync clients |

Nextcloud itself warns against SQLite for anything beyond testing: sync clients make many small concurrent requests, and SQLite locks the whole database on every write. Use the Postgres template for anything you plan to keep. MySQL and MariaDB variants also exist if you prefer that family.

Both templates use the `linuxserver/nextcloud` image, pinned by digest. It runs Nextcloud with nginx and PHP-FPM, keeps its config in `/config` and user files in `/data`, and runs as the user set by `PUID` and `PGID` (1000 in the templates).

## Deploy Nextcloud with Docker

Nextcloud wants more than a minimal server. Plan for at least 2 GB of RAM for Nextcloud, Postgres and Redis together on top of LogiStack's own needs, and enough disk for your files plus their backups.

On a fresh server with ports 80 and 443 open:

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

Then:

1. Open a project, select **New service**, then the **Templates** tile.
2. Search for `nextcloud` and select **Nextcloud with Postgres**.
3. Enter your hostname in **Public URL**, for example `cloud.example.com`. The Postgres user and password are generated.
4. Set **Timezone** to your zone, for example `Europe/Rome`. It defaults to `UTC` and becomes `TZ` on the `nextcloud` service.
5. Review and select **Deploy**, then point the DNS record at the server.

See [Deploy an app from a template](/docs/deploy/templates/) for the full flow.

## Run the installer with Postgres

Open `https://cloud.example.com`. The installer asks for an admin account and the database:

1. Create the admin user with a long password.
2. Open **Storage & database** and select **PostgreSQL**.
3. Enter the database user and password. Find the generated values on the `nextcloud` service's **Environment** tab, as `POSTGRES_USER` and `POSTGRES_PASSWORD`.
4. Database name: `nextcloud`. Database host: `nextcloud-db`.
5. Leave the data folder on its default (`/data`), so files land on the `nextcloud-data` volume.
6. Skip the recommended apps for now. You can install them later.

Do this right after the deploy. Until the installer has run, anyone who reaches the URL can complete it.

## Fix the reverse proxy settings

Nextcloud runs plain HTTP inside the container, and Caddy handles HTTPS in front of it. Nextcloud needs to know that, or it generates `http://` links, breaks login redirects and warns in the admin overview.

Open the `nextcloud` service's **Terminal** tab. The linuxserver image includes an `occ` command that runs Nextcloud's CLI as the right user:

```bash
occ config:system:set overwriteprotocol --value=https
occ config:system:set overwrite.cli.url --value=https://cloud.example.com
occ config:system:set trusted_domains 1 --value=cloud.example.com
occ config:system:set trusted_proxies 0 --value=10.0.0.0/8
```

`trusted_proxies` tells Nextcloud to trust forwarded headers from the proxy, so it logs real client IPs and brute-force protection blocks the attacker, not your proxy. Docker overlay networks usually use `10.x` addresses; check the address that appears in Nextcloud's log for your requests and set the matching range.

If you add a second hostname later, add it as `trusted_domains 2`, and on the service's **Domains** tab.

## Turn on Redis for caching and file locking

The Postgres template runs a Redis service, but Nextcloud uses it only once `config.php` says so. Without it, file locking falls back to the database and every page load does more work. Run:

```bash
occ config:system:set redis host --value=redis
occ config:system:set redis port --value=6379 --type=integer
occ config:system:set memcache.local --value='\OC\Memcache\APCu'
occ config:system:set memcache.distributed --value='\OC\Memcache\Redis'
occ config:system:set memcache.locking --value='\OC\Memcache\Redis'
```

APCu handles the local cache inside the PHP process; Redis handles locking and the shared cache. Reload the admin overview under **Administration settings › Overview**: the memory cache warning should be gone.

## Background jobs and maintenance

Nextcloud runs cleanup, file scanning, notification and preview jobs in the background. By default it uses AJAX mode, which runs one job when a user loads a page. That is not enough.

The linuxserver image runs `cron.php` on its own every five minutes. Switch Nextcloud to match: **Administration settings › Basic settings › Background jobs › Cron (Recommended)**. The overview then shows when the last job ran.

A few more fixes the overview often asks for:

```bash
occ maintenance:repair --include-expensive
occ db:add-missing-indices
occ config:system:set maintenance_window_start --type=integer --value=1
```

The last line tells Nextcloud to run heavy jobs at 01:00 UTC rather than during working hours.

If you prefer to drive maintenance from the platform, a LogiStack [schedule](/docs/data/schedules/) can run any `occ` command inside the service on a cron, with its output kept in the run history.

## Plan your storage

User files live on the `nextcloud-data` volume, on the disk of the server that runs Nextcloud. Plan for growth from the start:

- **Disk size.** Files, previews and file versions all add up. Versions and the trash bin keep deleted and older copies for a while, which can double space use for active folders.
- **Quotas.** Set a default quota per user in **Administration settings › Users** so one person cannot fill the disk.
- **Monitoring.** Watch disk use on the node and alert before it fills. A full disk mid-sync can corrupt the database. LogiStack's [alerts](/docs/operations/alerts-and-notifications/) can fire on node disk thresholds.

If one disk is not enough, Nextcloud can use S3-compatible object storage as primary storage. That decision is hard to reverse, so make it before you upload anything. If you go that way, you can run the bucket on your own servers too: see [self-hosted S3 storage](/blog/self-hosted-s3-storage/).

## Back up Nextcloud

A Nextcloud backup has three parts, and they must match each other:

1. **The database**: users, shares, file metadata, calendars and contacts.
2. **The config volume** (`nextcloud-config`): `config.php`, including the instance secret and password salt. Without it, a restored database does not work.
3. **The data volume** (`nextcloud-data`): the files themselves.

On LogiStack, create a policy for each:

- A **database dump** of `nextcloud-db`, daily, with scheduled restore tests.
- A **volume archive** of `nextcloud-config`, daily. It is small.
- A **volume archive** of `nextcloud-data`, on a schedule that fits its size.

For a consistent set, put Nextcloud in maintenance mode around the backups, or accept that files uploaded during the backup window may be missing from it. Two schedules inside the service, one before the backup window and one after, can switch it:

```bash
occ maintenance:mode --on   # before the backups
occ maintenance:mode --off  # after the backups
```

Sync clients pause and retry while maintenance mode is on.

Run the backups to a bucket at another provider, with encryption on. See [Back up a database or volume](/docs/data/backups/) for retention and restore tests.

Large data volumes take long to archive in full every night. If yours runs into hundreds of gigabytes, consider S3 primary storage with versioning on the bucket, or back up the data volume less often than the database.

## Updates

The templates pin the image by digest, so updates happen only when you change it. Nextcloud upgrades one major version at a time: from 30 you go to 31, then 32. Skipping a major is not supported.

1. Read the release notes and check that your apps support the new version.
2. Run all three backups.
3. Change the image to a tag for the next major and redeploy.
4. Watch the **Logs** tab while the upgrade runs, then check the admin overview.

## FAQ

### Is Nextcloud free to self-host?

Yes. Nextcloud is open source under the AGPLv3, and the self-hosted server has no feature limits for normal use. Nextcloud GmbH sells an enterprise subscription with support and some extra features for large organizations.

### Why is my Nextcloud slow?

Usually SQLite, no Redis, AJAX background jobs, or too little RAM. Move to Postgres, configure Redis as above, switch background jobs to cron, and check the admin overview for remaining warnings.

### Should I use the linuxserver image or the official Nextcloud image?

Both work in production. The linuxserver image bundles nginx and cron and uses PUID and PGID for file ownership; the official image follows Nextcloud's own docs and comes in Apache and FPM variants. Pick one and stay with it, because their volume layouts differ.

### Can I access Nextcloud only from my own devices?

Yes. Publish it only on your tailnet with [Tailscale](/docs/networking/tailscale/), and the sync clients connect over the private network. You lose public share links, which is often the point.

### How do I add more users?

Create them in **Administration settings › Users**, or connect an LDAP or OpenID Connect provider with the matching Nextcloud app.

Nextcloud rewards a careful setup and punishes a rushed one. LogiStack takes care of the platform layer, from HTTPS to encrypted backups and disk alerts, so you can focus on the Nextcloud settings that matter. See the [templates](/templates/), the features, or [install it](/#install).

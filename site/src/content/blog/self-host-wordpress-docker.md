---
title: "WordPress with Docker: a production setup on your own server"
description: "Run WordPress with Docker in production: MySQL or MariaDB, HTTPS behind a proxy, upload limits, WP-Cron, caching, hardening and backups you can restore."
date: 2026-11-08
category: Self-hosting
keywords: wordpress docker, self-host wordpress, wordpress docker compose, wordpress mariadb docker, wordpress behind reverse proxy, wordpress docker production
---

Shared hosting got slow, managed WordPress got expensive, and you already run other apps on a VPS. Moving WordPress into Docker on that server looks easy: one image, one database. Then the first upload fails at 2 MB, the admin panel loops between HTTP and HTTPS, and you realize nobody is backing up `wp-content`. Running WordPress with Docker in production is mostly about those details.

This guide covers a production WordPress Docker setup: the two containers, the database choice, HTTPS behind a reverse proxy, PHP limits, cron, caching, hardening and backups. It uses the two WordPress templates in LogiStack as working examples.

## How WordPress runs in Docker

The official `wordpress` image bundles PHP, Apache and WordPress core. On first start it copies WordPress into `/var/www/html` and writes a `wp-config.php` that reads its settings from environment variables. A WordPress site in Docker is two services:

- **WordPress**: the `wordpress` image, with `/var/www/html` on a persistent volume. That folder holds core, plugins, themes and uploads.
- **Database**: MySQL or MariaDB, with its data directory on a second volume.

Both volumes matter. The database holds posts, pages, users and settings. The `wp-content` folder inside the WordPress volume holds uploads, plugins and themes. A backup with only one of them restores a broken site.

## Choose a template: MySQL or MariaDB

LogiStack has two WordPress templates that suit a production site:

| | [WordPress](/templates/wordpress/) | [WordPress with MariaDB](/templates/wordpress-with-mariadb/) |
| --- | --- | --- |
| Database | Managed MySQL 8.4 | MariaDB 11 container |
| Database user | `root` | Dedicated user, generated |
| PHP upload limit | 64 MB, set by a mounted `uploads.ini` | Image default |
| Extra config | `WP_MEMORY_LIMIT` 256M, `DISALLOW_FILE_EDIT` | None |
| Database backups | `mysqldump` policy, with scheduled restore tests | Volume archive |
| Database editor | Yes, in the dashboard | No |

The first template runs MySQL as a managed database, so you get consistent dumps, restore tests and the built-in editor. The second runs MariaDB as a plain container with a healthcheck and a dedicated, non-root user from the start. WordPress works the same on both engines.

Pick **WordPress** (MySQL) if you want the database features of the platform. Pick **WordPress with MariaDB** if you prefer MariaDB, and plan your backups around the volume. The [Postgres vs MySQL](/blog/postgres-vs-mysql/) post explains why WordPress stays on the MySQL family.

## Deploy WordPress with Docker

On a fresh server with ports 80 and 443 open, install LogiStack:

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

Then deploy:

1. Open a project, select **New service**, then the **Templates** tile.
2. Search for `wordpress` and pick one of the two templates above.
3. Enter your hostname in **Public URL**, for example `www.example.com`. Leave the passwords on **Auto-generated**.
4. Review and select **Deploy**.
5. Point the DNS record at the server. Caddy gets the certificate as soon as it resolves.

Open the URL and run the WordPress installer right away: site title, admin user, strong password. Until you finish it, anyone who reaches the site can complete the install and own it.

If you prefer to see it as compose, the MariaDB setup is roughly:

```yaml
services:
  wordpress:
    image: wordpress:6
    environment:
      WORDPRESS_DB_HOST: mariadb
      WORDPRESS_DB_USER: wordpress
      WORDPRESS_DB_PASSWORD: ${WP_DB_PASSWORD}
      WORDPRESS_DB_NAME: wordpress
    volumes:
      - wordpress-files:/var/www/html
    depends_on:
      - mariadb
  mariadb:
    image: mariadb:11
    environment:
      MYSQL_ROOT_PASSWORD: ${DB_ROOT_PASSWORD}
      MYSQL_DATABASE: wordpress
      MYSQL_USER: wordpress
      MYSQL_PASSWORD: ${WP_DB_PASSWORD}
    volumes:
      - mariadb-data:/var/lib/mysql
volumes:
  wordpress-files:
  mariadb-data:
```

The templates pin the WordPress image by digest instead of a floating tag, so a redeploy never pulls a different version by surprise. The general case for compose in production is in Deploy Docker Compose in production.

## HTTPS behind a reverse proxy

WordPress runs plain HTTP inside the container. Caddy terminates HTTPS in front of it and forwards the request with `X-Forwarded-Proto: https`. The official image's generated `wp-config.php` checks that header and sets `$_SERVER['HTTPS']`, so WordPress knows the visitor is on HTTPS and builds HTTPS links.

Two settings in **Settings › General** must use HTTPS too: **WordPress Address (URL)** and **Site Address (URL)**. The installer takes them from the address you used, so open the site over HTTPS for the install.

If you see a redirect loop or mixed content anyway:

- A CDN or a second proxy in front of Caddy may be dropping the header. With Cloudflare, use **Full (strict)** SSL mode and a Cloudflare origin certificate, never **Flexible**.
- Old content can have `http://` URLs hard-coded in the database. Fix them with WP-CLI:

```bash
wp search-replace 'http://www.example.com' 'https://www.example.com' --all-tables --skip-columns=guid
```

WP-CLI is not in the default image. Run it from a one-off `wordpress:cli` container on the same network, or install the phar in the running container from the **Terminal** tab.

## Raise PHP upload and memory limits

The default PHP upload limit is 2 MB, too low for images from a modern phone and for most theme or plugin zips.

The MySQL template mounts this file at `/usr/local/etc/php/conf.d/uploads.ini`:

```ini
upload_max_filesize = 64M
post_max_size = 64M
memory_limit = 256M
max_execution_time = 300
max_input_vars = 3000
```

On LogiStack, that mounted file shows up on the service's **Files** tab, where you can edit it; saving rolls out a new deployment. See [Manage volumes and files](/docs/data/volumes-and-files/).

The MariaDB template has no such file. The official image runs PHP as an Apache module, so you can set the same limits in the `.htaccess` file at the root of the WordPress volume, below the block WordPress manages:

```apache
php_value upload_max_filesize 64M
php_value post_max_size 64M
php_value memory_limit 256M
php_value max_execution_time 300
```

Caddy does not limit request body size by default, so the PHP values are the ones that count.

## Lock down wp-config with environment variables

The official image passes `WORDPRESS_CONFIG_EXTRA` straight into `wp-config.php`. The MySQL template uses it for two settings:

```php
define('WP_MEMORY_LIMIT', '256M');
define('DISALLOW_FILE_EDIT', true);
```

`DISALLOW_FILE_EDIT` removes the theme and plugin file editors from wp-admin. If an admin account is compromised, the attacker cannot paste PHP into a theme file from the browser. Add a `WORDPRESS_CONFIG_EXTRA` variable with the same lines to the MariaDB template too.

Other hardening that pays off:

- **Give WordPress its own database user.** The MySQL template connects as root. Create a user with rights on the `wordpress` database only, in the **Roles** view of the database's **Database** tab, then update `WORDPRESS_DB_USER` and `WORDPRESS_DB_PASSWORD`.
- **Protect wp-login.php.** Put an [IP allowlist or password](/docs/networking/access-control/) on an admin hostname if your editors work from known networks, and turn on two-factor authentication with a plugin.
- **Remove unused plugins and themes.** Deactivated code still sits on disk and can still be exploited.
- **Turn on automatic minor updates.** They are on by default for core; enable them for plugins you trust.

## Replace WP-Cron with a real schedule

WordPress runs scheduled tasks (publishing scheduled posts, plugin jobs, update checks) when a visitor loads a page. On a quiet site, jobs run late. On a busy one, the check runs on every request.

Turn it off in `WORDPRESS_CONFIG_EXTRA`:

```php
define('DISABLE_WP_CRON', true);
```

Then call it on a clock. On LogiStack, create a [schedule](/docs/data/schedules/) that runs inside the WordPress service every five minutes:

```bash
curl -fsS http://127.0.0.1/wp-cron.php?doing_wp_cron > /dev/null
```

The [cron jobs in Docker](/blog/cron-jobs-in-docker/) post covers the general pattern.

## Caching and performance

A WordPress page built from PHP and MySQL on every request is slow under load. In order of effort:

1. **A page cache plugin** that writes static HTML for anonymous visitors. This is the biggest gain for most sites.
2. **An object cache** with Redis, so repeated database queries hit memory. Add a managed Redis to the environment and point a Redis object cache plugin at it.
3. **A CDN** for images, CSS and JavaScript.
4. **Resource limits.** Give the WordPress service a memory limit on its **Settings** tab, so a runaway plugin cannot starve the rest of the server.

## Back up WordPress

You need the database and the files, both off the server.

**MySQL template:**

- A **database dump** policy on the database service, daily. Turn on scheduled restore tests.
- A **volume archive** of `wp-app` (the `/var/www/html` folder) on the WordPress service, daily if editors upload often, weekly otherwise.

**MariaDB template:**

- A **volume archive** of `mariadb-data` with **Stop mariadb while archiving** on, so the copy is consistent. The site is down for the seconds the archive takes, so schedule it at night.
- A **volume archive** of `wordpress-files`.

Encrypt the backups and save the key outside the server. Policy setup is in [Back up a database or volume](/docs/data/backups/), and restores work from the same tab.

Backup plugins inside WordPress are fine as a second copy, but they run in the same PHP process they are trying to protect. A platform-level backup still works when the site does not.

## Update WordPress in Docker

WordPress updates core and plugins from wp-admin, writing to the volume. The image only provides the initial copy and PHP. That splits updates in two:

- **Core, plugins and themes**: update from wp-admin, as usual. Back up first.
- **PHP and Apache**: change the image on the service and redeploy. On first start, the image does not overwrite an existing WordPress install, so your core version stays the one on the volume.

Test PHP version jumps on a copy of the site first. A staging environment is the cheap way to do that.

## FAQ

### Is it safe to run WordPress in Docker?

Yes, and it isolates WordPress from other apps on the server. The risks are the usual WordPress ones: outdated plugins and weak admin passwords. Keep plugins few and updated, and restrict wp-admin.

### Should I use MySQL or MariaDB for WordPress?

Either works. WordPress supports both and most sites never notice a difference. Choose the one your platform backs up and manages best.

### Why does WordPress redirect in a loop behind my proxy?

WordPress thinks the request is HTTP while the browser uses HTTPS. Check that `X-Forwarded-Proto` reaches the container and that both site URLs in **Settings › General** use HTTPS.

### How do I migrate an existing WordPress site into Docker?

Export the database with `mysqldump` and copy `wp-content` from the old host. Deploy the template, import the dump into the new database, upload `wp-content` into the WordPress volume, then run `wp search-replace` if the domain changed.

### Can I run several WordPress sites on one server?

Yes. Deploy the template once per site, each in its own environment. Each gets its own database, volume and domain behind the same proxy.

WordPress in Docker is simple once the proxy, PHP limits, cron and backups are right. LogiStack sets most of that up from a template and gives you dumps, restores and a database editor in the same dashboard. See the [templates](/templates/) or [install LogiStack](/#install) on your server.

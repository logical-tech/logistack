---
title: "How to deploy Laravel to production with Docker"
description: "Deploy Laravel to production with Docker and FrankenPHP: build assets, cache config, run migrations, queues and the scheduler, with HTTPS on your server."
date: 2026-11-08
category: Deployment
keywords: deploy laravel, laravel production deployment, laravel docker, laravel frankenphp, deploy laravel to vps
---

Shared hosting and FTP uploads stopped being enough a while ago. You want to deploy Laravel the way the rest of your stack ships: a reproducible image, migrations that run once per release, queue workers that restart with the new code, and HTTPS without editing Nginx configs by hand. This guide builds a production Docker image for Laravel, explains which Artisan commands belong at build time and which at runtime, and shows how to run the web server, the queue and the scheduler as separate processes.

The examples assume Laravel 11 or 12, PHP 8.3, Vite for front-end assets and PostgreSQL or MySQL.

## How a Laravel app runs in production

A PHP app needs something to execute PHP and something to speak HTTP. The classic setup is Nginx plus PHP-FPM, two processes in one container held together by a supervisor. It works, but it means two configs and a process manager.

A simpler option is [FrankenPHP](https://frankenphp.dev): a PHP application server built on Caddy, in one binary. It serves `public/`, runs PHP, and handles signals cleanly as PID 1. Laravel Octane supports it too, if you later want a long-running worker mode.

| Setup | Processes per container | Good when |
| --- | --- | --- |
| Nginx + PHP-FPM + supervisor | 3 | You already run this and know its tuning |
| FrankenPHP (classic mode) | 1 | You want one process and a short Dockerfile |
| FrankenPHP with Octane | 1 | You need lower latency and your app is safe to keep in memory |

This guide uses FrankenPHP in classic mode: each request boots the framework as usual, so no code changes are needed.

## Prepare the app

A few habits make Laravel behave in a container.

**Log to stderr.** Files in `storage/logs` vanish with the container and nobody reads them. Set `LOG_CHANNEL=stderr` so your platform's log viewer gets every line.

**Keep sessions, cache and queues off the local disk.** With more than one replica, a file session written on replica A is invisible to replica B. Use the database or Redis:

```text
SESSION_DRIVER=redis
CACHE_STORE=redis
QUEUE_CONNECTION=redis
```

**Store uploads in S3.** Set `FILESYSTEM_DISK=s3` and the `AWS_*` variables. S3-compatible servers work too, with `AWS_ENDPOINT` and `AWS_USE_PATH_STYLE_ENDPOINT=true`. The [self-hosted S3 storage](/blog/self-hosted-s3-storage/) guide covers running your own.

**Trust the proxy.** HTTPS ends at the reverse proxy, which talks plain HTTP to the container. Tell Laravel to trust the forwarded headers so URLs and redirects use `https`:

```php title="bootstrap/app.php"
->withMiddleware(function (Middleware $middleware) {
    $middleware->trustProxies(at: '*');
})
```

Trusting `*` is fine when the container is only reachable through the proxy, which is the case on a private overlay network.

## A production Dockerfile for Laravel

```dockerfile title="Dockerfile"
FROM composer:2 AS vendor
WORKDIR /app
COPY composer.json composer.lock ./
RUN composer install --no-dev --no-scripts --no-autoloader --prefer-dist

FROM node:22-alpine AS assets
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM dunglas/frankenphp:1-php8.3 AS runtime
RUN install-php-extensions pdo_pgsql pdo_mysql redis intl zip opcache pcntl \
    && apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
ENV SERVER_NAME=:8080 \
    APP_ENV=production \
    LOG_CHANNEL=stderr
WORKDIR /app
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
COPY . .
COPY --from=vendor /app/vendor ./vendor
COPY --from=assets /app/public/build ./public/build
RUN composer dump-autoload --optimize --classmap-authoritative --no-dev \
    && php artisan storage:link \
    && chown -R www-data:www-data storage bootstrap/cache
COPY docker/start.sh /usr/local/bin/start
RUN chmod +x /usr/local/bin/start
USER www-data
EXPOSE 8080
CMD ["start"]
```

Notes on the choices:

- **Three stages.** Composer and Node run in their own stages, so neither ends up in the final image.
- **`SERVER_NAME=:8080`** tells FrankenPHP to serve plain HTTP on port 8080. TLS is the proxy's job; leaving FrankenPHP's own HTTPS on inside the container just causes certificate errors.
- **`install-php-extensions`** ships with the FrankenPHP image and installs extensions without compiling by hand. Add what your app uses.
- **`curl`** is for the container health check, which runs inside the container.
- **`www-data`**: the official image runs as root by default. Running as `www-data` limits what a compromised request can touch. Port 8080 is above 1024, so an unprivileged user can bind it without extra capabilities.

## Cache config at boot, not at build

`php artisan config:cache` freezes every `env()` value into a PHP file. Run it at build time and your production secrets either get baked into the image or, more often, the cache captures empty values because the build has no `.env`. Run the caches when the container starts, when the real environment is present:

```bash title="docker/start.sh"
#!/bin/sh
set -e
php artisan config:cache
php artisan route:cache
php artisan view:cache
php artisan event:cache
exec frankenphp php-server --root /app/public --listen :8080
```

The final `exec` replaces the shell, so FrankenPHP becomes PID 1 and receives `SIGTERM` during rollouts. This takes a second or two at startup, which a health check absorbs.

The `config:cache` step is also why `env()` calls outside the `config/` folder break in production: after caching, `env()` returns `null`. Move those reads into a config file.

## Migrations

Run `php artisan migrate --force` once per deploy, before the new code takes traffic, not in `start.sh`. With two replicas starting together, both try to migrate. `--force` is required because Artisan refuses to migrate in production without it.

Keep migrations backward compatible for the length of a rollout: add nullable columns first, deploy, then tighten. The [zero-downtime deployments](/blog/zero-downtime-deployments/) guide covers the pattern.

## Queues and the scheduler

Laravel's web, queue and scheduler are three processes. Run them as three services from the same image, each with its own command.

**Queue worker:**

```bash
php artisan queue:work --tries=3 --max-time=3600
```

`--max-time` makes the worker exit after an hour so the platform restarts it fresh, which limits memory creep. When you deploy, the old worker gets `SIGTERM`, finishes its current job and exits; the new one starts with the new code. Laravel Horizon works the same way: run `php artisan horizon` as the command instead.

**Scheduler:** run `php artisan schedule:work` as a single process, or have a cron call `php artisan schedule:run` every minute. Run exactly one scheduler; two copies fire every task twice. If a task must never overlap with itself, add `->withoutOverlapping()` and `->onOneServer()` with a shared cache store.

## Deploy Laravel with LogiStack

[LogiStack](/features/) is an open-source, self-hosted PaaS on Docker Swarm with Caddy in front. It builds from Git on your server and manages databases, domains and certificates.

**1. Install LogiStack:**

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

**2. Create the database and Redis.** Select **New service**, then **Database**. LogiStack offers PostgreSQL, MySQL, MariaDB and Redis, among others. Name them `db` and `redis`; that name is their hostname on the environment's private network. See [Create a managed database](/docs/deploy/databases/).

**3. Create the web service from Git.** Pick the repository, set **Build with** to **Dockerfile** and **Container port** to `8080`. See [Deploy from Git](/docs/deploy/from-git/).

**4. Add variables.** In the **Environment** tab, add `APP_KEY` (generate it locally with `php artisan key:generate --show`), `DB_*` or `DB_URL`, `REDIS_HOST=redis`, `REDIS_PASSWORD` and `APP_URL`. Mark keys and passwords **Secret**. To share them with the worker and scheduler, define them once at the environment level. See [Environment variables](/docs/deploy/environment-variables/).

**5. Add the migration as a release command.** Under **Settings** › **Release commands**, set the **Pre-deploy command**:

```text title="Pre-deploy command"
php
artisan
migrate
--force
```

If it fails, the deployment fails and the current version keeps running.

**6. Add a health check.** Laravel 11 and later register `/up` by default. Under **Settings** › **Healthcheck and drain**, choose **HTTP request** with port `8080` and path `/up`.

**7. Add the worker and the scheduler.** Create two more Git services from the same repository with no domain. On each, set **Command** under **Settings**, one argument per line, for example:

```text title="Command (queue worker)"
php
artisan
queue:work
--tries=3
--max-time=3600
```

For the scheduler, use `php`, `artisan`, `schedule:work`, and keep it at one copy. Alternatively, skip the scheduler service and create a LogiStack [schedule](/docs/data/schedules/) that runs `php artisan schedule:run` inside the web service every minute.

**8. Add your domain.** Add it in the **Domains** tab; Caddy gets a Let's Encrypt certificate and redirects HTTP to HTTPS.

Each push now rebuilds the image, runs the migration once, and rolls the replicas one at a time. Set nightly database dumps to S3 from the database's **Backups** tab.

![The Environment tab of a service with secret references and plain variables](/docs/screens/service-environment.webp)

## Common Laravel deployment problems

- **"No application encryption key has been specified"**: `APP_KEY` is missing, or `config:cache` ran at build time without it.
- **Mixed-content warnings or `http://` links**: trusted proxies aren't configured, so Laravel thinks requests are plain HTTP.
- **Sessions lost between requests**: `SESSION_DRIVER=file` with more than one replica.
- **Queue jobs run old code after a deploy**: the worker didn't restart. Run it as its own service so every deploy replaces it.
- **Permission denied writing to `storage/`**: the `chown` step is missing, or a volume mounted over `storage` belongs to root.

## FAQ

### Is FrankenPHP production ready for Laravel?

FrankenPHP is stable and used in production, and Laravel Octane has first-party support for it. In classic mode it behaves like PHP-FPM from your app's point of view, so it's a low-risk switch. If you depend on a specific PHP-FPM setting, Nginx plus PHP-FPM remains a fine choice.

### Should I run migrations in the container entrypoint?

No. Several replicas would race to apply them, and a failure leaves you with crash-looping containers. Run them once per release, before the rollout, so a failed migration stops the deploy cleanly.

### Do I need Laravel Forge or Vapor?

No. Forge provisions and manages servers for you, and Vapor runs Laravel on AWS Lambda. Both are good products. A Docker image on a self-hosted platform gives you a similar push-to-deploy workflow with a flat server bill and no vendor lock-in.

### How do I run Artisan commands in production?

Open a shell in a running container and run `php artisan <command>`. In LogiStack, the **Terminal** tab gives you that shell in the browser.

Laravel in Docker comes down to a clean image, runtime config caching, and separate processes for web, queue and scheduler. To run all three on your own server with push-to-deploy, managed MySQL or Postgres and automatic HTTPS, [install LogiStack](/#install).

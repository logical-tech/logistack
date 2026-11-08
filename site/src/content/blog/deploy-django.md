---
title: "How to deploy Django to production with Docker"
description: "Deploy Django to production with Docker: Gunicorn, WhiteNoise, Postgres, migrations before rollout, Celery workers, HTTPS and push-to-deploy on your server."
date: 2026-11-08
category: Deployment
keywords: deploy django, django production deployment, django docker, django gunicorn, deploy django to vps
---

`python manage.py runserver` got you this far. Now you need to deploy Django for real: a proper application server, static files that load, migrations that run before the new code does, HTTPS, and a way to ship the next version without SSH. This guide shows a production setup for Django in Docker, the settings Django needs behind a reverse proxy, and how to run background workers next to the web process.

The examples assume Django 5, Python 3.12, PostgreSQL and a project package called `config` (where `settings.py` and `wsgi.py` live). Adjust the names to your project.

## The production stack for Django

A Django app in production usually has four moving parts:

| Part | Job | Typical choice |
| --- | --- | --- |
| Application server | Runs your WSGI or ASGI app with several workers | Gunicorn (WSGI) or Uvicorn (ASGI) |
| Static files | Serves CSS, JS and admin assets | WhiteNoise inside the app, or a CDN |
| Database | Persistent data | PostgreSQL |
| Background jobs | Email, exports, webhooks | Celery with Redis, or a cron-style scheduler |

A reverse proxy sits in front and terminates HTTPS. You don't need Nginx inside your container for this; the proxy of your platform does it.

## Prepare settings for production

Read everything that changes between environments from environment variables. A minimal production block:

```python title="config/settings.py"
import os

DEBUG = os.environ.get("DJANGO_DEBUG") == "1"
SECRET_KEY = os.environ["DJANGO_SECRET_KEY"]

ALLOWED_HOSTS = [h for h in os.environ.get("ALLOWED_HOSTS", "").split(",") if h]
ALLOWED_HOSTS += ["localhost", "127.0.0.1"]  # container health checks

CSRF_TRUSTED_ORIGINS = [
    o for o in os.environ.get("CSRF_TRUSTED_ORIGINS", "").split(",") if o
]

# The proxy terminates TLS and tells Django the original scheme.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True

STATIC_ROOT = BASE_DIR / "staticfiles"
STORAGES = {
    "staticfiles": {
        "BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage",
    },
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
}
```

Add `"whitenoise.middleware.WhiteNoiseMiddleware"` right after `SecurityMiddleware` in `MIDDLEWARE`.

For the database, `dj-database-url` turns one `DATABASE_URL` string into Django's `DATABASES` dict:

```python title="config/settings.py"
import dj_database_url

DATABASES = {
    "default": dj_database_url.config(conn_max_age=60, conn_health_checks=True)
}
```

Three settings deserve a note:

- **`ALLOWED_HOSTS` includes `127.0.0.1`**. Health checks inside the container call `http://127.0.0.1:8000/...`. Without that entry Django answers `400 Bad Request`, the check fails and the rollout never finishes.
- **`SECURE_PROXY_SSL_HEADER`** tells Django the request came in over HTTPS even though the proxy talks plain HTTP to the container. Without it, `SECURE_SSL_REDIRECT` loops forever and `request.is_secure()` lies.
- **`CSRF_TRUSTED_ORIGINS`** must list your full origins with scheme, like `https://shop.example.com`. Django 4 and later reject form posts from origins not on the list.

## A production Dockerfile for Django

```dockerfile title="Dockerfile"
FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1
WORKDIR /app

FROM base AS build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential libpq-dev \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip wheel --wheel-dir /wheels -r requirements.txt

FROM base AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends libpq5 curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 app
COPY --from=build /wheels /wheels
RUN pip install /wheels/* && rm -rf /wheels
COPY --chown=app:app . .
RUN DJANGO_SECRET_KEY=build-only python manage.py collectstatic --noinput
USER app
EXPOSE 8000
CMD ["gunicorn", "config.wsgi:application", \
     "--bind", "0.0.0.0:8000", \
     "--workers", "3", \
     "--access-logfile", "-", \
     "--graceful-timeout", "20"]
```

Why it looks like this:

- **Wheels in a build stage** keep compilers and headers out of the final image. If you use `psycopg[binary]`, you can drop `build-essential` and `libpq-dev` entirely.
- **`collectstatic` at build time** bakes hashed static files into the image, so every replica serves identical assets. The dummy secret exists only because settings require one; it never reaches runtime.
- **`curl`** is there for the HTTP health check. `python:3.12-slim` ships neither `curl` nor `wget`.
- **Gunicorn logs to stdout** (`--access-logfile -`), so your platform's log viewer sees requests.

Your `requirements.txt` needs at least `django`, `gunicorn`, `whitenoise`, `dj-database-url` and a Postgres driver.

### How many Gunicorn workers?

The old rule of `2 × cores + 1` assumes Gunicorn owns the whole machine. In a container with a CPU limit, size to the limit: with 1 CPU, 2 to 3 sync workers is a sane start. Each worker is a full copy of your app in memory, so watch memory before adding more. If you need more throughput, add replicas instead of workers; that also gives you redundancy.

If your views spend most of their time waiting on other APIs, consider `--worker-class gthread --threads 4`, or serve the ASGI app with Uvicorn workers.

## Migrations: before the new code, not at startup

A common shortcut is running `migrate` in the container entrypoint. Avoid it. With several replicas, each one races to apply the same migration, and a failed migration leaves you with a crash-looping container instead of a clean failed deploy.

Run migrations once per deploy, on the new image, before any replica is replaced. If the migration fails, the deploy stops and the old version keeps serving. Write migrations that the old code can live with for a few seconds: add columns as nullable, backfill, then make them required in a later release. The [zero-downtime deployments](/blog/zero-downtime-deployments/) guide explains the expand-and-contract pattern in depth.

## Background jobs with Celery

Run Celery as a separate process from the same image, with a different command. That keeps one build and one set of dependencies:

```bash
celery -A config worker --loglevel=info --concurrency=2
```

Celery needs a broker. Redis is the common choice; the [Redis in Docker](/blog/redis-docker/) guide covers running it. For periodic tasks you have two options: Celery Beat as one more process (run exactly one copy, or tasks fire twice), or a platform-level cron that calls a management command, such as `python manage.py clearsessions`.

## Media files and user uploads

`FileSystemStorage` writes uploads to the container's disk, which is replaced on each deploy. In production, store media in S3-compatible storage with `django-storages`:

```python title="config/settings.py"
STORAGES["default"] = {
    "BACKEND": "storages.backends.s3.S3Storage",
    "OPTIONS": {
        "bucket_name": os.environ["S3_BUCKET"],
        "endpoint_url": os.environ["S3_ENDPOINT"],
        "access_key": os.environ["S3_ACCESS_KEY"],
        "secret_key": os.environ["S3_SECRET_KEY"],
    },
}
```

This also makes the web service stateless, which is what lets you run more than one replica.

## Deploy Django with LogiStack

[LogiStack](/features/) is an open-source, self-hosted PaaS on Docker Swarm with Caddy as the proxy. It builds your repository on your server and handles the database, the domain and the rollout. Here is the setup for the app above.

**1. Install it** on a Linux server with 2 GB of RAM or more:

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

**2. Create the database.** In your project, select **New service**, then **Database**, then PostgreSQL. Name it `db`. LogiStack generates the password and keeps the database on the environment's private network, reachable at the hostname `db`. See [Create a managed database](/docs/deploy/databases/).

**3. Create the web service from Git.** Connect GitHub, GitLab, Gitea, Forgejo or Bitbucket, pick the repository, set **Build with** to **Dockerfile** and **Container port** to `8000`. See [Deploy from Git](/docs/deploy/from-git/).

**4. Set variables.** In the **Environment** tab:

```text
DJANGO_SECRET_KEY      (secret)
DATABASE_URL           postgres://postgres:<POSTGRES_PASSWORD>@db:5432/postgres   (secret)
ALLOWED_HOSTS          shop.example.com
CSRF_TRUSTED_ORIGINS   https://shop.example.com
```

LogiStack also sets `LOGISTACK_FQDN` (every hostname the service answers on, comma-separated) and `LOGISTACK_URL` (the primary domain with its scheme) on every container. You can read those in `settings.py` instead of repeating the domain by hand.

**5. Add the release command.** Under **Settings** › **Release commands**, set the **Pre-deploy command**, one argument per line:

```text title="Pre-deploy command"
python
manage.py
migrate
--noinput
```

**6. Add a health check.** Under **Settings** › **Healthcheck and drain**, choose **HTTP request** on port `8000` and a cheap path such as `/healthz/`. Set **Drain timeout** to match Gunicorn's `--graceful-timeout` so in-flight requests finish.

**7. Add the worker.** Create a second Git service from the same repository with no domain, and set its **Command** under **Settings** to:

```text title="Command"
celery
-A
config
worker
--loglevel=info
```

Add a managed Redis next to it and point `CELERY_BROKER_URL` at `redis://:<REDIS_PASSWORD>@redis:6379/0`.

**8. Add the domain.** Add `shop.example.com` in the **Domains** tab and LogiStack issues a Let's Encrypt certificate. Each push now builds a new image, runs the migration, and replaces replicas one at a time. If a deploy goes wrong, select an earlier deployment and **Roll back to this**.

For periodic jobs, a LogiStack [schedule](/docs/data/schedules/) can run a command inside the web service on a cron expression, so you may not need Celery Beat at all. Database dumps go to S3 on a schedule from the database's **Backups** tab; see [Backups](/docs/data/backups/).

## Common Django deployment errors

- **`DisallowedHost` or 400 on every request**: the domain is missing from `ALLOWED_HOSTS`. For failing health checks, `127.0.0.1` is missing.
- **CSRF verification failed on login**: add the `https://` origin to `CSRF_TRUSTED_ORIGINS`.
- **Admin has no styles**: `collectstatic` didn't run, or WhiteNoise middleware is missing.
- **Redirect loop**: `SECURE_SSL_REDIRECT=True` without `SECURE_PROXY_SSL_HEADER`.
- **Workers killed under load**: Gunicorn's default 30 second timeout hit a slow view, or memory hit the container limit. Move slow work to Celery.

## FAQ

### Should I use Gunicorn or Uvicorn for Django?

Gunicorn with sync workers is the safe default for classic Django views. If you use async views, Channels or long-lived connections, serve `config.asgi:application` with Uvicorn, either directly or as Gunicorn's worker class.

### Do I need Nginx in front of Django?

Not inside your container. Your platform's reverse proxy terminates TLS and forwards requests, and WhiteNoise serves static files efficiently with compression and far-future cache headers.

### Can I use SQLite for Django in production?

For a small single-server app it can work, but it ties the app to one disk and one replica, and backups need care. PostgreSQL removes those limits for little extra effort.

### How do I run management commands in production?

Open a shell in a running container and run `python manage.py <command>`. In LogiStack, the **Terminal** tab of the service does this from the browser.

Deploying Django well is mostly settings and process boundaries: Gunicorn for the web, migrations before rollout, uploads in object storage and workers as their own service. If you want that on your own server with push-to-deploy and backups built in, [install LogiStack](/#install).

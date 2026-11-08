---
title: "How to deploy FastAPI to production with Docker"
description: "Deploy FastAPI to production with Docker and uv: Uvicorn workers, proxy headers, Alembic migrations before rollout, health checks and HTTPS on your server."
date: 2026-11-08
category: Deployment
keywords: deploy fastapi, fastapi production, fastapi docker, uvicorn production, fastapi deployment
---

FastAPI makes the first endpoint take five minutes. Deploying FastAPI to production takes a few more decisions: how many Uvicorn workers to run, how the app learns it's behind HTTPS, where Alembic migrations run, and how to stop the container without cutting off requests. This guide answers each one, with a Dockerfile built on `uv` and a deploy flow that rebuilds on every push.

The examples assume Python 3.12, FastAPI with SQLAlchemy and Alembic, and an app object at `app/main.py`.

## How FastAPI runs in production

FastAPI is an ASGI app. Something has to run it and speak HTTP:

| Server | How you run it | Notes |
| --- | --- | --- |
| `fastapi run` | `fastapi run app/main.py --workers 2` | The FastAPI CLI, Uvicorn underneath, sane defaults |
| Uvicorn | `uvicorn app.main:app --workers 2` | The usual choice, built-in multi-process mode |
| Gunicorn + Uvicorn workers | `gunicorn -k uvicorn.workers.UvicornWorker` | Older pattern, from before Uvicorn managed its own workers |
| Hypercorn, Granian | Their own CLIs | Alternatives with HTTP/2 or Rust internals |

Uvicorn with `--workers` covers most cases. Gunicorn's process management used to be the reason to wrap it; recent Uvicorn versions restart dead workers on their own.

### Workers vs replicas

Each worker is a separate Python process with its own copy of the app. Inside one container, more workers use more cores. Across containers, more replicas do the same thing, and also give you redundancy and rolling deploys.

A practical rule for containers: match workers to the CPU limit (1 or 2 workers per core), keep each container modest, and scale out with replicas. Async endpoints that mostly wait on databases and APIs handle many concurrent requests per worker; CPU-heavy endpoints don't, and those benefit from more processes or a task queue.

Never call blocking code (`requests`, a sync database driver, heavy computation) inside an `async def` endpoint. It freezes that worker's event loop for everyone. Use `def` endpoints for blocking work, which FastAPI runs in a thread pool, or switch to async libraries like `httpx` and `asyncpg`.

## A production Dockerfile with uv

[uv](https://docs.astral.sh/uv/) installs dependencies from a lockfile in seconds and works well in Docker:

```dockerfile title="Dockerfile"
FROM python:3.12-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.5 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY . .
RUN uv sync --frozen --no-dev

FROM python:3.12-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 app
WORKDIR /app
COPY --from=build --chown=app:app /app /app
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1
USER app
EXPOSE 8000
CMD ["uvicorn", "app.main:app", \
     "--host", "0.0.0.0", "--port", "8000", \
     "--workers", "2", \
     "--proxy-headers", "--forwarded-allow-ips", "*", \
     "--timeout-graceful-shutdown", "8"]
```

Why each piece is there:

- **Two `uv sync` calls**: the first installs only dependencies, so Docker caches that layer until `uv.lock` changes. Code edits rebuild in seconds.
- **`UV_COMPILE_BYTECODE=1`**: precompiles `.pyc` files at build time, which shortens cold starts.
- **The virtualenv is copied whole**: the runtime stage has no uv and no compilers, just Python and your `.venv`.
- **`curl`**: `python:3.12-slim` has no HTTP client, and container health checks run inside the container.
- **`PYTHONUNBUFFERED=1`**: logs reach stdout immediately instead of sitting in a buffer.

If you use pip and `requirements.txt` instead, the same structure works with `pip install --prefix` in the build stage.

## Behind a reverse proxy: proxy headers and root path

In production, TLS ends at a reverse proxy, which forwards plain HTTP to your container with `X-Forwarded-Proto` and `X-Forwarded-For` headers.

- **`--proxy-headers`** makes Uvicorn read those headers, so `request.url` says `https` and `request.client.host` is the real client IP.
- **`--forwarded-allow-ips "*"`** trusts the headers from any source. That's fine when the container only receives traffic from the proxy on a private network. If the port is reachable from elsewhere, list the proxy's address instead.

Without these flags, `url_for()` builds `http://` links, OAuth redirects fail, and every request seems to come from the proxy.

If the API lives under a path prefix like `/api` and the proxy keeps the prefix in the URL, set `root_path="/api"` on the `FastAPI()` app so the docs at `/api/docs` load their OpenAPI schema from the right URL.

## Settings with pydantic-settings

Read configuration from the environment and fail fast when something is missing:

```python title="app/config.py"
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    database_url: str
    secret_key: str
    cors_origins: list[str] = []
    environment: str = "production"

settings = Settings()
```

`pydantic-settings` maps `DATABASE_URL` to `database_url` and parses `CORS_ORIGINS='["https://app.example.com"]'` as a list. A missing required variable raises at import time, so a misconfigured deploy fails its health check instead of serving errors.

## Database pools and lifespan

Open shared resources in the lifespan handler and close them on shutdown:

```python title="app/main.py"
from contextlib import asynccontextmanager
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import create_async_engine
from app.config import settings

engine = create_async_engine(settings.database_url, pool_size=5, max_overflow=5)

@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await engine.dispose()

app = FastAPI(lifespan=lifespan)

@app.get("/healthz")
async def healthz():
    return {"ok": True}
```

Watch the math on connections: pool size × workers × replicas. Five connections times two workers times four replicas is 40 Postgres connections before any background job connects. Postgres defaults to 100. When you outgrow that, a pooler helps; see [PgBouncer connection pooling](/blog/pgbouncer-connection-pooling/).

## Alembic migrations

Run `alembic upgrade head` once per deploy, before any new replica takes traffic. Not in the lifespan handler: with several workers and replicas, every process would try at once.

Make migrations safe for the few seconds when old and new code both run: add nullable columns, backfill, then add constraints in a later release. The [zero-downtime deployments](/blog/zero-downtime-deployments/) guide covers this in detail.

## Background tasks

FastAPI's `BackgroundTasks` run in the same process after the response. They're fine for sending one email; they die with the worker on a deploy. For anything that must survive a restart, use a queue (Celery, RQ, Dramatiq, arq) and run its worker as a separate service from the same image.

## Deploy FastAPI with LogiStack

[LogiStack](/features/) is an open-source, self-hosted PaaS on Docker Swarm with Caddy as the reverse proxy. It builds your repository on your server and rolls out each version with health checks.

**1. Install LogiStack:**

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

**2. Create PostgreSQL.** Select **New service**, **Database**, then PostgreSQL. Name it `db`; apps in the same environment reach it at that hostname. See [Create a managed database](/docs/deploy/databases/).

**3. Create the API from Git.** Pick the repository, set **Build with** to **Dockerfile** and **Container port** to `8000`. See [Deploy from Git](/docs/deploy/from-git/).

**4. Add variables.** In the **Environment** tab, add `DATABASE_URL` as a secret, for example `postgresql+asyncpg://postgres:<POSTGRES_PASSWORD>@db:5432/postgres`, plus `SECRET_KEY` and `CORS_ORIGINS`.

**5. Add the migration.** Under **Settings** › **Release commands**, set the **Pre-deploy command**:

```text title="Pre-deploy command"
alembic
upgrade
head
```

It runs once on the new image with the service's variables. If it fails, the deploy fails and the running version stays live. See [Deployments](/docs/deploy/deployments/).

**6. Health check and drain.** Under **Settings** › **Healthcheck and drain**, choose **HTTP request** on port `8000` with path `/healthz`. Set **Drain timeout** above Uvicorn's `--timeout-graceful-shutdown`, for example `10`.

**7. Domain.** Add `api.example.com` in the **Domains** tab. Caddy issues a Let's Encrypt certificate and forwards requests with the proxy headers Uvicorn now trusts.

**8. Scale.** Set **Fixed** copies under **Settings** › **Scaling**, or turn on **Automatic** to follow CPU load between a minimum and a maximum. See [Scale a service automatically](/docs/deploy/autoscaling/).

For machine-learning APIs that load a large model at startup, raise the memory limit to fit the model in every worker, and give the health check enough time: a replica only takes traffic once it passes.

## Common FastAPI deployment problems

- **Swagger UI at `/docs` loads but "Failed to load API definition"**: the app is behind a path prefix without `root_path`.
- **`http://` URLs in redirects**: Uvicorn isn't trusting proxy headers. Add `--proxy-headers --forwarded-allow-ips "*"`.
- **One slow request blocks others**: blocking code inside an `async def` endpoint.
- **`too many clients already` from Postgres**: pool size times workers times replicas exceeds `max_connections`.
- **Health check fails on a fresh deploy**: the image has no `curl` or `wget`, or a required setting is missing and the app crashes at import.

## FAQ

### How many Uvicorn workers should I use for FastAPI?

Start with one or two workers per CPU core in the container's limit and measure. If you need more capacity, add replicas rather than workers, so a single crash or deploy affects a smaller share of traffic.

### Do I still need Gunicorn with FastAPI?

Usually not. Uvicorn's `--workers` mode supervises its processes and restarts ones that die. Gunicorn with Uvicorn workers still works if your team already runs it and relies on its settings.

### Is `fastapi run` suitable for production?

Yes. `fastapi run` is the FastAPI CLI's production command, built on Uvicorn, and it accepts `--workers` and `--proxy-headers`. Calling `uvicorn` directly gives you a few more flags, such as the graceful shutdown timeout.

### Should FastAPI serve static files in production?

It can, with `StaticFiles`, and that's fine for a few assets. A separate front end is better deployed as its own static site, served by a web server like Caddy.

FastAPI in production is mostly about the process around it: the right number of workers, proxy headers, migrations before rollout and a pool that fits the database. To run it on your own server with managed Postgres, HTTPS and push-to-deploy, [install LogiStack](/#install).

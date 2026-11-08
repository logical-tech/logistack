---
title: "How to deploy a Rails app to production with Docker"
description: "Deploy Rails to production with the generated Dockerfile: credentials, assets, migrations before rollout, Solid Queue or Sidekiq workers and HTTPS."
date: 2026-11-08
category: Deployment
keywords: deploy rails, rails production deployment, rails docker, deploy ruby on rails, rails 8 deployment
---

Rails has the best default deployment story it has ever had. Since Rails 7.1, `rails new` writes a production Dockerfile for you, and Rails 8 ships Kamal, Thruster and the Solid trio for jobs, cache and Action Cable. Still, when you sit down to deploy Rails on your own server, questions pile up: where `RAILS_MASTER_KEY` goes, when migrations run, how to run jobs next to Puma, and what to do about SQLite in production.

This guide starts from the generated Dockerfile, explains the parts that matter, and shows how to run Rails as a web service plus a job worker on a self-hosted platform.

## What Rails generates for production

Check whether your app has a `Dockerfile` at the root. If it was created with Rails 7.1 or later, it does. For older apps, the `dockerfile-rails` gem generates an equivalent one:

```bash
bundle add dockerfile-rails --group development
bin/rails generate dockerfile
```

The generated file is a good production Dockerfile. Its key parts look like this (trimmed):

```dockerfile title="Dockerfile"
ARG RUBY_VERSION=3.3.6
FROM docker.io/library/ruby:$RUBY_VERSION-slim AS base
WORKDIR /rails
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y curl libjemalloc2 libvips postgresql-client && \
    rm -rf /var/lib/apt/lists /var/cache/apt/archives
ENV RAILS_ENV="production" \
    BUNDLE_DEPLOYMENT="1" \
    BUNDLE_PATH="/usr/local/bundle" \
    BUNDLE_WITHOUT="development"

FROM base AS build
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential git libpq-dev pkg-config && \
    rm -rf /var/lib/apt/lists /var/cache/apt/archives
COPY Gemfile Gemfile.lock ./
RUN bundle install && \
    rm -rf ~/.bundle/ "${BUNDLE_PATH}"/ruby/*/cache && \
    bundle exec bootsnap precompile --gemfile
COPY . .
RUN bundle exec bootsnap precompile app/ lib/
RUN SECRET_KEY_BASE_DUMMY=1 ./bin/rails assets:precompile

FROM base
COPY --from=build "${BUNDLE_PATH}" "${BUNDLE_PATH}"
COPY --from=build /rails /rails
RUN groupadd --system --gid 1000 rails && \
    useradd rails --uid 1000 --gid 1000 --create-home --shell /bin/bash && \
    chown -R rails:rails db log storage tmp
USER 1000:1000
ENTRYPOINT ["/rails/bin/docker-entrypoint"]
EXPOSE 80
CMD ["./bin/thrust", "./bin/rails", "server"]
```

What each part buys you:

- **Multi-stage build**: compilers and headers stay in `build`; the final image only has runtime libraries.
- **`SECRET_KEY_BASE_DUMMY=1`**: lets `assets:precompile` run without your real credentials. The build never needs the master key.
- **`libjemalloc2`**: the entrypoint preloads jemalloc, which noticeably reduces Ruby's memory growth in long-running processes.
- **Thruster** (Rails 8): a small proxy in front of Puma that adds HTTP compression, asset caching and X-Sendfile. It listens on port 80 and forwards to Puma on 3000. On Rails 7.1 and 7.2 the default is Puma directly on port 3000.
- **`curl`**: already installed, which is handy because container health checks run inside the container.

Use the generated file, and adjust the system packages to your database driver: `libpq-dev` and `postgresql-client` for PostgreSQL, `default-libmysqlclient-dev` for MySQL.

## Secrets: master key and credentials

Rails reads encrypted credentials from `config/credentials.yml.enc` (or per-environment files like `config/credentials/production.yml.enc`). The file is committed; the key that decrypts it is not. In production, provide it as an environment variable:

```text
RAILS_MASTER_KEY=<contents of config/master.key or config/credentials/production.key>
```

Treat it like a root password: it decrypts every credential in the file. Some teams prefer plain environment variables for each secret instead (`DATABASE_URL`, `STRIPE_SECRET_KEY`), which makes rotation easier and lets the platform audit who changed what. Both work. The [secrets management](/blog/secrets-management/) guide compares the approaches.

`DATABASE_URL` overrides `config/database.yml` when set, so you don't need to template that file.

## The entrypoint runs db:prepare. Should it?

The generated `bin/docker-entrypoint` runs `./bin/rails db:prepare` when the command is `rails server`. That's convenient for a single container, and risky for more:

- With two or more replicas, each runs `db:prepare` at startup. Postgres advisory locks keep migrations from running twice at once, but a slow migration now blocks every replica's boot.
- A failed migration produces crash-looping containers instead of a clean failed deploy.

The more predictable approach is to run `bin/rails db:migrate` once per release, before any replica is replaced, and remove the `db:prepare` line from the entrypoint (or keep it for local use only). Write migrations the old code can live with during the rollout; the [zero-downtime deployments](/blog/zero-downtime-deployments/) guide covers expand-and-contract migrations.

## Background jobs: Solid Queue or Sidekiq

Rails 8 apps default to **Solid Queue**, which stores jobs in the database. You can run it two ways:

- **Inside Puma**: set `SOLID_QUEUE_IN_PUMA=true` and the Puma plugin supervises the job workers. One process, fine for small apps.
- **As its own process**: run `bin/jobs`. This is better once job load grows, because a slow job no longer competes with web requests for CPU, and you can scale workers and web separately.

**Sidekiq** remains the common choice for apps already on Redis:

```bash
bundle exec sidekiq -C config/sidekiq.yml
```

Either way, a worker is the same image with a different command. Run it as a separate service so each deploy restarts it with the new code.

Recurring jobs: Solid Queue reads `config/recurring.yml`, and Sidekiq has scheduler extensions. Run one scheduler only, or tasks run twice.

## SQLite in production: when it works

Rails 8 made SQLite a first-class production option, with Solid Cache, Solid Queue and Solid Cable all able to use it. It works well for one server and one replica, and it needs a persistent volume for the `storage/` folder plus a backup plan for the database file.

The limits are structural: one writer, one machine, no horizontal scaling of the web tier. If you expect to run more than one replica, or want managed backups and point-in-time recovery, use PostgreSQL from day one. Moving later is possible but tedious.

## Active Storage uploads

The default `local` service writes uploads to `storage/` inside the container, which is replaced on each deploy. Use an S3-compatible service in `config/storage.yml`:

```yaml title="config/storage.yml"
s3:
  service: S3
  endpoint: <%= ENV["S3_ENDPOINT"] %>
  access_key_id: <%= ENV["S3_ACCESS_KEY"] %>
  secret_access_key: <%= ENV["S3_SECRET_KEY"] %>
  region: us-east-1
  bucket: <%= ENV["S3_BUCKET"] %>
  force_path_style: true
```

Then set `config.active_storage.service = :s3` in `production.rb`. The `force_path_style` option is what most self-hosted S3 servers expect.

## Kamal or a platform?

Kamal deploys your image to servers over SSH, with a proxy for zero-downtime switches. It's a good fit if you like a config file in the repository and a CLI on your laptop or CI. It does not give you a dashboard, managed databases with backups, or a web log viewer. A self-hosted PaaS gives you those, at the cost of running one more system. The [Kamal alternatives](/blog/kamal-alternatives/) post compares the options in detail.

## Deploy Rails with LogiStack

[LogiStack](/features/) is an open-source, self-hosted PaaS on Docker Swarm with Caddy as the proxy. It builds the generated Dockerfile as is.

**1. Install LogiStack:**

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

**2. Create PostgreSQL** (and Redis if you use Sidekiq). Select **New service**, then **Database**. Name the database `db`; that is its hostname on the environment's private network. See [Create a managed database](/docs/deploy/databases/).

**3. Create the web service from Git.** Pick the repository, set **Build with** to **Dockerfile**. Set **Container port** to `80` for Rails 8 with Thruster, or `3000` for Puma directly. See [Deploy from Git](/docs/deploy/from-git/).

**4. Add variables.** In the **Environment** tab, add `RAILS_MASTER_KEY` and `DATABASE_URL` as secrets, for example `postgres://postgres:<POSTGRES_PASSWORD>@db:5432/app_production`. Define them at the environment level so the worker shares them. See [Environment variables](/docs/deploy/environment-variables/).

**5. Add the migration.** Under **Settings** › **Release commands**, set the **Pre-deploy command**. It runs once on the new image, with the service's variables, before any replica changes:

```text title="Pre-deploy command"
./bin/rails
db:migrate
```

If it fails, the deploy stops and the current version keeps serving. The entrypoint wraps this command too, so jemalloc is preloaded and `db:prepare` doesn't run for it.

**6. Health check.** Rails 7.1 and later include `/up`, which returns 200 when the app boots. Under **Settings** › **Healthcheck and drain**, choose **HTTP request** with your container port and path `/up`.

**7. Add the job worker.** Create a second Git service from the same repository, with no domain, and set **Command** under **Settings**:

```text title="Command (Solid Queue)"
./bin/jobs
```

For Sidekiq, use `bundle`, `exec`, `sidekiq` on three lines.

**8. Add the domain.** Add it in the **Domains** tab. Caddy gets a Let's Encrypt certificate and redirects HTTP to HTTPS. Set `config.assume_ssl = true` and `config.force_ssl = true` in `production.rb` (both are in the generated file, commented or on) so Rails knows the proxy terminated TLS.

Each push now builds the image, migrates once, and replaces replicas one at a time with health checks in between. Earlier images stay available for a one-click rollback from the **Deployments** tab.

![The Logs tab of a service following several replicas](/docs/screens/service-logs.webp)

## Common Rails deployment problems

- **`ActiveSupport::MessageEncryptor::InvalidMessage`**: `RAILS_MASTER_KEY` doesn't match the credentials file, often the development key against `production.yml.enc`.
- **Missing assets, 404 on `/assets`**: `assets:precompile` failed silently or `public/assets` isn't in the image. Check the build log.
- **Redirect loop on HTTPS**: `force_ssl` without `assume_ssl`, so Rails thinks every request is plain HTTP.
- **Blocked host error**: `config.hosts` is set and doesn't include your domain. Add it, and exclude the health check path with `config.host_authorization = { exclude: ->(r) { r.path == "/up" } }`.
- **Memory grows over the day**: confirm jemalloc is loaded and lower `WEB_CONCURRENCY` or `RAILS_MAX_THREADS` to fit the memory limit.

## FAQ

### Do I need Kamal to deploy Rails 8?

No. Kamal is one option that Rails 8 includes. The generated Dockerfile builds on any Docker platform, and the rest of the Rails 8 defaults (Thruster, Solid Queue, Solid Cache) work the same everywhere.

### How many Puma workers should I run?

Size to the container's CPU limit: one worker per core is a good start, with `RAILS_MAX_THREADS` at 3 to 5. Each worker is a full Ruby process, so memory sets the ceiling. Scale with more replicas when one container is full.

### Where do Rails logs go in Docker?

The generated production config logs to stdout when `RAILS_LOG_TO_STDOUT` is set, and recent versions do so by default. Your platform collects stdout from every replica, so no log files are needed inside the container.

### Can I run Rails console in production?

Yes. Open a shell in a running container and run `bin/rails console`. In LogiStack, use the service's **Terminal** tab.

Rails already gives you a production-grade Dockerfile. What remains is running migrations once per release, keeping jobs in their own process and storing uploads off the container. To get all of that on your own server, with managed Postgres, backups and HTTPS, [install LogiStack](/#install).

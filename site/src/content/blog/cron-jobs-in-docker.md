---
title: "Cron jobs in Docker: 5 ways to schedule tasks that work"
description: "How to run cron jobs in Docker: host cron, cron inside a container, supercronic, Swarm jobs and platform schedulers, with fixes for env vars, logs and overlaps."
date: 2026-11-08
category: Deployment
keywords: cron jobs in docker, docker cron, cron in docker container, docker scheduled tasks, supercronic
---

You add a crontab line to your Dockerfile, build, deploy, and the job never runs. Or it runs, but `DATABASE_URL` is empty. Or it runs and fails, and you find out three weeks later because its output went nowhere. Cron jobs in Docker are one of those things that look trivial and are not, because cron was designed for long-lived Unix machines and containers are short-lived, single-process and configured through the environment. This guide compares five ways to schedule tasks with Docker, shows working setups for each, and covers the problems they all share: environment variables, logs, time zones, overlapping runs and knowing when a job silently stopped.

## Why cron and containers do not mix well

Classic `cron` makes assumptions that containers break:

- **It expects to be a daemon among many processes.** A container usually runs one process. If cron is that process, your app is not, and vice versa.
- **It strips the environment.** Jobs run with a minimal environment, so the variables Docker passed to the container are not there.
- **It sends output by mail.** Inside a container there is no mail system, so output disappears instead of reaching `docker logs`.
- **It runs in the container's time zone**, which is UTC unless you set one.
- **It does not know about replicas.** Run three replicas of a container that contains cron, and every job runs three times.

Each approach below solves some of these. Pick based on where the job needs to run and how many servers you have.

## Option 1: host cron that calls docker

The simplest setup: the server's own crontab runs a command inside an existing container.

```bash
# /etc/cron.d/app-jobs
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

15 2 * * * root docker exec app-web php artisan queue:prune-failed --hours=72 >> /var/log/app-jobs.log 2>&1
```

`docker exec` runs inside the container, so the job sees the container's environment variables, network and volumes.

**Good for:** a single server, a few jobs, an app container that is always running.
**Weak spots:** the schedule lives outside your repository and deployment. Container names must be stable. On Swarm, container names include a task ID, so `docker exec` by name breaks; you need `docker ps --filter name=...` lookups, and only on the node that runs the task.

## Option 2: cron inside the app container

Some images run cron next to the app with a process supervisor. It works, but every replica runs every job, and one process crashing can hide behind the other. If you do this, run exactly one replica of the container that holds the schedule, and prefer a dedicated scheduler container (option 3) built from the same image.

## Option 3: a scheduler container with supercronic

supercronic is a cron implementation built for containers: it reads a normal crontab, passes the container's environment to jobs, logs to stdout, and handles signals properly. Run it as a separate service from the same image as your app, with one replica.

```dockerfile
FROM php:8.3-cli-alpine
RUN apk add --no-cache supercronic tzdata
WORKDIR /app
COPY . .
COPY crontab /etc/crontab
CMD ["supercronic", "-passthrough-logs", "/etc/crontab"]
```

```text
# crontab: standard five fields
*/5 * * * * php /app/artisan schedule:run
15 2 * * * php /app/artisan reports:nightly
```

```yaml
services:
  web:
    image: ghcr.io/acme/shop:2026.11.08
  scheduler:
    image: ghcr.io/acme/shop-scheduler:2026.11.08
    environment:
      TZ: Europe/Rome
      DATABASE_URL: ${DATABASE_URL}
    deploy:
      replicas: 1
```

**Good for:** jobs that belong to the app, versioned with it in the repository.
**Weak spots:** one more service to run, and no run history beyond what you log. If the scheduler container is down during a fire time, that run is lost.

Ofelia is a similar idea driven by Docker labels: one scheduler container reads labels on your other containers and runs `docker exec` jobs in them. It needs the Docker socket, which is a large privilege to grant.

## Option 4: Swarm and Kubernetes jobs

Docker Swarm has job services since Engine 20.10. A `replicated-job` runs a task to completion instead of keeping it alive:

```bash
docker service create --name nightly-report \
  --mode replicated-job \
  --restart-condition none \
  --network shop_internal \
  --secret pg_password \
  ghcr.io/acme/shop:2026.11.08 php artisan reports:nightly
```

Swarm has no built-in schedule, though. Something still has to create or re-run the job at the right time, usually host cron on a manager or an external scheduler. Kubernetes, by contrast, has a native `CronJob` resource with a schedule, concurrency policy and history limits. If you already run Kubernetes, use it.

## Option 5: a platform scheduler

PaaS platforms usually ship their own scheduler: you give it a command, a cron expression and a target, and it handles running, logging, history and failure alerts. This is the least code to maintain, at the price of living inside that platform. LogiStack's version is described at the end.

## Cron jobs in Docker: the options compared

| Approach | Env vars | Logs | Run history | Multi-node | Effort |
| --- | --- | --- | --- | --- | --- |
| Host cron + `docker exec` | Container's | Host file you configure | No | Awkward | Low |
| Cron inside the app container | Needs a workaround | Needs a workaround | No | Duplicates per replica | Medium |
| supercronic scheduler service | Container's | stdout | No | One replica anywhere | Medium |
| Swarm `replicated-job` | Service's | `docker service logs` | Task list, briefly | Yes | Medium, plus a trigger |
| Kubernetes `CronJob` | Pod's | Pod logs | Limited history | Yes | Low if you run Kubernetes |
| Platform scheduler | Service's | Kept per run | Yes | Yes | Lowest |

## Problems every approach shares

### Environment variables

If you run plain `cron` in a container, jobs do not inherit Docker's environment. The common hack, dumping `env` to a file at start and sourcing it in each job, leaks secrets to disk. Use supercronic, `docker exec`, or a platform that runs the job with the service's environment.

### Time zones and daylight saving

Containers default to UTC. `0 2 * * *` in UTC is 03:00 or 04:00 in Rome, depending on the season. Set `TZ` and install `tzdata` if you want local time, and be aware that with daylight saving a job at 02:30 local time can run twice or not at all on change days. For jobs where that matters, schedule outside 01:00 to 03:00 or stay on UTC.

### Overlapping runs

A job scheduled every five minutes that sometimes takes seven will eventually run twice at once. If it writes data, that corrupts things. Guard it:

```sh
#!/bin/sh
set -eu
exec flock -n /tmp/sync.lock php /app/artisan catalog:sync
```

`flock -n` exits at once if the previous run still holds the lock. On several nodes a local lock is not enough: use a database advisory lock or a scheduler that enforces one run at a time.

### Timeouts

A job stuck on a network call holds its lock forever and blocks every future run. Wrap long jobs with `timeout 30m <command>` or use a scheduler with a per-run timeout.

### Idempotency

Jobs get retried, run late, and occasionally run twice. Write them so a second run does no harm: upsert instead of insert, process "everything not yet processed" instead of "yesterday's rows".

### Knowing when a job stopped

The worst cron failure is silence. A job that stopped running sends no error. Two defenses:

- **Alert on failure**: non-zero exit codes should reach a channel someone reads.
- **Alert on absence** with a heartbeat: the job pings a URL on success, and a monitor alerts when the ping does not arrive. Our post on [uptime monitoring](/blog/uptime-monitoring/) covers heartbeats, and Healthchecks is in the LogiStack [template catalog](/templates/healthchecks/).

### Backups are a special case

Backups look like cron jobs but need more: retention, encryption, off-site storage and restore tests. Use a dedicated backup tool rather than a `pg_dump` cron line. See our [database backup](/blog/database-backup/) guide.

## Scheduled jobs in LogiStack

LogiStack is an open-source, self-hosted PaaS on Docker Swarm with a built-in scheduler. From the [schedules docs](/docs/data/schedules/), a schedule runs a shell script on a cron expression in one of three places:

- **A fresh container** from any image, such as `postgres:17` or `alpine:3.22`, removed after the run.
- **Inside a running service**, with that service's environment variables (secrets included), network and volumes. With several replicas, one is picked per run, so the job does not run once per replica.
- **On a node's host**, for admins, for jobs that need the machine itself.

![A schedule's page with the latest run's exit code, duration and output, and run history](/docs/screens/schedule-detail.webp)

Each schedule has a time zone (daylight saving included) and shows the next five runs, a timeout from 1 to 1440 minutes, and an overlap rule: skip if still running (the default), run in parallel, or replace the running one. Every run keeps its trigger, exit code, duration and output, and **Run now** starts one by hand. Failed runs can notify any channel whose rules include schedule failures.

The honest limits: expressions take five fields only, with no seconds and no `@daily` shortcuts, and output is kept up to 1 MiB per run. For database and volume backups, LogiStack has separate [backup policies](/docs/data/backups/) with retention and restore checks.

## FAQ

### How do I run a cron job in a Docker container?

The most reliable ways are a separate scheduler container running supercronic with one replica, host cron calling `docker exec` on a single server, or a platform scheduler. Avoid plain `cron` as a second process in your app container: it loses environment variables and logs, and runs once per replica.

### Why does my cron job not see environment variables in Docker?

Classic cron starts jobs with a minimal environment and does not inherit what Docker passed to the container. Use supercronic, run the job through `docker exec`, or use a scheduler that injects the service's environment.

### How do I see the output of a cron job in Docker?

Send it to stdout so it shows in `docker logs`. supercronic does this by default. With host cron, redirect output to a log file, and with a platform scheduler, read the run history.

### How do I stop a cron job from running twice at the same time?

Wrap it in `flock -n` on a single host, use a database advisory lock across several hosts, or choose a scheduler with a "skip if still running" rule. Also make the job idempotent so an accidental double run does no harm.

### Does Docker Swarm support cron jobs?

Not natively. Swarm has `replicated-job` and `global-job` service modes that run tasks to completion, but nothing triggers them on a schedule. Use host cron on a manager, a scheduler service, or a platform that adds scheduling on top of Swarm.

If you want cron jobs with time zones, overlap rules and a run history without maintaining a scheduler container, [install LogiStack](/#install) and create a schedule from the sidebar.

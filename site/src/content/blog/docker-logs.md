---
title: "Docker logs: commands, log drivers and log rotation"
description: "How Docker logs work: docker logs and service logs commands, where log files live, which log driver to use, and how to set up log rotation before disks fill."
date: 2026-11-08
category: Docker
keywords: docker logs, docker log rotation, docker logging driver, docker container logs, docker logs location
---

The server alerts at 3 a.m.: disk 100% full. You find the culprit in `/var/lib/docker/containers`, a single JSON log file of 38 GB written by a container that has been printing the same warning since March. Docker logs are easy to read and just as easy to forget, because by default Docker keeps everything and rotates nothing. This guide covers the commands you use every day, where Docker writes logs, how log drivers change that, and how to set up rotation so a chatty container never takes a server down again.

## How Docker captures logs

A container's logs are whatever its main process writes to stdout and stderr. Docker captures both streams and hands them to a **log driver**, which decides where they go. Anything the app writes to a file inside the container is not a Docker log: `docker logs` will not show it, and it disappears with the container unless it sits on a volume.

That has one practical consequence: configure apps to log to stdout and stderr. Official images do this already. Nginx, for example, symlinks `/var/log/nginx/access.log` to `/dev/stdout` inside the image.

## The docker logs command

These cover almost everything you do by hand:

```bash
# Last 100 lines, then keep following
docker logs --tail 100 -f api

# With Docker's own timestamps
docker logs -t --tail 50 api

# A time window: relative or absolute
docker logs --since 15m api
docker logs --since 2026-11-08T09:00:00 --until 2026-11-08T09:30:00 api

# Only stderr (send stdout to /dev/null)
docker logs api 2>&1 >/dev/null | tail -50

# Search with grep: merge both streams first
docker logs --since 1h api 2>&1 | grep -i "timeout"
```

`docker logs` writes the container's stdout to your stdout and its stderr to your stderr. That is why you need `2>&1` before piping into grep, or errors pass straight through the filter.

### Compose and Swarm

With Docker Compose, logs are grouped per service and prefixed with the container name:

```bash
docker compose logs -f --tail 50 api worker
```

On Docker Swarm, a service's replicas can run on several nodes. `docker service logs` collects them through the manager:

```bash
docker service logs -f --tail 100 --timestamps shop_api
docker service logs --no-task-ids --raw shop_api | grep ERROR
```

Each line carries the task name and node, so you can tell replicas apart. It only works with log drivers that keep logs locally, which brings us to drivers.

## Where Docker stores log files

With the default `json-file` driver, each container gets one file:

```bash
docker inspect --format '{{.LogPath}}' api
# /var/lib/docker/containers/3f9c.../3f9c...-json.log
```

Each line in that file is a JSON object with the message, the stream and a timestamp:

```json
{"log":"GET /healthz 200 2ms\n","stream":"stdout","time":"2026-11-08T09:14:03.211874Z"}
```

Find the largest log files on a host:

```bash
sudo du -h /var/lib/docker/containers/*/*-json.log | sort -h | tail -5
```

If one is huge and you need space now, truncate it instead of deleting it. Docker keeps the file open, so `rm` frees nothing until the container restarts:

```bash
sudo truncate -s 0 /var/lib/docker/containers/3f9c.../3f9c...-json.log
```

That is an emergency fix. The real fix is rotation.

## Docker logging drivers

A log driver is set per daemon (the default for new containers) or per container. The common ones:

| Driver | Where logs go | `docker logs` works | Notes |
| --- | --- | --- | --- |
| `json-file` | JSON file per container | Yes | Default. No rotation unless you configure it |
| `local` | Compressed, compact file per container | Yes | Rotates by default (100 MB per container in 5 files of 20 MB) |
| `journald` | systemd journal | Yes | Rotation and retention follow journald settings |
| `syslog` | A syslog daemon, local or remote | No* | Good for existing syslog setups |
| `fluentd`, `gelf`, `awslogs`, `gcplogs`, `splunk` | A remote collector or cloud service | No* | Ship directly, but local reading is lost |
| `none` | Nowhere | No | For containers whose output you never want |

\* Docker Engine 20.10 and later keeps a local "dual logging" cache for remote drivers, so `docker logs` still shows recent lines. `docker service logs` on Swarm needs `json-file`, `local` or `journald`.

### Which driver should you use?

For most servers, stay on a local driver and ship logs with a separate collector. Remote drivers couple your container to the network: in the default blocking mode, a container can stall when the log endpoint is slow. If you do use one, set `mode: non-blocking` with a `max-buffer-size`, and accept that lines can be dropped under pressure.

The `local` driver is the better default on new hosts: it compresses, rotates out of the box and uses less disk. Stick with `json-file` if a collector you run reads the JSON files directly, and then configure rotation.

## Set up Docker log rotation

Rotation is set in `/etc/docker/daemon.json` and applies to every container created afterwards.

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "20m",
    "max-file": "5",
    "compress": "true"
  }
}
```

This keeps at most five files of 20 MB per container, about 100 MB, with rotated files gzipped. Note that the values are strings, even the numbers.

Apply it:

```bash
sudo dockerd --validate --config-file /etc/docker/daemon.json
sudo systemctl restart docker
```

Three things catch people out:

1. **Existing containers keep their old settings.** The daemon default only applies to containers created after the restart. Recreate them (`docker compose up -d --force-recreate`, or redeploy the Swarm service) to pick it up.
2. **Restarting Docker restarts your containers** unless `live-restore` is on, and `live-restore` is not compatible with Swarm mode. Plan a short maintenance window.
3. **Rotation is by size, not time.** A quiet service may keep weeks of logs, a busy one only minutes. If you need "seven days of logs", ship them to a central backend.

### Per container or per service

Override the default for one container when it is unusually chatty or unusually important:

```yaml
services:
  api:
    image: ghcr.io/acme/api:2026.11.08
    logging:
      driver: local
      options:
        max-size: "50m"
        max-file: "10"
```

The same `logging` key works in Swarm stack files.

## Reading logs well

A few habits make `docker logs` far more useful during an incident.

- **Always bound the output.** `docker logs api` on a container that has run for months prints everything. Use `--tail` or `--since`.
- **Correlate by time.** Use `-t` and compare with `docker events --since 30m`, which shows container starts, stops, kills and health status changes.
- **Look at the previous container after a crash.** If a restart policy replaced the container, `docker ps -a` lists the exited one, and `docker logs <old-id>` still works until it is removed.
- **Check for OOM kills.** Logs often just stop. `docker inspect --format '{{.State.OOMKilled}}' api` tells you whether the kernel killed it.

Our guide to [container monitoring](/blog/container-monitoring/) covers crash loops and OOM kills in more depth.

## When local logs stop being enough

Local logs and rotation keep one server healthy. They do not help when a service runs on three nodes, when a deploy replaced every container, or when you need last Tuesday's errors. That is the job of [centralized logging](/blog/centralized-logging/): a collector on each node ships labelled lines to Loki, Elasticsearch, Datadog or an OpenTelemetry backend.

## Docker logs in LogiStack

LogiStack is an open-source, self-hosted PaaS on Docker Swarm. It reads the same container logs and puts them in the dashboard, so you rarely need SSH for them:

- **A Logs tab on every service** that follows every replica at once, tags each line with its replica number, and switches to the new replicas on its own after a deploy. You pick the window (5 minutes to all), the number of lines, and search with highlighted matches. See [logs and terminal](/docs/operations/logs-and-terminal/).
- **Compose stacks on one timeline**, with each line tagged by its container.
- **A browser terminal** into a running container when the logs point at something you need to inspect.
- **Log drains** that ship every line to Loki, OpenTelemetry, Datadog, syslog or an HTTP endpoint, labelled by project, environment, service and node. See [log drains](/docs/operations/log-drains/).
- **Disk use by directory** on each node, so a runaway log file shows up before the disk is full.

![The Logs tab of a service following three replicas, each line tagged by replica](/docs/screens/service-logs.webp)

LogiStack does not replace host-level hygiene. Set Docker's log rotation in `daemon.json` on each node as described above.

## FAQ

### Where are Docker container logs stored?

With the default `json-file` driver, in `/var/lib/docker/containers/<container-id>/<container-id>-json.log` on the host. `docker inspect --format '{{.LogPath}}' <container>` prints the exact path.

### How do I clear Docker logs?

Truncate the file with `sudo truncate -s 0 <path>` instead of deleting it, because Docker keeps the file open. Then configure rotation in `/etc/docker/daemon.json` so it does not happen again.

### Does Docker rotate logs by default?

Not with the default `json-file` driver: it grows without limit. The `local` driver rotates by default. Set `max-size` and `max-file` in `daemon.json` for `json-file`.

### Why does docker logs show nothing?

The app writes to a file inside the container instead of stdout and stderr, or the container uses a remote log driver without a local cache. Check the driver with `docker inspect --format '{{.HostConfig.LogConfig.Type}}' <container>`.

### How do I see logs for a Docker Swarm service?

Use `docker service logs <service>` on a manager node. It merges every replica's output and labels each line with its task and node. It needs a local log driver on each node.

If you would rather read every replica's logs in a browser and ship them to your backend without running collectors, [install LogiStack](/#install) and open a service's Logs tab.

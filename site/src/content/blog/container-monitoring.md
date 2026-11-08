---
title: "Container monitoring: metrics, tools and a setup that works"
description: "Learn container monitoring for Docker: the metrics that catch OOM kills and crash loops, the commands and tools to collect them, and how to alert in real time."
date: 2026-11-08
category: Monitoring
keywords: container monitoring, docker container monitoring, docker monitoring, monitor docker containers, container metrics
---

A container that crashed and restarted at 3:12 leaves almost no trace. By the time you look, a fresh container with a new ID is running, its logs start at 3:12, and the host's CPU chart shows nothing unusual. Container monitoring exists for exactly this: tracking short-lived, resource-limited processes that share a host and replace themselves. This guide covers what makes containers harder to watch than servers, which container metrics matter, how to collect them with Docker's own tools and with dedicated software, and how to get alerts while a problem is still happening.

## Why containers need their own monitoring

Server monitoring answers "is this machine healthy". It cannot answer "which of the 40 containers on this machine is eating the memory". Containers change the problem in four ways.

- **They are short-lived.** A deploy, a crash or a rescheduling replaces a container. Its ID, its logs and its metrics history go with it unless something outside the container keeps them.
- **They have their own limits.** A container capped at 512 MB is killed at 512 MB, even when the host has 30 GB free. Host memory looks fine while the app restarts every hour.
- **They share the host.** One noisy container slows every neighbour through CPU contention or disk I/O. You need per-container figures to find it.
- **They come in groups.** A service runs as several replicas, often on several hosts. The question you ask is about the service, so metrics need to be aggregated by service, not just listed by container ID.

## The container metrics that matter

| Metric | Why it matters | What a problem looks like |
| --- | --- | --- |
| CPU usage vs. limit | Shows how close a container is to its cap | Flat line at the limit: the container is throttled and slow |
| Memory usage vs. limit | Predicts OOM kills | Usage climbing toward the limit, then a drop and a restart |
| Restart count / exit codes | The clearest sign of a crash loop | Exit code 137 (killed, often OOM) or 1 repeating |
| Running replicas vs. desired | Shows whether the service is at full strength | 2 of 3 replicas reporting for several minutes |
| Network in/out | Traffic shape, stuck clients, data leaks | Sudden drop to zero, or outbound spikes nobody expects |
| Block I/O read/write | Finds containers that hammer the disk | One container's writes coincide with host I/O wait |
| Health check status | Whether the app inside answers, not just runs | Container "running" but marked unhealthy |

Two details worth knowing:

- **CPU percent is relative.** Docker reports 100% per fully used core, so a container using two cores shows 200%. Compare usage against the container's own limit, not against 100.
- **Memory includes cache.** Docker's figure subtracts reclaimable page cache on cgroup v2, but some tools show raw usage. If one tool says 480 MB and another 300 MB, check which one counts cache.

## Monitor Docker containers from the command line

Docker ships enough to diagnose most problems on a single host.

```bash
# Live CPU, memory, network and block I/O for every running container
docker stats

# One snapshot, formatted, without streaming
docker stats --no-stream \
  --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}"

# Restart count, last exit code and whether it was OOM-killed
docker inspect --format \
  '{{.Name}} restarts={{.RestartCount}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}' \
  $(docker ps -aq)

# Container lifecycle events as they happen: die, oom, kill, health_status
docker events --filter type=container \
  --filter event=die --filter event=oom --filter event=health_status

# The last 200 log lines of a container, with timestamps
docker logs --tail 200 --timestamps <container>
```

`docker events` is underrated. Leave it running in a terminal during an incident and you see each crash, kill and health change with its time.

The limits of the CLI are obvious: no history, no aggregation across hosts, no alerts. The moment a container is replaced, `docker stats` forgets it ever existed.

## Tools for container monitoring

### cAdvisor and Prometheus

cAdvisor runs on each host, reads cgroup data for every container and exposes it as Prometheus metrics. Prometheus scrapes it, stores the history and evaluates alert rules. Grafana draws the charts.

```yaml
# compose.yaml: cAdvisor on one host
services:
  cadvisor:
    image: gcr.io/cadvisor/cadvisor:v0.49.1
    ports:
      - "8080:8080"
    volumes:
      - /:/rootfs:ro
      - /var/run:/var/run:ro
      - /sys:/sys:ro
      - /var/lib/docker/:/var/lib/docker:ro
    privileged: true
    devices:
      - /dev/kmsg
```

An alert rule for a container close to its memory limit then looks like this:

```yaml
groups:
  - name: containers
    rules:
      - alert: ContainerMemoryNearLimit
        expr: |
          container_memory_working_set_bytes{name!=""}
            / container_spec_memory_limit_bytes{name!=""} > 0.9
          and container_spec_memory_limit_bytes{name!=""} > 0
        for: 5m
        labels:
          severity: warning
```

This stack is flexible and free, and it is also four components to run, upgrade and back up.

### Agent-based SaaS

Datadog, Grafana Cloud, New Relic and similar services run an agent on each host that discovers containers and sends their metrics and logs to a hosted backend. Discovery, dashboards and correlation with logs come ready. The trade-off is a bill that scales with hosts and data volume, and your data on their infrastructure.

### Orchestrator-native views

If you run Kubernetes, the Metrics Server feeds `kubectl top`, and most teams add Prometheus through an operator. On Docker Swarm, `docker service ps` shows task history per service, which already tells you about restarts. We cover Swarm in detail in [Docker Swarm monitoring](/blog/docker-swarm-monitoring/).

### The platform that runs the containers

If a PaaS deploys your containers, it already knows which containers belong to which service, what their limits are and how many replicas should be running. That makes it a natural place for container monitoring, with no extra discovery or labelling.

## Real-time monitoring: what "live" should mean

"Real-time" gets used loosely. For containers, three things should be live:

1. **Logs.** You should be able to follow every replica's output as it is printed, and the view should switch to the new containers after a deploy without a reload.
2. **State changes.** A crash loop or a failed health check should reach you within seconds to a minute, as an event, not after the next five-minute poll.
3. **Metrics, at a sensible interval.** Ten seconds is enough to see a spike. One-second metrics are useful for profiling a single host, and expensive to keep for a fleet.

What should not be real-time is paging. Wait for a condition to hold over a window before you send a push to someone's phone.

## How LogiStack monitors containers

LogiStack is an open-source self-hosted PaaS that runs your apps as Docker Swarm services. Because it creates every container, it monitors them without any setup.

- **Per-service charts.** The Metrics tab of each service sums CPU, memory, network and block I/O across every replica on every node, with the memory limit drawn as a dashed line. A **Replicas reporting** chart shows dips when a replica restarts or is replaced. Ranges go from 1 hour to 30 days. See [metrics](/docs/operations/metrics/).
- **Per-container data over the API.** To chart one container, call `/api/metrics/containers/{id}` with its Docker container ID.
- **Crash-loop events.** When a service's tasks keep failing, LogiStack emits a `service.crash_loop` event, and again when it settles. No threshold needed.
- **Service thresholds.** Alert when a service's CPU (percent of a core) or memory (percent of its limit, or an absolute figure in MB) stays over a limit for a window you choose. See [alerts and notifications](/docs/operations/alerts-and-notifications/).
- **Live logs.** The Logs tab follows every replica, tags each line with its replica number, separates stdout from stderr and switches to new replicas after a deploy. See [logs and terminal](/docs/operations/logs-and-terminal/).
- **Image scanning.** Each running image is checked for known vulnerabilities after deploy and daily, which is part of container health too. See [vulnerability scanning](/docs/operations/vulnerability-scanning/).

![The Metrics tab of a LogiStack service with CPU, memory against its limit, network, block I/O and replicas reporting](/docs/screens/service-metrics.webp)

A typical diagnosis takes a minute: the memory chart over 7 days shows usage climbing to the limit line just before each dip in replicas reporting. The container is being OOM-killed. Raise the limit in the service settings and add a memory threshold at 90% of the limit so you hear about it next time.

What LogiStack does not do: it does not trace requests or collect your app's own metrics. For that, ship logs through a [log drain](/docs/operations/log-drains/) to an OpenTelemetry collector, Loki or Datadog, or run Prometheus from the [templates](/templates/).

## FAQ

### What is the difference between container monitoring and server monitoring?

Server monitoring measures the whole host. Container monitoring measures each container against its own limits and groups containers by the service they belong to. You need both: a healthy host can run a container that is being killed every hour.

### How do I know if a Docker container was killed for running out of memory?

Run `docker inspect --format '{{.State.OOMKilled}} {{.State.ExitCode}}' <container>`. `true` and exit code 137 mean the kernel killed it for exceeding its memory limit. If the container has already been replaced, check `docker events` history or your monitoring tool's memory chart against the limit.

### Is docker stats enough for monitoring?

For a quick look on one host, yes. It keeps no history, sends no alerts and forgets containers once they are removed, so it is not enough for production. Pair it with a tool that stores metrics and watches for restarts.

### How often should container metrics be collected?

Every 10 to 15 seconds works for most workloads. Faster collection rarely changes a decision and multiplies storage. Use events for state changes such as crashes, so you do not depend on the sampling interval to catch them.

If you would rather have container metrics, crash-loop alerts and live logs arrive with every service you deploy, [install LogiStack](/#install) and deploy one app.

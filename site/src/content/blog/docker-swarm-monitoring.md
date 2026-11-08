---
title: "Docker Swarm monitoring: nodes, services, logs and alerts"
description: "A complete guide to Docker Swarm monitoring: what to watch on managers, nodes and services, a Prometheus setup with Swarm discovery, and how to centralize logs."
date: 2026-11-08
category: Monitoring
keywords: docker swarm monitoring, swarm monitoring, monitor docker swarm, swarm prometheus, docker swarm logging
---

On one Docker host, a missing container is easy to spot. In a Swarm, the orchestrator hides failures on purpose: a task dies, Swarm starts another on a different node, and the service still reports 3/3 a minute later. That is great for uptime and bad for visibility. Docker Swarm monitoring is about seeing what the scheduler quietly fixed, what it could not fix, and whether the cluster itself (managers, nodes, overlay networks) is healthy. This guide covers the signals that matter at each level, the commands to read them, a Prometheus setup that discovers Swarm targets on its own, and how to get logs out of a cluster.

## What makes Swarm monitoring different

Monitoring a Swarm adds three layers on top of single-host monitoring:

1. **The control plane.** Manager nodes hold the cluster state in a Raft log. Lose quorum and you can no longer deploy, scale or reschedule, even though running containers keep going.
2. **Nodes as a pool.** Every worker is a slot in a shared pool. A node that goes down or runs out of memory changes where everything else can run.
3. **Services, not containers.** You deploy services with a desired replica count. Swarm creates tasks to meet it. The useful question is "does each service have the replicas it wants, and are they stable", not "is container a1b2c3 up".

## Signals to watch at each level

| Level | Signal | Why it matters |
| --- | --- | --- |
| Managers | Reachable managers vs. total | With 3 managers you survive losing 1; with 2 you survive losing none |
| Managers | Leader changes | Frequent elections point to network or disk latency on managers |
| Nodes | Status (Ready/Down) and availability (Active/Drain/Pause) | A Down node means its tasks were rescheduled elsewhere |
| Nodes | CPU, memory, disk | Swarm only places a task where its reservations fit |
| Services | Running vs. desired replicas | Below desired for minutes means tasks cannot start or keep failing |
| Services | Task failures and restarts | The scheduler hides crashes; task history reveals them |
| Services | Update state | A rolling update that paused or rolled back needs a human |
| Tasks | Pending tasks | No node satisfies the constraints or has the resources |
| Network | Overlay connectivity | Services that cannot reach each other across nodes fail in confusing ways |

## Read the Swarm from the command line

Run these on a manager. They cover most day-to-day questions.

```bash
# Nodes: status, availability, manager role and leader
docker node ls

# Services: desired vs. running replicas at a glance
docker service ls

# Task history of one service, including failed and shut-down tasks with errors
docker service ps --no-trunc <service>

# Only tasks that are not running, across one service
docker service ps --filter desired-state=shutdown <service>

# Rolling update status: updating, paused, completed, rollback_completed
docker service inspect --format '{{json .UpdateStatus}}' <service>

# Raft and manager details for this node
docker info --format '{{json .Swarm}}'

# Cluster-wide events: node, service and task changes as they happen
docker events --filter scope=swarm
```

`docker service ps` is the single most useful command here. A service showing 3/3 with fifteen "Shutdown" or "Failed" tasks in its history is crash-looping, and the error column says why ("task: non-zero exit (137)" is usually an OOM kill).

Pending tasks deserve their own check. A task stuck in Pending typically means "no suitable node": placement constraints that match nothing, or resource reservations no node can satisfy.

## A Prometheus stack for Swarm

The standard self-hosted setup has four parts:

- **node_exporter** as a global service: one per node, host metrics.
- **cAdvisor** as a global service: per-container metrics on every node.
- **Prometheus**, with Swarm service discovery so it finds the exporters and services without a static target list.
- **Grafana** for dashboards, and Alertmanager for routing alerts.

Prometheus has native Swarm discovery (`dockerswarm_sd_configs`). Here is a stack file that runs the exporters globally and discovers them:

```yaml
# monitoring-stack.yml, deploy with: docker stack deploy -c monitoring-stack.yml mon
services:
  node-exporter:
    image: quay.io/prometheus/node-exporter:v1.8.2
    command: ["--path.rootfs=/host"]
    volumes:
      - /:/host:ro,rslave
    deploy:
      mode: global

  cadvisor:
    image: gcr.io/cadvisor/cadvisor:v0.49.1
    volumes:
      - /:/rootfs:ro
      - /var/run:/var/run:ro
      - /sys:/sys:ro
      - /var/lib/docker/:/var/lib/docker:ro
    deploy:
      mode: global

  prometheus:
    image: prom/prometheus:v2.54.1
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - prometheus-data:/prometheus
    configs:
      - source: prometheus.yml
        target: /etc/prometheus/prometheus.yml
    deploy:
      placement:
        constraints: [node.role == manager]

configs:
  prometheus.yml:
    file: ./prometheus.yml

volumes:
  prometheus-data:
```

```yaml
# prometheus.yml
scrape_configs:
  - job_name: swarm-tasks
    dockerswarm_sd_configs:
      - host: unix:///var/run/docker.sock
        role: tasks
    relabel_configs:
      # Keep only running tasks of the exporter services
      - source_labels: [__meta_dockerswarm_task_desired_state]
        regex: running
        action: keep
      - source_labels: [__meta_dockerswarm_service_name]
        regex: mon_(node-exporter|cadvisor)
        action: keep
      - source_labels: [__meta_dockerswarm_node_hostname]
        target_label: node
```

Prometheus needs to reach the exporters, so in a real setup you also put all three services on a shared overlay network and filter targets to that network. The Docker socket mount gives Prometheus read access to the Swarm API: treat that service as privileged and keep it on a manager you trust.

Useful alert rules for a Swarm include: a node not reporting for 1 minute, a service with fewer running tasks than desired for 5 minutes, a container restarting more than 3 times in 15 minutes, and disk above 85% on any node.

This stack works well. It is also yours to run: upgrades, storage sizing, dashboards and alert rules are all your job. Community bundles such as Swarmprom packaged this setup years ago, but are no longer actively maintained, so build from current images.

## Logging in a Swarm

Metrics tell you a service is unhealthy. Logs tell you why, and in a Swarm they are scattered across nodes.

### Logging drivers

Each container's output goes through a logging driver. The default `json-file` keeps logs on the node where the task ran. `docker service logs <service>` gathers them from every node through the managers, which is handy but not a log system: it is slow on busy services, and logs from a removed node are gone.

Options for centralizing:

- **Change the driver.** `syslog`, `gelf`, `fluentd` and others send logs off the node directly. The catch: with some drivers, `docker logs` no longer works locally, and a slow destination can block containers unless you set `mode: non-blocking`.
- **Keep `json-file` (or `local`) and ship from the node.** An agent such as Promtail, Vector, Fluent Bit or the OpenTelemetry Collector runs globally, tails the files and ships them. Local logs keep working, and the agent buffers when the destination is down.

Set rotation either way, or the default driver fills disks:

```json
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "5" }
}
```

That goes in `/etc/docker/daemon.json` on every node, followed by a Docker restart. It applies to containers created afterwards.

### Label your logs

Whatever ships the logs should attach the service, the node and the task, so you can filter in Loki, Elasticsearch or Datadog. A query such as "errors from the api service in production, on any node, in the last hour" is the whole point of centralizing.

## Docker Swarm monitoring with LogiStack

LogiStack is an open-source self-hosted PaaS built on Docker Swarm. Monitoring the Swarm is part of the platform, so the stack above becomes optional.

- **An agent on every node.** LogiStack's agent runs as a global service and reports host and container metrics every 10 seconds over one outbound WebSocket. See [architecture](/docs/reference/architecture/).
- **Node health.** Every node shows its status, availability and labels. A built-in alert fires `node.down` when a node's agent misses heartbeats for 30 seconds, and `node.recovered` when it is back. See [nodes](/docs/operations/nodes/).
- **Cluster and per-node charts.** CPU, memory, disk and network for the cluster, each node or one line per node, from 1 hour to 30 days. See [metrics](/docs/operations/metrics/).
- **Desired vs. observed state.** A reconciler compares each service with what Docker reports every 30 seconds, records the observed state (running, starting, unhealthy, stopped, failed) and detects crash loops, which become `service.crash_loop` events.
- **Rollouts you can see.** Updates run start-first with automatic rollback; each deployment's status and log show in the dashboard.
- **Thresholds and routing.** Node and service thresholds, sent to Slack, email, ntfy and seven more channel types. See [alerts and notifications](/docs/operations/alerts-and-notifications/).
- **Log drains.** Each node's agent ships its containers' logs to Grafana Loki, OpenTelemetry, Datadog, syslog or HTTP, labelled with project, environment, service, deployment ID, node and stream. It buffers up to 8 MB per drain while a destination is down. See [log drains](/docs/operations/log-drains/).

![The LogiStack Log drains page with a Grafana Cloud drain and a Datadog drain](/docs/screens/log-drains.webp)

With a Loki drain, the query from the previous section is one line:

```logql
{project="Storefront", environment="production", service="api"} |= "error"
```

Trade-offs to know: LogiStack is a young project, it runs on Swarm only (no Kubernetes), and it does not replace an APM or tracing backend. If you already run Prometheus, keep it: point it at your nodes as before and let LogiStack handle deploys, alerts and log shipping. For background on the orchestrator itself, see [Docker Swarm](/blog/docker-swarm/) and [Docker Swarm vs. Kubernetes](/blog/docker-swarm-vs-kubernetes/).

## FAQ

### How do I check the health of a Docker Swarm?

Run `docker node ls` on a manager to see each node's status and which manager leads, then `docker service ls` to compare running and desired replicas. For any service that looks off, `docker service ps --no-trunc <service>` shows failed tasks and their errors.

### How many manager nodes should a Swarm have?

Three for most clusters, five for large ones. Raft needs a majority, so three managers tolerate one failure and five tolerate two. Monitor how many managers are reachable, because losing quorum stops all scheduling.

### Can Prometheus discover Docker Swarm services?

Yes. Prometheus has built-in Swarm service discovery through `dockerswarm_sd_configs`, with roles for services, tasks and nodes. It reads the Swarm API through the Docker socket or a TCP endpoint, so run it on a manager node.

### Where do Docker Swarm logs go?

By default, to `json-file` logs on the node where each task ran. `docker service logs` collects them on demand, but nothing is centralized or kept after a node is removed. Use a shipping agent or a platform log drain to send them to Loki, Elasticsearch or a SaaS backend.

If you want a Swarm that arrives with node alerts, service metrics and log shipping already wired, [install LogiStack](/#install) on your first manager and add the other nodes from the dashboard.

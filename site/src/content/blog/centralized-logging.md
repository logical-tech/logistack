---
title: "Centralized logging for containers: a practical setup"
description: "Centralized logging explained for Docker and small clusters: how to collect, ship, label and store logs, which backends to pick, and what retention costs."
date: 2026-11-08
category: Monitoring
keywords: centralized logging, log aggregation, centralized log management, docker centralized logging, loki logging
---

A request fails. The error is somewhere in the logs of one of six replicas, spread over three servers, and two of those containers were replaced by a deploy an hour ago, taking their logs with them. You open three SSH sessions and grep. Centralized logging exists so you never do that again: every line from every service lands in one place, labelled with where it came from, kept for as long as you decide, and searchable in seconds. This guide covers how a centralized logging pipeline works, how to label logs so you can find things, which backend to choose, and how to keep the bill sane.

## Why logs on the host are not enough

Docker keeps each container's output in a file on the node that runs it. That works for one server and one container. It stops working as soon as any of these is true:

- **Containers are replaced.** A redeploy or a crash creates a new container. Once Docker removes the old one, its log file goes with it.
- **Services run on several nodes.** The line you need is on whichever server ran that replica at that minute.
- **Disks fill.** Without rotation, logs grow until the node runs out of space. With rotation, old lines vanish on a size limit, not a time limit.
- **You need history.** "Did this error start before or after Tuesday's deploy?" needs days or weeks of logs, not the last few megabytes.

If you want the details of how Docker stores and rotates logs on a single host, read our guide to [Docker logs](/blog/docker-logs/). This article starts where that one ends: getting logs off the host.

## The four parts of a logging pipeline

Every centralized logging setup, from a homelab to a large company, has the same four stages.

1. **Collect.** Something reads logs where they are produced: Docker's log files, the Docker API, journald, or a log driver.
2. **Enrich.** Each line gets metadata: service, environment, node, deployment. Without this step, central logs are one giant unlabelled stream.
3. **Ship.** Lines travel to the backend in batches, with retries and a buffer for when the backend is down.
4. **Store and query.** A backend indexes the lines, keeps them for a retention period and gives you a query language and a UI.

Common collectors are Vector, Fluent Bit, the OpenTelemetry Collector and Grafana Alloy (which replaces Promtail for Loki). You run one per node, usually as a container with read access to Docker's log directory or socket.

## Make logs worth centralizing

Shipping unreadable logs to a central place gives you unreadable logs in a central place. Two habits in the application make the biggest difference.

### Log structured JSON

One JSON object per line lets the backend filter by field instead of by regex:

```json
{"time":"2026-11-08T09:14:03.211Z","level":"error","msg":"payment failed","order_id":"ord_8812","provider":"stripe","duration_ms":4120}
```

Most languages have a fast structured logger: pino for Node.js, `log/slog` in Go's standard library, structlog for Python, Monolog with a JSON formatter for PHP. Write to stdout and stderr. Let the platform handle files.

### Keep messages stable, put variables in fields

`"payment failed"` with an `order_id` field groups cleanly. `"payment failed for order ord_8812 after 4120ms"` creates a unique message per order, which defeats grouping and pattern detection.

## Labels, fields and cardinality

Backends handle metadata in two ways, and confusing them is the most common way to make a logging bill explode.

- **Indexed labels** (Loki labels, Datadog tags, Elasticsearch keyword fields) are fast to filter on but cost memory and storage for every distinct value.
- **Content** (the message and its JSON fields) is searched at query time and costs only bytes.

Rule of thumb: labels describe **where** a line came from, content describes **what** happened.

| Good as a label | Keep in the content |
| --- | --- |
| Project, environment, service | User ID, order ID, email |
| Node or host name | Request ID, trace ID |
| Stream (stdout or stderr) | URL path with IDs in it |
| Deployment ID | Error message text |

A label with millions of distinct values, such as a user ID, can make Loki slow or reject writes. Put it in the JSON and filter with a parser at query time.

## Choosing a backend

| Backend | Model | Strengths | Trade-offs |
| --- | --- | --- | --- |
| Grafana Loki | Open source, self-hosted or Grafana Cloud | Indexes labels only, cheap storage on object storage, LogQL, sits next to Grafana dashboards | Full-text search over long ranges is slower than an inverted index |
| Elasticsearch or OpenSearch | Open source, self-hosted or managed | Full-text index, fast arbitrary search, mature ecosystem (Kibana, OpenSearch Dashboards) | Memory-hungry, real operational work at scale |
| OpenObserve | Open source, self-hosted or cloud | Logs, metrics and traces in one binary, columnar storage on object storage | Younger project, smaller community |
| Datadog, Better Stack, other SaaS | Hosted | No infrastructure, polished search, correlation with APM | Priced per GB ingested and retained, which adds up with chatty services |
| Syslog server | Classic, self-hosted | Simple, works with network gear and old systems | Plain text, weak querying |

For a small team on its own servers, Loki on a single node with its chunks in S3-compatible storage is hard to beat on cost. If your team already lives in Datadog, ship there and accept the per-GB pricing. If you need fast full-text search over months, Elasticsearch or OpenSearch earn their memory.

OpenObserve and Grafana are in LogiStack's [template catalog](/templates/) (see [`openobserve`](/templates/openobserve/)), and our post on [self-hosting Grafana](/blog/self-host-grafana/) covers the dashboard side.

## Retention and cost

Logs are the one telemetry signal that grows with traffic, so decide retention on purpose.

- **Hot, searchable logs: 7 to 30 days.** This covers almost every incident investigation.
- **Archive: months or years**, compressed in object storage, if compliance or audits require it. You rarely query it, so it can be slow.
- **Drop noise at the source.** Health check access lines, debug logs in production and per-request "starting handler" messages are often half the volume.

Estimate before you commit. A service logging 50 lines per second at 300 bytes per line produces about 1.3 GB per day before compression. Ten such services for 30 days is around 390 GB raw. Loki and most columnar stores compress logs well, often by 5 to 10 times, but SaaS pricing usually counts ingested bytes before compression.

## Query examples

With labels in place, a query reads like a sentence. In Loki's LogQL:

```logql
{project="Storefront", environment="production", service="api"} |= "payment failed"
```

Filter on a JSON field and count errors per minute:

```logql
sum by (service) (
  count_over_time({environment="production"} | json | level="error" [1m])
)
```

The second query is a metric derived from logs. You can chart it next to CPU and alert on it in Grafana.

## What happens when the backend is down

A logging pipeline must never take the application down with it. Check these properties in whatever you run:

- **Containers never block on logging.** Docker's default `json-file` driver writes to disk, and the collector reads asynchronously. Remote log drivers configured in blocking mode can stall a container when the network hangs.
- **The shipper buffers.** A bounded buffer per destination, with retries and backoff, survives a backend restart.
- **Loss is visible.** When the buffer overflows, the shipper should drop the oldest lines and say how many, not fail silently.

## Centralized logging in LogiStack

LogiStack is an open-source, self-hosted PaaS on Docker Swarm, and it handles the collect, enrich and ship stages for you with [log drains](/docs/operations/log-drains/). An admin adds a drain once for the organization, picks which projects or services ship to it, and the agent on each node reads its own containers' logs and sends them in batches.

![The Log drains page with a Grafana Cloud drain delivering and a Datadog drain degraded on one node](/docs/screens/log-drains.webp)

What the docs confirm:

- **Five destination kinds**: Grafana Loki, OpenTelemetry (OTLP/HTTP), Datadog, any HTTP endpoint that accepts a JSON array, and syslog over TCP, TLS or UDP.
- **Labels on every line**: organization, project, environment, service, deployment ID, node and stream. In Loki they are labels, in OpenTelemetry they map to resource attributes such as `service.name` and `deployment.environment.name`, in Datadog they become tags.
- **A test event** in the setup wizard, so you know the destination accepts writes before you rely on it.
- **Per-node health**: each drain shows Delivering, Degraded or Failing, with the failing node and its error.
- **Backpressure that never blocks containers**: each node buffers up to 8 MB per drain, retries with backoff, and drops the oldest lines first when full, with the count shown on the drain.

For quick looks you do not need a drain at all. Each service has a **Logs** tab with live and historical output from every replica, search, and a time window, described in [logs and terminal](/docs/operations/logs-and-terminal/). Drains are for retention, cross-service search and correlation with your other telemetry.

The honest limit: LogiStack ships logs, it is not a log database. Long-term storage and querying happen in the backend you choose.

## FAQ

### What is centralized logging?

Centralized logging collects logs from every server, container and service into one system, adds metadata such as service and environment, and keeps them for a set retention period. You search one place instead of SSHing into each machine.

### Is Loki or Elasticsearch better for container logs?

Loki is cheaper to run because it indexes labels only and stores compressed chunks on object storage. Elasticsearch and OpenSearch are faster for free-text search across long time ranges but need much more memory. Small teams on their own servers usually start with Loki.

### How long should I keep logs?

Seven to thirty days of searchable logs covers most debugging. Keep compressed archives longer only if compliance or audits require it. Decide per environment: staging rarely needs more than a few days.

### Should I log in JSON?

Yes, for anything that goes to a central backend. Structured fields let you filter and aggregate without fragile regexes, and keep messages stable enough to group.

### Do I need a separate logging agent on every server?

In most setups, yes: one collector per node reads local logs and ships them. Platforms that run their own node agent, such as LogiStack, do this for you.

If you want logs labelled and shipped to Loki, Datadog or an OpenTelemetry collector without running your own collectors, [install LogiStack](/#install) and add a drain from the dashboard.

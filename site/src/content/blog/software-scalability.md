---
title: "Software scalability: how to scale apps without rewriting"
description: "A practical guide to software scalability: vertical vs horizontal scaling, finding bottlenecks, stateless design, autoscaling and scaling databases."
date: 2026-11-08
category: Orchestration
keywords: software scalability, horizontal scaling, vertical scaling, autoscaling, scalable architecture, scale web app
---

Traffic doubles after a launch, response times climb from 80 ms to 4 seconds, and the instinct is to rewrite everything as microservices. Usually that's the wrong move. Software scalability is less about architecture diagrams and more about finding the one thing that runs out first, then removing that limit. This guide covers how to measure where you stand, the two directions you can scale, the design rules that let an app run as many copies, how autoscaling decides, and why the database is almost always the last and hardest part.

## What software scalability means

A scalable system keeps its response times and error rates steady as load grows, by adding resources rather than rewriting code. Two words in that sentence matter:

- **Steady.** Scaling isn't about surviving a spike at any latency. It's about holding the same user experience.
- **Adding resources.** If the only way to handle 2x load is a code change, the system isn't scalable at that point; it has a bottleneck.

Load can mean several things, and each stresses a different part of the system:

| Kind of load | Usually stresses |
|---|---|
| More requests per second | CPU of app servers, connection pools |
| More data stored | Database size, query plans, backups |
| More concurrent users | Memory, open connections, websockets |
| Heavier requests (reports, uploads) | CPU spikes, request timeouts, disk I/O |
| More background jobs | Queue workers, database write throughput |

## Measure before you scale

You can't fix a bottleneck you haven't found. Before adding servers, collect:

- **Latency percentiles** (p50, p95, p99) per endpoint. Averages hide the slow requests users complain about.
- **CPU and memory per service**, as a share of its limit.
- **Database metrics**: slow queries, connection count, lock waits.
- **Saturation signals**: queue depth, connection pool waits, request timeouts.

Then load-test to see where the curve bends. A simple test with an open-source tool like k6:

```js
import http from "k6/http";
import { sleep } from "k6";

export const options = {
  stages: [
    { duration: "2m", target: 50 },
    { duration: "5m", target: 200 },
    { duration: "2m", target: 0 },
  ],
};

export default function () {
  http.get("https://staging.example.com/api/products");
  sleep(1);
}
```

Run it against a [staging environment](/blog/staging-environment/), never production. Watch which metric hits its ceiling first. That's your bottleneck.

## Vertical vs horizontal scaling

There are two ways to add capacity.

**Vertical scaling** (scaling up) gives one machine or one container more CPU and memory. **Horizontal scaling** (scaling out) runs more copies and spreads the load across them.

| | Vertical | Horizontal |
|---|---|---|
| How | Bigger server or higher limits | More replicas or servers |
| Code changes | None | App must be stateless |
| Ceiling | The biggest machine you can buy | Very high, limited by shared dependencies |
| Failure tolerance | One machine, one failure point | Lose a replica, keep serving |
| Cost curve | Gets expensive at the top end | Roughly linear |
| Best for | Databases, quick wins | Web apps, APIs, workers |

Start vertical. It's the cheapest change and needs no design work. Move horizontal when you hit the ceiling, when you need redundancy, or when load swings enough that paying for peak capacity all day is wasteful.

## Design rules for horizontal scaling

An app can run as many identical copies only if none of them holds anything the others need.

### Keep app servers stateless

- **Sessions** go in a database or Redis, or in signed cookies, not in process memory.
- **Uploaded files** go to object storage, not the local disk. A file saved on replica A doesn't exist on replica B.
- **Caches** that must be shared go to Redis. Per-process caches are fine if a miss is harmless.

### Make background jobs safe to run twice

With several workers, a job can be picked up twice after a crash or a retry. Design jobs to be idempotent: charging a card should check whether the charge already exists.

### Avoid in-process schedulers

A cron library inside the app runs once per replica. With four replicas, your nightly report sends four emails. Move scheduled work to a single scheduler outside the app.

### Use health checks

New copies must not receive traffic until they're ready, or every scale-up causes a burst of errors. See [zero-downtime deployments](/blog/zero-downtime-deployments/) for how health checks gate traffic.

## Autoscaling: letting the platform decide

Fixed replica counts force a choice: pay for peak capacity all day, or risk falling over at peak. Autoscaling changes the count with the load.

Most autoscalers follow the same loop:

1. **Measure** a metric, usually average CPU per replica as a share of its limit.
2. **Compare** it with a target, such as 60%.
3. **Scale up fast** when load rises, so users don't wait.
4. **Scale down slowly** when load falls, so a short dip doesn't remove capacity you need a minute later.
5. **Hold steady** inside a tolerance band, so the count doesn't flap.

Two guard rails matter more than the algorithm: a **minimum** that keeps enough copies for redundancy even at night, and a **maximum** that caps cost and protects shared dependencies like the database from a runaway scale-up.

### What autoscaling doesn't fix

- **A slow database.** More app copies send more queries to the same database and can make things worse.
- **A single-threaded hot path.** If one request takes 3 seconds of CPU, more replicas only let you serve more slow requests.
- **Stateful services.** Anything with a local volume can't simply be copied.

## Scaling the database

The database is the shared dependency every app replica talks to. It's where most scaling projects end up.

In rough order of effort:

1. **Fix slow queries.** Add indexes, remove N+1 queries. This often buys 10x before anything else.
2. **Pool connections.** Each replica opening 20 connections means 20 replicas open 400. A pooler such as PgBouncer keeps the database's connection count bounded.
3. **Cache hot reads** in Redis.
4. **Scale vertically.** A bigger database server is simple and goes a long way.
5. **Add read replicas** for read-heavy workloads, and send reporting queries there.
6. **Partition or shard** only when a single primary can't keep up with writes. This is a real architecture change.

More on running databases in [database deployment](/blog/database-deployment/).

## Scaling with LogiStack

LogiStack, an open-source self-hosted PaaS on Docker Swarm, covers the vertical, horizontal and automatic parts on your own servers.

### Vertical: resource limits

Under **Settings** › **Resources**, set **CPU** in cores (`0.5` is half a core) and **Memory** in megabytes per replica, or pick a resource profile the organization defines once. Swarm only schedules a replica on a node with that much to spare.

### Horizontal: fixed copies or more servers

Under **Scaling**, **Fixed** sets how many copies always run. When one server runs out of room, add another from **Monitoring** › **Nodes**: a wizard checks it over SSH, installs Docker and joins it to the Swarm. Copies spread across nodes. See [Nodes](/docs/operations/nodes/).

### Automatic: CPU-based autoscaling

Select **Automatic** and a wizard walks you through the setup. It first checks that the service can scale: it needs a CPU limit, no volumes or host paths, and no port published on its node. A health check and more than one server are recommended.

![The Check the service step of the autoscaling wizard, with passing checks and a warning for the missing health check](/docs/screens/autoscale-checks.webp)

You then set a range of 1 to 20 copies and a behavior:

| Behavior | CPU target per copy |
|---|---|
| Balanced | 60% |
| Responsive | 45% |
| Economical | 75% |
| Custom | 10% to 95% |

Before you turn it on, the last step replays the service's last 24 hours with your settings: how many copies it would have run, and each copy's CPU against the target.

How it decides, every 30 seconds:

- **Up, quickly**: when average CPU over the last minute is more than 10% above the target, it adds enough copies to bring each back to the target, at most doubling the count and adding at most 4 per step, with a minute between steps.
- **Down, slowly**: when the last 5 minutes show one copy fewer would still run at or under the target, it removes one, waiting at least 3 minutes after any change.
- **Holds** during a deployment, while a backup has paused the service, and while new copies are still starting.

Each change sends a `service.scaled` event you can route to Slack or email, and lands in the audit log. The same settings are available through the API and in project manifests. Full reference: [Scale a service automatically](/docs/deploy/autoscaling/).

### Limits to know

Autoscaling in LogiStack works on application services. Databases, object storage, game servers and compose stacks keep a fixed number of copies. It scales on CPU through the dashboard; the API also accepts a memory target. There is no scaling on custom metrics such as queue depth, and it doesn't add servers for you: if every node is full, new copies stay pending. Kubernetes with its autoscaling add-ons covers those cases, at the cost of running Kubernetes. See [Docker Swarm vs Kubernetes](/blog/docker-swarm-vs-kubernetes/).

## FAQ

### What is the difference between scalability and performance?

Performance is how fast the system handles one request. Scalability is whether it stays that fast as load grows. A fast app can scale badly if every request hits one shared bottleneck.

### When should I scale horizontally instead of vertically?

When you hit the largest machine you're willing to pay for, when you need redundancy so one failure doesn't take you down, or when load varies enough that autoscaling saves money.

### Do I need microservices to scale?

No. A well-built monolith that is stateless can run as many copies as you need. Microservices help teams work independently; they're not a requirement for handling load.

### Why didn't adding replicas make my app faster?

The bottleneck is elsewhere, most often the database or a slow external API. More replicas send more load to the same constrained dependency. Measure before scaling.

### Can a stateful service autoscale?

Not by simple copying. Services with local volumes would split or share their data. Move files to object storage and state to a database, then the app tier can scale freely.

Software scalability is a habit: measure, find the limit, remove it, repeat. LogiStack gives you resource limits, multi-server Swarm clusters and CPU-based autoscaling with a 24-hour replay, on your own hardware and free. [Install LogiStack](/#install) and try the autoscaling wizard on a staging service.

---
title: "Server monitoring: what to watch and how to alert on it"
description: "A practical guide to server monitoring: the metrics that predict outages, how to collect them, how long to keep them and how to set alerts that matter."
date: 2026-11-08
category: Monitoring
keywords: server monitoring, server health monitoring, linux server monitoring, server metrics, server alerts
---

Most outages announce themselves. A disk fills a few percent a day for weeks. Memory creeps up after each deploy until the kernel starts killing processes. A CPU sits at 95% every evening when a cron job collides with peak traffic. Server monitoring is the habit of recording those signals and acting on them before your users do. This guide covers which server metrics matter, how to collect them, how long to keep them, and how to set alerts that wake you only when something is actually wrong.

## Why server monitoring pays for itself

You can run a server for months without looking at it. The cost shows up later, all at once: a database that stops accepting writes because the volume is full, a site that returns 502 because the app was OOM-killed, a certificate that expired on a Sunday.

Monitoring changes three things:

- **You find problems earlier.** A trend line on a disk chart gives you two weeks of warning. A full disk gives you none.
- **You fix problems faster.** When an incident starts, a chart of the last 24 hours tells you what changed and when. Without it you guess.
- **You size servers with data.** Instead of buying the next plan up "to be safe", you can see that the box peaks at 40% CPU and 70% memory and leave it alone.

## The server metrics that predict trouble

A useful mental model is to check four resources for three things each: how much is used, how saturated it is, and whether it is producing errors.

| Resource | Usage | Saturation | Errors |
| --- | --- | --- | --- |
| CPU | Percent busy, per core and total | Load average above core count, run queue length | Throttling of limited containers |
| Memory | Used vs. total, excluding page cache | Swap activity, memory pressure | OOM kills |
| Disk | Percent of space used, inode usage | I/O wait, queue depth | Read/write errors in `dmesg` |
| Network | Bytes in and out | Dropped packets, connection backlog | Interface errors, TCP retransmits |

Two notes that save a lot of confusion:

- **Free memory is not the right number on Linux.** The kernel uses spare RAM as page cache, so "free" looks low on a healthy box. Watch "available" memory instead, and watch for swap and OOM kills.
- **Inodes run out too.** A disk can show 40% used and still refuse new files because millions of small files (mail queues, session files, build caches) used every inode. Check with `df -i`.

### Uptime and the outside view

Resource metrics tell you how the machine feels. They do not tell you whether users can reach it. Add at least one external check: an HTTP request from outside your network every minute that expects a 200 and a valid certificate. If you self-host, a tool such as Uptime Kuma does this well, but put it on a different server than the ones it watches.

### Logs are the other half

A metric tells you that something changed. A log line tells you why. Keep application and system logs long enough to cover the time between an incident starting and someone looking at it, which in practice means days, not hours.

## Check a server by hand first

Before you install anything, learn what the numbers look like on your own machine. These commands ship with most Linux distributions (`iostat` comes from the `sysstat` package):

```bash
# Load average and uptime
uptime

# Memory: look at the "available" column, not "free"
free -h

# Disk space and inodes per filesystem
df -h
df -i

# CPU, memory, swap and I/O wait, sampled every 2 seconds, 5 times
vmstat 2 5

# Per-device I/O utilization and queue size
iostat -x 2 3

# Kernel messages about OOM kills and disk errors
sudo dmesg --level=err,warn | tail -n 50
```

Running these during a quiet hour and again during peak gives you a baseline. A baseline is what turns "CPU is at 70%" from a scary number into a normal Tuesday.

## How monitoring data is collected

Every monitoring setup answers the same questions: who measures, who sends, and where the data lives.

### Agent-based or agentless

An **agent** is a small process on each server that reads metrics locally and ships them somewhere. It sees everything the kernel exposes, including per-process and per-container figures, and it works through firewalls when it connects outward.

**Agentless** monitoring polls the server remotely over SNMP, SSH or an HTTP endpoint. It is simpler to start with and avoids installing software, but it sees less and usually needs an inbound port.

For Linux servers that run containers, agents win. Container figures live in cgroups on the host, and a remote poller cannot read them cheaply.

### Pull or push

- **Pull**: a central server scrapes each target on an interval. Prometheus works this way. You need every target reachable from the scraper.
- **Push**: each agent sends data to a central endpoint. This suits servers behind NAT or spread across providers, because only outbound traffic is needed.

### Sampling interval and retention

Ten to fifteen seconds is a good default interval for servers. Faster sampling catches short spikes but multiplies storage. Slower sampling hides the spike that caused your 30-second outage.

You rarely need raw 10-second data from three weeks ago. A common approach is to keep raw samples for hours, roll them into 1-minute averages kept for days or weeks, and roll those into 1-hour averages kept for a year. That makes a 30-day chart fast and still lets you compare this month to last year.

## Alerts that are worth waking up for

Bad alerting is worse than none: people learn to ignore it. A few rules keep alerts useful.

1. **Alert on sustained conditions, not samples.** "CPU above 90% averaged over 5 minutes" is a signal. "CPU hit 100% once" is a compile job.
2. **Alert on symptoms first.** A failed deploy, a node that stops reporting, a service that keeps restarting, a backup that failed. These always need a human.
3. **Send a recovery message.** If an alert fires and resolves on its own, you want to know it resolved, so nobody starts investigating a problem that is gone.
4. **Route by urgency.** Disk at 85% belongs in a team chat channel. A server that stopped responding belongs on someone's phone.
5. **Review alerts monthly.** Delete or retune any alert that fired without anyone acting on it.

A starting set of thresholds for a general-purpose server:

| Condition | Window | Where it goes |
| --- | --- | --- |
| Server stops reporting | 30 to 60 seconds | Phone push |
| Disk above 85% | 10 minutes | Team chat |
| Memory above 90% | 5 minutes | Team chat |
| CPU above 90% | 15 minutes | Team chat |
| Deployment or backup failed | Immediately | Team chat |
| Certificate expiring | Daily | Team chat or email |

Tune the numbers after a few weeks of real data. A database server at 85% memory is normal; a web server at 85% might not be.

## Monitoring for small teams vs. large fleets

A company with hundreds of servers usually runs a dedicated stack: Prometheus or a commercial agent, Grafana dashboards, an on-call rotation and runbooks. Our comparison of [server monitoring software](/blog/server-monitoring-software/) walks through those options.

A team with one to ten servers rarely has time to operate a monitoring stack on top of the apps it actually cares about. For that team, the most practical option is monitoring that comes built into the platform that runs the apps, so nothing extra has to be installed, upgraded or backed up.

## How LogiStack handles server monitoring

LogiStack is an open-source, self-hosted PaaS on Docker Swarm, and monitoring is part of it rather than an add-on. An agent runs on every node and reports to the control plane over one outbound WebSocket, so nodes need no extra inbound port for monitoring.

![The LogiStack Monitoring overview with cluster CPU, memory, disk and network charts](/docs/screens/monitoring.webp)

What you get without any setup, as described in the [metrics docs](/docs/operations/metrics/):

- **Host metrics** for every node: CPU, memory, disk and network, sampled every 10 seconds.
- **Container metrics** per service: CPU, memory against its limit, network, block I/O and how many replicas are reporting.
- **Tiered retention**: raw samples, 1-minute rollups and 1-hour rollups, each with a retention you set. You can keep hourly data for years.
- **Ranges** from 1 hour to 30 days, for the cluster, one node or one service.

Alerting follows the rules above. Node thresholds fire when the average CPU, memory or disk over a window from 1 minute to 1 hour crosses your limit, and fire again when it falls back. A built-in node-down alert fires when an agent misses heartbeats for 30 seconds. Events for failed deployments, crash loops, failed backups and expiring certificates come on top. Rules route each event to Slack, Discord, email, Telegram, Teams, Mattermost, ntfy, Gotify, Pushover or a signed webhook. See [alerts and notifications](/docs/operations/alerts-and-notifications/).

When you need more, LogiStack sends logs out to tools you already use. [Log drains](/docs/operations/log-drains/) ship every service's output to Grafana Loki, an OpenTelemetry collector, Datadog, syslog or any HTTP endpoint, labelled by project, environment, service and node.

The honest limits: LogiStack charts infrastructure and container resources. It is not an APM tool and does not collect traces or your application's custom metrics. If you need those, run Prometheus or an OpenTelemetry backend next to it (there are templates for both in the [template catalog](/templates/)).

## FAQ

### What is the difference between server monitoring and application monitoring?

Server monitoring watches the machine: CPU, memory, disk, network and whether the host is up. Application monitoring watches your code: request latency, error rates, slow database queries and traces. You need server monitoring first, because an application cannot be healthy on a server that is out of memory.

### How often should server metrics be collected?

Every 10 to 15 seconds suits most servers. It catches short spikes without producing excessive data. Keep raw samples for a few hours and roll them up into 1-minute and 1-hour averages for longer ranges.

### Which server metric should I alert on first?

Start with "the server stopped reporting" and "disk above 85%". The first catches crashes and network failures. The second catches the most common slow-building outage on small servers, and it gives you days to react.

### Do I need a separate server for monitoring?

For uptime checks, yes: a probe on the same machine cannot tell you that machine is unreachable. For resource metrics, a platform that collects them on the cluster itself is fine, as long as alerts for a node going silent come from somewhere else in the cluster.

If you want host and container metrics, alerts and log shipping without building a monitoring stack first, [install LogiStack](/#install) on a server and open the Monitoring page: the charts start with the first agent report, about a minute after install. The [features page](/features/) lists everything else that comes in the same install.

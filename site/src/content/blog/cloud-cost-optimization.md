---
title: "Cloud cost optimization: 12 ways to cut your bill"
description: "A practical cloud cost optimization guide: find where the money goes, right-size, kill idle resources, cut egress and decide when to self-host."
date: 2026-11-08
category: Self-hosting
keywords: cloud cost optimization, reduce cloud costs, cloud bill, finops, aws cost reduction, self-hosting costs
---

The cloud bill grew 40% this year and traffic grew 10%. Nobody added anything big. A staging cluster here, a forgotten load balancer there, a log index that keeps every debug line for a year. Cloud cost optimization is mostly the work of finding those small leaks and closing them before they compound.

This guide is for engineering teams that run their own workloads on AWS, Google Cloud, Azure or a PaaS on top of them. It starts with measurement, moves through the changes that usually pay back fastest, and ends with the larger question: when does it make sense to move some workloads to servers you rent at a flat price?

## Why cloud bills grow faster than usage

Cloud pricing is metered on many axes at once. You pay for compute by the second, storage by the gigabyte-month, requests by the million, data transfer by the gigabyte, and managed services by their own units. Each meter is small. Together they make a bill that is hard to predict and easy to ignore.

Three patterns drive most of the waste:

- **Provisioning for the peak and never coming back.** An instance sized for launch week keeps running at 8% CPU for two years.
- **Things nobody owns.** Snapshots, unattached volumes, old load balancers, idle NAT gateways and test databases outlive the projects that created them.
- **Convenience pricing.** Managed services, cross-zone traffic and egress are priced well above their raw cost. They are worth it for some workloads and pure overhead for others.

None of these is a scandal. They are the normal result of teams moving fast. The fix is a habit, not a one-off project.

## Step 1: find out where the money goes

You cannot optimize a number you cannot break down. Before you change anything, make the bill readable.

1. **Tag everything.** Every resource gets at least `team`, `service` and `environment` tags. Enforce it with a policy so untagged resources fail to create.
2. **Turn on the cost tools you already pay for.** AWS Cost Explorer and the Cost and Usage Report, Google Cloud billing export to BigQuery, Azure Cost Management. They are included in your account.
3. **Group by service and environment.** The first useful chart is "cost per environment per month". Staging and preview environments are often a third of the total.
4. **Rank the top ten line items.** In most accounts, ten line items make up 80% of the bill. Work on those first.
5. **Set budgets and alerts.** A budget alert at 80% of forecast catches a runaway job in days, not at the end of the month.

If you run on a self-hosted platform, the same idea applies to capacity instead of dollars. LogiStack's [Usage page](/docs/operations/usage/) adds up average CPU, memory, network and volume size per project, environment and service, and compares the total to your cluster's capacity. It answers "which project fills this server" before you buy another one.

![The organization Usage page with CPU, memory, network and volume tiles and a table of projects](/docs/screens/monitoring-usage.webp)

## Step 2: the changes that pay back fastest

These are ordered roughly by effort against savings. Most teams find enough in the first five.

### 1. Delete what nobody uses

Start with the boring list: unattached block volumes, snapshots older than your retention policy, idle load balancers, elastic IPs not bound to anything, stopped instances with large disks, and old container images in the registry. A weekly report of resources with no traffic for 30 days, sent to each owning team, removes most of it.

### 2. Right-size compute

Pull 30 days of CPU and memory for every instance or container. Anything that never passes 30% of its CPU and 50% of its memory is a candidate to drop one size. Memory is usually the real constraint, so size on memory and treat CPU as a check.

### 3. Turn off non-production at night

Staging, QA and preview environments rarely need to run on weekends or at 3 a.m. Scheduling them off for 12 hours a day and all weekend cuts their cost by more than half. Short-lived preview environments that disappear when a pull request merges are cheaper still; see [preview environments](/blog/preview-environments/).

### 4. Scale on load, not on hope

A web app that needs six copies at noon and two at midnight should not run six all day. Horizontal autoscaling on CPU or request rate pays for itself on any workload with a daily curve. Set a sensible minimum for availability and a maximum that caps the worst case. [Software scalability](/blog/software-scalability/) covers how to make a service safe to scale out.

### 5. Commit to the baseline

Once you know your steady floor, buy it at a discount. Reserved instances, savings plans and committed use discounts trade flexibility for a lower rate. Commit only to what you are sure you will run for the whole term, and keep spikes on demand.

### 6. Use spot or preemptible capacity for interruptible work

CI runners, batch jobs, rendering and data pipelines can usually survive an interruption. Spot capacity is a fraction of the on-demand price. Do not run your only database replica on it.

### 7. Watch data transfer

Egress is the line item that surprises people most. Traffic leaving the cloud, crossing regions, and often crossing availability zones is billed per gigabyte. Common fixes:

- Put a CDN in front of static assets and downloads.
- Keep chatty services in the same zone when your availability design allows it.
- Compress API responses.
- Move large public downloads to storage with cheap or free egress.

### 8. Tier your storage

Object storage has hot, cool and archive classes with very different prices. Lifecycle rules can move old objects down a tier automatically. Backups older than 30 days rarely need hot storage.

### 9. Cut log and metrics retention

Observability bills scale with volume. Drop debug logs in production, sample high-volume traces, and keep detailed logs for 7 to 14 days with longer retention only for audit data. Ask each team which dashboards they actually opened last month.

### 10. Consolidate small databases

Ten managed database instances at the smallest size often cost more than one larger instance holding ten databases. Separate instances make sense for isolation and noisy workloads. For small internal apps they are often habit.

### 11. Question every managed service at small scale

Managed queues, caches, search and databases save real work. At small scale, though, their minimum price can be many times the cost of running the same open-source software on a VM you already pay for. Decide service by service. Keep managed where the operational burden is real; run it yourself where the software is simple and the data is easy to back up.

### 12. Make cost part of code review

Add estimated monthly cost to infrastructure pull requests. Tools exist that read Terraform plans and post a cost diff. Engineers make better choices when they see the number at the moment they decide.

## Quick reference: savings by technique

| Technique | Typical effort | Where it helps most | Risk |
| --- | --- | --- | --- |
| Delete idle resources | Low | Every account | Deleting something still needed: snapshot first |
| Right-size compute | Low to medium | Over-provisioned VMs and containers | Too small under peak: watch for a week |
| Schedule non-prod off | Low | Staging, QA, previews | Someone needs it at night: allow manual start |
| Autoscaling | Medium | Web apps with daily curves | Slow scale-up: keep a sane minimum |
| Commitments | Low | Stable baseline | Paying for capacity you stop using |
| Spot capacity | Medium | CI, batch, stateless workers | Interruptions |
| Egress fixes | Medium | Media, downloads, multi-region | CDN misconfiguration |
| Storage tiers | Low | Backups, archives | Retrieval fees from cold tiers |
| Log retention | Low | High-volume services | Losing data you need for an incident |
| Self-host steady workloads | High | Predictable, always-on services | You own operations |

## Step 3: when the bigger lever is a different model

After the easy fixes, many teams find a stubborn floor: services that run all day, every day, at a steady load. Metered pricing is designed for elastic workloads. For a workload that never scales down, you pay the elastic premium for elasticity you do not use.

That is where flat-priced servers enter the picture. A dedicated server or a large VPS from a European or US provider costs a fixed monthly amount for CPU, memory, disk and usually a generous traffic allowance. For steady services, the difference against the same capacity on a hyperscaler is often large.

The trade-off is operations. On a flat-priced server you own the operating system, patches, backups and failover. A self-hosted platform takes over much of the daily work:

- Builds from Git and rolling deploys with health checks.
- HTTPS certificates issued and renewed automatically.
- Managed databases with scheduled, encrypted [backups](/docs/data/backups/) to S3-compatible storage.
- Logs, metrics and alerts per service.

You still patch the OS, size the servers and test restores. The [Heroku vs self-hosted](/blog/heroku-vs-self-hosted/) comparison walks through that work honestly, and [cloud repatriation](/blog/cloud-repatriation/) covers how companies decide which workloads to move.

### A simple test for each workload

Ask four questions about each service:

1. **Is the load steady?** If it runs at a similar level all month, flat pricing fits.
2. **Is it stateless, or is its state easy to back up?** Web apps, APIs and workers with a Postgres database are straightforward. Large distributed data systems are not.
3. **Does it lean on a managed service with no good self-hosted equivalent?** If yes, leave it where it is.
4. **Does your team have someone who can own a Linux server?** If nobody does, the savings disappear into incidents.

Two or more "yes" answers to the first three, and a "yes" to the fourth, make a workload a good candidate to move.

## Build a cost habit, not a cost project

A one-time cleanup decays within a year. What keeps costs down is a small routine:

- **Monthly:** review the top ten line items and the cost per environment. Look for anything that grew faster than traffic.
- **Quarterly:** re-run the right-sizing report and review commitments before they renew.
- **Per change:** show the cost diff in infrastructure pull requests.
- **Per team:** give each team its own cost view, so the people who can fix a line item see it.

Assign one owner for the overall bill. FinOps works when engineering and finance look at the same numbers, but it fails when everyone is responsible and nobody is accountable.

## FAQ

### What is the fastest way to reduce cloud costs?

Delete idle resources and right-size over-provisioned instances. Both need no architecture change and can be done in a week. Together they often remove a noticeable share of the bill in accounts that have never been cleaned up.

### Are reserved instances and savings plans worth it?

Yes, for the part of your usage that you are certain will run for the whole term. Commit to your steady baseline and keep variable load on demand. Over-committing turns a discount into a bill for capacity you no longer use.

### Is self-hosting always cheaper than the cloud?

No. For steady, always-on workloads, flat-priced servers are usually cheaper on infrastructure. For spiky or rarely used workloads, metered pricing can win. Your team's time also counts: if nobody can own the servers, the cloud's premium is buying you real work.

### How do I track costs on a self-hosted platform?

Track capacity per project instead of dollars per resource. Measure average CPU, memory and storage per project, and divide your server bill by that share. LogiStack shows these figures per project, environment and service on its Usage page and through its API.

If some of your services have a steady load and a simple stack, try moving one of them to a flat-priced server. LogiStack is open source, installs with [one command](/#install), and gives you Git deploys, managed databases, backups and per-project usage on hardware you choose. Every feature is in the free build.

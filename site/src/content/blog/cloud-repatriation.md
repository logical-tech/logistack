---
title: "Cloud repatriation: when to leave the hyperscalers"
description: "Cloud repatriation explained: why teams move workloads off AWS, Azure and Google Cloud, which ones to move, what it costs, and how to plan the move."
date: 2026-11-08
category: Self-hosting
keywords: cloud repatriation, leaving the cloud, cloud exit, move off aws, on-premises, hybrid cloud
---

Your cloud bill has stopped tracking your growth. Usage is steady, the product is mature, and yet every quarter the invoice from AWS, Azure or Google Cloud is a bigger share of revenue. Someone on the team asks the question out loud: what would this cost on our own servers? Cloud repatriation is the name for acting on that question, moving some or all workloads off a hyperscaler to rented, colocated or owned hardware.

This guide explains why teams repatriate, which public cases are worth knowing, how to decide which workloads should move, and how to run the move without a risky big-bang cutover.

## What cloud repatriation is, and what it is not

Repatriation means running a workload on infrastructure you control more directly, after it ran on a public cloud. The destination can be:

- **Rented dedicated servers** or large VPS instances from a hosting provider, at a flat monthly price.
- **Colocation**, where you own the hardware and rent rack space, power and network.
- **Your own data center**, which only makes sense at large scale.

It is rarely all or nothing. Most teams that repatriate keep some services in the cloud: global CDNs, managed email, identity, or a specialised managed database. The usual end state is hybrid. You move the steady, predictable core and keep the parts where the cloud's elasticity or managed services earn their price.

It is also not a statement that the cloud was a mistake. The cloud is excellent for starting fast, handling unknown demand and getting managed services without hiring for them. Repatriation is what happens when a workload's needs change: the demand became known, and paying for elasticity no longer makes sense.

## Why teams repatriate

### Cost at steady state

Hyperscaler pricing is built for elastic demand. You pay per second, per request and per gigabyte, with a premium for the ability to scale up and down at any time. A workload that runs at the same level all month pays that premium without using it. Flat-priced hardware turns that steady load into a fixed monthly cost.

In 2021, Andreessen Horowitz published an essay called "The Cost of Cloud, a Trillion Dollar Paradox", arguing that for mature software companies, cloud spend can weigh heavily on margins. The essay made repatriation a boardroom topic rather than an ops-team grumble.

### Predictability

Metered pricing makes forecasting hard. A new feature that triples log volume, or a customer that downloads ten times more data, shows up on next month's invoice. Fixed capacity has the opposite failure mode, since you can run out, but its cost is known in advance.

### Data location and sovereignty

Some teams need data in a specific country, under a provider that is not subject to another country's laws. European companies in particular weigh this. Renting servers from a local provider, or owning them, makes the answer simple. [Choosing a VPS in Europe](/blog/choosing-a-vps-in-europe/) covers the provider side.

### Performance per dollar

Modern dedicated servers pack many cores, a lot of memory and fast NVMe drives. For CPU-bound or disk-bound workloads, the same money often buys far more raw performance on dedicated hardware than on virtualised cloud instances with networked storage.

### Lock-in and egress

Moving data out of a hyperscaler costs money per gigabyte, and proprietary services make code harder to move. Teams that want the option to change providers sometimes repatriate to regain it. In 2024, AWS, Google Cloud and Microsoft Azure each announced ways to waive egress fees for customers moving data out when they leave, with conditions. Read the current terms before you plan around it.

## Public cases worth knowing

Two well-documented examples show the range.

**37signals**, the company behind Basecamp and HEY, announced in late 2022 that it was leaving the cloud. It reported that its 2022 cloud bill was about $3.2 million. It bought its own servers and moved its applications to them through 2023, projecting savings of around $7 million over five years, a figure it later revised upward to more than $10 million. The company also built and open-sourced Kamal, a deployment tool for running containers on plain servers, out of that work. It then announced plans to move its file storage off Amazon S3 too.

**Dropbox** moved most of its user file storage off AWS to its own infrastructure, a project it called Magic Pocket, in the mid-2010s. Its 2018 IPO filing credited infrastructure optimization, largely that move, with saving roughly $75 million over two years.

What these cases have in common: large, steady workloads, strong in-house operations skills, and the patience to move in stages. What they do not prove: that every company saves money by leaving. A team of five with spiky traffic and no operations experience is in a very different position.

## Which workloads to move first

Rank each workload on four questions.

| Question | Good candidate | Poor candidate |
| --- | --- | --- |
| How steady is the load? | Similar all month | Spikes 10x for hours or days |
| How much managed glue does it use? | A container and a Postgres database | Many proprietary services wired together |
| How heavy is the data? | Gigabytes to a few terabytes, easy to back up | Petabytes, or replication you cannot rebuild |
| Who will operate it? | Someone who can own Linux servers | Nobody |

Good first candidates are usually:

- Web apps and APIs that run all day at a steady load.
- Background workers and queue consumers.
- CI runners and build machines.
- Internal tools and admin dashboards.
- Staging and preview environments, which often cost a lot for what they do.

Leave for later, or never:

- Workloads with sharp, unpredictable spikes.
- Systems that rely on a managed service with no reasonable self-hosted equivalent.
- Anything where the migration risk outweighs a modest saving.

## The real cost model

Comparing an AWS invoice to a server's monthly price is the most common mistake. Build the full picture:

**On the cloud side:** compute, storage, managed services, data transfer, support plan, and the discounts you already have through commitments.

**On the repatriated side:**

- Servers, at your expected size plus headroom for failover and growth.
- Off-site backup storage, usually S3-compatible object storage in another location.
- Network: bandwidth beyond the included allowance, and a CDN if you serve heavy static content.
- People: hours per month for patching, monitoring, capacity planning and incidents.
- The migration itself: engineering weeks, a period of running both, and the risk of delay.

If you own hardware, add depreciation, spare parts and colocation fees. Rented dedicated servers move hardware failure onto the provider, which is why most small and mid-sized teams start there.

[Cloud cost optimization](/blog/cloud-cost-optimization/) covers the cheaper fixes to try first. If right-sizing and commitments close most of the gap, you may not need to move at all.

## What you need to replace

Every managed service you rely on needs a counterpart, or a decision to keep it in the cloud.

| Cloud service | Repatriated counterpart |
| --- | --- |
| Managed Kubernetes or container service | Docker Swarm, Kubernetes, or a self-hosted PaaS on top of either |
| Load balancer and certificates | A reverse proxy such as Caddy with automatic HTTPS |
| Managed Postgres or MySQL | Database containers or VMs with scheduled backups and restore tests |
| Object storage | Self-hosted S3-compatible storage, or a third-party S3 provider |
| CI/CD | Git-triggered builds on your servers, or your existing CI pushing images |
| Secrets manager | Encrypted variables in your platform, or Vault |
| Metrics and logs | Platform metrics, plus Prometheus, Grafana or Loki for depth |

A self-hosted PaaS bundles several rows. LogiStack, for example, runs on Docker Swarm with Caddy, builds from Git, runs Postgres, MySQL, MariaDB, MongoDB, Redis and libSQL with scheduled encrypted backups, and hosts S3-compatible storage. Its trade-offs are worth stating: it is a young project with a smaller community than Kubernetes tooling, and it uses Swarm, which is simpler than Kubernetes but has fewer extension points. [Docker Swarm vs Kubernetes](/blog/docker-swarm-vs-kubernetes/) explains where each fits.

## How to run the move

### 1. Inventory and measure

List every service, its dependencies, its data size and its 30-day resource use. You will size servers from this, so use real numbers.

### 2. Build the target and prove it

Set up the new environment with your platform, networking, backups and monitoring before any production traffic arrives. Restore a production backup into it. A platform that can add servers over SSH and pin stateful services to the node holding their data makes this stage faster; see [Nodes](/docs/operations/nodes/).

### 3. Move a low-risk workload first

Pick an internal tool or a stateless worker. Run it for two weeks. Learn where your runbooks are missing.

### 4. Move the data carefully

For databases, use a replica or a dump-and-restore with a short write freeze. Measure how long a full restore takes, because that is your real recovery time. [Database migration](/blog/database-migration/) covers the patterns.

### 5. Cut over with DNS, keep a way back

Lower DNS TTLs a day before. Switch, watch error rates, and keep the cloud copy available, scaled down, until you are confident. Only then decommission it.

### 6. Repeat, and stop when it no longer pays

Move workloads in order of savings against risk. It is fine to stop halfway. Many teams end with a hybrid that keeps the cloud for what it does best.

## FAQ

### Is cloud repatriation a trend or a niche?

It is a real but selective movement. Companies with large, steady workloads and strong operations teams have published meaningful savings. Most organisations end up hybrid, moving some workloads and keeping others in the cloud rather than leaving entirely.

### Do I need to buy hardware to repatriate?

No. Rented dedicated servers and large VPS instances give most of the cost benefit without owning hardware, and the provider replaces failed parts. Owning hardware in colocation only pays off at a scale where you can staff for it.

### How long does a repatriation take?

For a small team moving a few services, weeks. For a large company with many services and data stores, months to a year or more, done in stages. Running both environments in parallel for a while is normal and should be in the budget.

### What is the biggest risk?

Underestimating operations. On the cloud, someone else handles hardware failures, networking and many managed services. After repatriation, you need backups that you have tested, monitoring that pages someone, and a plan for a dead server.

If you are weighing a move, start with one steady workload on one rented server and measure what it really costs. LogiStack is free and open source, installs with [one command](/#install), and gives you Git deploys, managed databases and [backups](/docs/data/backups/) on hardware you choose. For a broader view of the options between fully managed and fully self-run, read [BYOC vs self-hosting vs managed](/blog/byoc-vs-self-hosting-vs-managed/).

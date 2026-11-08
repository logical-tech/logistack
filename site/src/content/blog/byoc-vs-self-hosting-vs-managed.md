---
title: "BYOC vs self-hosting vs managed: who runs what"
description: "BYOC vs self-hosting vs managed platforms compared on control, data location, cost, operations and lock-in, with a table and a way to choose."
date: 2026-11-08
category: Comparisons
keywords: byoc vs self-hosting, bring your own cloud, byoc, self-hosted vs managed, deployment models, managed platform
---

You have picked the stack. Now you have to decide where it runs and who keeps it running. A vendor's cloud, where you only push code? Your own cloud account, with a vendor driving it? Or your own servers, with software you operate yourself? BYOC vs self-hosting vs managed is the decision behind that question, and it shapes your bill, your compliance story and how many pages your team gets at night.

This guide defines each model in plain terms, compares them side by side, and gives you a way to choose for each workload rather than once for the whole company.

## The three models in one paragraph each

**Managed (fully hosted).** The vendor runs everything in its own infrastructure: the control plane that takes your deploys, and the data plane where your code and data run. You get an account and a bill. Heroku, Vercel, Render, Railway and managed databases such as Amazon RDS all work this way, though RDS sits in your cloud provider rather than a separate vendor.

**BYOC (bring your own cloud).** The vendor runs the control plane. The data plane, meaning the machines that run your workloads and store your data, lives in your own cloud account: your AWS, Google Cloud or Azure subscription. The vendor gets scoped access to deploy and manage it. Databricks has long worked this way for compute, Redpanda sells a BYOC edition of its streaming platform, and several application platforms deploy into your AWS or GCP account.

**Self-hosting.** You run both planes. You install the software on servers you rent or own, and you operate it. Open-source platforms such as LogiStack, Coolify, Dokku and plain Kubernetes fall here, as does any open-source database you run yourself.

## The planes explained

The split between control plane and data plane is what separates these models, so it is worth being precise.

- **Control plane:** the API and dashboard you deploy through, the scheduler, the build system, the state of what should run where. If it goes down, you cannot deploy, but running workloads usually keep serving.
- **Data plane:** the servers, containers, databases and disks that serve your users and hold your data. If it goes down, you are down.

Managed puts both with the vendor. BYOC puts the data plane with you and the control plane with the vendor. Self-hosting puts both with you.

## Side-by-side comparison

| | Managed | BYOC | Self-hosting |
| --- | --- | --- | --- |
| Control plane | Vendor | Vendor | You |
| Data plane | Vendor's infrastructure | Your cloud account | Your servers, any provider |
| Where data lives | Vendor's regions | Your account and region | Wherever you put it |
| Infrastructure bill | Bundled in vendor price | Paid to your cloud provider | Paid to your hosting provider |
| Software bill | Vendor price | Vendor fee on top of infrastructure | None for open source |
| Who patches the OS and runtime | Vendor | Usually vendor, through its access | You |
| Vendor outage | Can take you down | Usually blocks deploys, not traffic | Not applicable |
| Access the vendor needs | Your code and data | A role in your cloud account | None |
| Uses existing cloud commitments | No | Yes | Only if you self-host in that cloud |
| Time to first deploy | Minutes | Hours, mostly account setup | An hour or more, including servers |
| Exit cost | Rebuild elsewhere | Lower: infrastructure is already yours | Lowest |

## Managed: pay to not think about it

Managed platforms win on time. Nobody on your team touches a server. Scaling, certificates, patching, and often databases and backups come with the product.

**Choose managed when:**

- Your team is small and every hour on infrastructure is an hour off the product.
- The bill is a small share of revenue.
- You have no hard requirement on data location or vendor access.
- You want a support contract with an SLA.

**Watch for:**

- Cost that grows with each process, add-on or seat, often faster than your traffic.
- Platform-specific features that make leaving harder.
- Limits you cannot change, such as filesystem behaviour, timeouts or regions.

[Heroku vs self-hosted](/blog/heroku-vs-self-hosted/) walks through this trade-off for one well-known platform, and [best PaaS providers](/blog/best-paas-providers/) compares the hosted options.

## BYOC: the middle path

BYOC grew because enterprises wanted the vendor's experience without the vendor holding their data. The data stays in an account your security team already governs, under your cloud contract, with your encryption keys and network rules. Spend counts toward commitments you have already negotiated with your cloud provider.

**Choose BYOC when:**

- Security or compliance requires data to stay in your own cloud account.
- You have large committed spend with a cloud provider and want to use it.
- You want a vendor to operate the software, but not to host it.

**Watch for:**

- Two bills: your cloud provider's, and the vendor's fee on top. Together they can exceed a fully managed price.
- Access: the vendor needs a role in your account. Review exactly what it can do, and how that access is audited.
- Shared responsibility that is less clear than either extreme. When something breaks, it can take time to agree whose side the problem is on.
- You still pay hyperscaler prices for compute, storage and egress, so BYOC does not solve a cost problem on its own.

## Self-hosting: everything is yours

Self-hosting gives you the most control and, for steady workloads, usually the lowest infrastructure cost. You choose the provider, the country, the hardware and the software versions. Nobody else has access unless you grant it.

**Choose self-hosting when:**

- Workloads are steady and you want a flat, predictable bill.
- You need data in a specific place or under a specific jurisdiction, including your own hardware.
- You want no vendor in the path of your deploys or your data.
- Someone on your team can own Linux servers.

**Watch for:**

- Operations are yours: OS updates, firewall rules, disk space, backups you have tested, and platform upgrades.
- No vendor support unless you buy it.
- You have to plan for hardware failure yourself, usually with more than one server and off-site backups.

A self-hosted PaaS narrows the operations gap. LogiStack, for example, gives you Git deploys with rolling updates, automatic HTTPS through Caddy, managed databases with scheduled encrypted backups and restore checks, and logs, metrics and alerts, all in the open-source build under Apache 2.0. Its control plane runs as one Docker Swarm stack on your own servers, and each node runs an agent that dials back over one outbound connection. See [the architecture reference](/docs/reference/architecture/) for how the pieces fit. Honest trade-offs: it is a young project, it runs on Docker Swarm rather than Kubernetes, and its community is smaller than older tools. [Self-hosted PaaS](/blog/self-hosted-paas/) compares the options in this category.

## Cost: how each model is priced

The models differ more in the shape of the bill than in any single number.

- **Managed:** a per-unit price that bundles infrastructure, software and operations. Easy to start, grows with every unit.
- **BYOC:** hyperscaler infrastructure prices plus a vendor fee, often a percentage of usage or a per-cluster price.
- **Self-hosting:** flat server prices plus your team's time. Grows in steps when you add a server.

For a fair comparison, add your own hours to the self-hosting line and the vendor's fee to the BYOC line. Then compare at your current size and at three times your current size, because the models diverge as you grow. [Cloud cost optimization](/blog/cloud-cost-optimization/) has a checklist for reading your current bill.

## Security and compliance

None of the three is automatically more secure. They put the responsibility in different places.

- **Managed:** you rely on the vendor's controls and certifications. Your auditors review the vendor's reports.
- **BYOC:** data stays in your account, but a vendor has privileged access to it. Your auditors review both your cloud setup and the vendor's access model.
- **Self-hosting:** you hold every control. You also own every gap. Single sign-on, role-based access, an audit log and encrypted secrets matter more here because nobody else is providing them.

## How to choose, per workload

You do not have to pick one model for everything. A common pattern:

| Workload | Often best fit |
| --- | --- |
| Marketing site, docs | Managed static hosting, or a static site on your own server |
| Core web app and API with steady load | Self-hosting |
| Primary database at moderate size | Self-hosting with tested backups, or managed if nobody can own it |
| Data platform that must stay in your cloud account | BYOC |
| Email delivery, payments, identity | Managed (specialist vendors) |
| Internal tools and admin panels | Self-hosting, behind access rules or a private network |
| Preview and staging environments | Self-hosting, where idle copies are cheap |

Ask these questions for each workload:

1. Does the data have to stay in a specific place or account?
2. Is the load steady or spiky?
3. Who will be paged when it breaks?
4. What does leaving cost in two years if the vendor changes its prices?

[Managed vs self-hosted Postgres](/blog/managed-vs-self-hosted-postgres/) applies this thinking to databases specifically.

## FAQ

### What does BYOC stand for?

Bring your own cloud. The vendor's software runs in your cloud account instead of the vendor's, while the vendor still operates it through a control plane it hosts. Your data stays in infrastructure you own and govern.

### Is BYOC the same as self-hosting?

No. With BYOC, the vendor still operates the software and controls deploys through its own control plane. With self-hosting, you install and run everything, and no vendor has access to your infrastructure.

### Is BYOC cheaper than a managed platform?

Not necessarily. You pay your cloud provider for infrastructure and the vendor for its service. It can be cheaper if you have large committed cloud spend, but it rarely beats self-hosting on flat-priced servers for steady workloads.

### Can I combine the models?

Yes, and most teams do. Keep specialist services managed, keep regulated data in your own account, and self-host steady application workloads where flat pricing wins. Decide per workload, not per company.

If self-hosting fits some of your workloads, LogiStack is a straightforward place to start: open source, every feature in the free build, and a [one-command install](/#install) on any Linux server with Docker Swarm set up for you.

---
title: "Self-hosted PaaS: what it is and when it beats managed"
description: "A self-hosted PaaS gives you git-push deploys on your own servers. Learn when it beats managed PaaS, what it costs you, and what to look for."
date: 2026-11-08
category: Self-hosting
keywords: self-hosted paas, self hosted heroku, open source paas, paas on your own server, self-hosted deployment platform
---

Your managed platform bill went up again. Or a customer asked where their data lives and the honest answer was "in a region we picked from a dropdown". Or you have three VPS boxes running apps you deployed by hand two years ago and nobody remembers how. A self-hosted PaaS answers all three: the git-push workflow of Heroku or Render, running on servers you rent or own.

This guide covers what a self-hosted PaaS is, how it works, when it is the better choice, when it is not, and the checklist to use when you compare options.

## What is a self-hosted PaaS?

A self-hosted PaaS is platform software you install on your own Linux servers. After install, it behaves like a hosted platform: you connect a repository, push code, and it builds an image, starts containers, routes a domain with HTTPS, and keeps logs and metrics. The difference is ownership. The servers, the data and the bill are yours.

Most self-hosted platforms share an architecture:

- **A container runtime**, usually Docker, sometimes with Docker Swarm or Kubernetes to spread work across machines.
- **A reverse proxy** such as Caddy or Traefik that terminates TLS and routes hostnames to containers.
- **A builder** such as BuildKit, buildpacks or Railpack that turns source into images.
- **A control plane**: a web dashboard, an API and a database that records what should run.

If you want the basics of the PaaS model first, start with [what is PaaS](/blog/what-is-paas/).

## Why teams move to a self-hosted PaaS

### Predictable cost

A managed platform bills per instance, memory tier, seat or bandwidth. A self-hosted one runs on a server you pay for by the month. A 4 vCPU, 8 GB VPS from a European provider can host a dozen small apps and their databases. On a managed platform, each of those apps and databases is often its own line item.

The trade is your time. Count it honestly: install, an update every few weeks, a look at disk space and backups. For most small teams that is an hour or two a month once things are set up.

### Data residency and control

You choose the provider, the country and the hardware. That matters for GDPR, for customer contracts that name a jurisdiction, and for teams that simply prefer not to send data to another vendor. If you are picking a provider, compare price, location and network quality before features.

### No per-app friction

When every new app costs money, people stop deploying internal tools, prototypes and staging copies. On your own server the marginal cost of one more small service is close to zero, so preview environments for every pull request become normal.

### Exit options

A self-hosted platform that builds from standard Dockerfiles and runs standard containers leaves you free to move. If the platform disappears, your images and compose files still run.

## When a managed PaaS is still the better choice

Self-hosting is not the right answer for everyone. Choose a managed platform when:

- **Nobody on the team wants to be on call for a server.** If disk full alerts at night are unacceptable, pay someone else.
- **You need many regions on day one.** Global edge platforms place your app close to users on several continents. Replicating that yourself takes real work.
- **Your spend is small.** If the managed bill is lower than an hour of your time per month, the math does not favor self-hosting yet.
- **Compliance requires certifications you cannot produce.** A provider with SOC 2 or ISO 27001 reports can hand those to auditors. With self-hosting, your own processes and your server provider's certifications carry that weight.

We compare the two models side by side in [Heroku vs self-hosted](/blog/heroku-vs-self-hosted/).

## Managed vs self-hosted PaaS at a glance

| Aspect | Managed PaaS | Self-hosted PaaS |
| --- | --- | --- |
| Setup time | Minutes | Minutes to an hour, plus DNS |
| Cost model | Per app, instance, seat or usage | Flat server cost |
| Data location | Provider's regions | Your choice of provider and country |
| Platform updates | Automatic | You trigger them |
| Server patching | Provider | You, or an unattended-upgrades setup |
| Outage response | Status page and wait | You investigate with full access |
| Scaling | Slider or autoscaling | Add nodes, or scale replicas on existing ones |
| Lock-in | Often high | Low if it uses standard containers |

## What to look for in a self-hosted PaaS

Most platforms demo well on day one. The checklist below is about day 300.

### 1. How it applies changes

Ask what happens when the server reboots in the middle of a deploy. A platform that stores the desired state in a database and reconciles Docker toward it can finish the job on the next pass. One that runs a sequence of shell commands may leave a half-updated service. Also check whether it only touches objects it created, so containers you run by hand are safe.

### 2. Rollbacks that do not rebuild

The safest rollback runs the exact image that was live before. That requires immutable tags per deployment, not a moving `:latest`. If a rollback means rebuilding an old commit, a changed base image or dependency can break it.

### 3. Backups you have restored

Look for scheduled database and volume backups to S3-compatible storage, encryption before upload, retention rules, and ideally a scheduled restore test. A backup you never restored is a hope, not a backup. See [database backup](/blog/database-backup/) for the full routine.

### 4. HTTPS that survives growth

Automatic Let's Encrypt is table stakes. Check how the platform handles wildcard certificates and DNS-01 challenges, and what it does for generated hostnames. Services such as sslip.io are not on the Public Suffix List, so every user shares one Let's Encrypt budget of 50 certificates per registered domain per week. A platform that recommends a wildcard on your own domain avoids that trap. More in [Let's Encrypt rate limits](/blog/lets-encrypt-rate-limits/).

### 5. More than one server

Your first server will fill up. Check whether you can add a node from the dashboard, whether builds and databases can live on separate machines, and what the multi-node story needs (a registry, private networking, open ports).

### 6. Teams and access

If anyone other than you will use it, you need roles, scoped grants, SSO and an audit log. Check whether those are in the free build or reserved for a paid edition.

### 7. An API and configuration as code

A REST API lets CI deploy. Exportable manifests let you review infrastructure changes in pull requests and rebuild a project on a new server.

### 8. Updates and a way out

How does the platform update itself, and does it roll back if the update fails? Can you import from the platform you use today?

## The main self-hosted options

| Platform | Runs on | Good at | Keep in mind |
| --- | --- | --- | --- |
| Dokku | Single Docker host | Minimal, Heroku-style `git push`, plugin ecosystem | CLI first, single server by design |
| CapRover | Docker Swarm | Simple dashboard, one-click apps | Smaller feature set for teams |
| Coolify | Docker, multiple servers over SSH | Large template catalog, active community | Laravel control plane; each server managed separately over SSH |
| Dokploy | Docker Swarm, Traefik | Compose support, clean UI, active project | Also sold as a hosted control plane; compare what each edition includes |
| LogiStack | Docker Swarm, Caddy | Reconciler model, wizards, database editor, every feature free | Young project, smaller community |
| Kubernetes-based (OpenShift, Rancher plus tooling) | Kubernetes | Large scale, broad ecosystem | Much more to operate |

For a deeper comparison of the three Docker-based options, see [LogiStack vs Dokploy vs Coolify](/blog/logistack-vs-dokploy-vs-coolify/).

## What running one looks like

A typical setup on one fresh server takes three steps.

**1. Install the platform.** With LogiStack, that is one command on Ubuntu 22.04+ or Debian 12+ with 2 GB of RAM:

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

The installer sets up Docker and Swarm if missing and keeps the dashboard private until you finish setup through an SSH tunnel.

**2. Point DNS.** Create a wildcard record so every app gets a hostname without another DNS change:

```text
*.apps.example.com.   A   203.0.113.7
```

**3. Connect Git and deploy.** Connect GitHub, GitLab, Gitea or Bitbucket, pick a repository and a build type (Dockerfile, Railpack or static site), and push. The [install guide](/docs/getting-started/install/) covers firewall ports, cloud-init and the setup wizard.

From then on, your routine is short: apply platform updates, watch disk and alerts, and check that backup restore tests pass.

## Honest trade-offs of self-hosting

- **You are the escalation path.** When something breaks at the server level, there is no support ticket that fixes it for you.
- **Single-server setups have a single point of failure.** Add nodes and off-site backups before a client depends on it.
- **Security is shared with you.** The platform can encrypt secrets, isolate networks and scan images, but SSH keys, firewall rules and OS updates are yours.

## FAQ

### Is a self-hosted PaaS free?

The open-source platforms are free to install. You pay for servers, bandwidth, backup storage and your time. LogiStack is Apache 2.0 with no paid edition, so SSO, custom roles and multi-node clusters are in the same build.

### How many apps can one server run?

It depends on the apps. A small API or website at idle uses tens of MB of memory. Leave headroom for builds, which use more memory than running apps, and for databases.

### Can a self-hosted PaaS run across several servers?

Yes, if it is built on an orchestrator. Docker Swarm and Kubernetes-based platforms spread services over nodes. Services with a volume usually stay pinned to the node that holds the data.

### Can I move from Heroku or another platform?

Yes. Anything that builds from a Dockerfile or buildpack-style detection moves easily; export environment variables and dump databases. Some platforms import from other self-hosted tools: LogiStack migrates services from Dokploy and Coolify one at a time, with rollback for each.

LogiStack is an open-source self-hosted PaaS built on Docker Swarm and Caddy. It keeps desired state in Postgres, tags every build immutably, and ships backups with restore checks, SSO and an audit log in the free build. See the [features](/features/) or install it on your server from the [install section](/#install).

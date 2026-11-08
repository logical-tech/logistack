---
title: "Kubernetes alternatives: simpler ways to run containers"
description: "Kubernetes alternatives for teams that need containers on more than one server: Swarm, Nomad, managed runtimes and PaaS, compared with a decision guide."
date: 2026-11-08
category: Orchestration
keywords: kubernetes alternatives, kubernetes alternative, docker swarm, nomad vs kubernetes, container orchestration without kubernetes
---

Your app outgrew one server, or you want it to survive one server dying, and every guide tells you the answer is Kubernetes. Then you read about control planes, CNI plugins, ingress controllers, Helm charts and RBAC, and you wonder whether three web services and a Postgres database need all of that. Often they don't. There are good Kubernetes alternatives for most teams below a certain size, and picking one is mostly about being honest regarding what you need.

This guide lists what an orchestrator has to do, groups the alternatives by how much they take off your hands, and ends with the cases where Kubernetes is still the right call.

## What you actually need from an orchestrator

Before comparing tools, write down your requirements. For most web workloads the list is short:

- **Restart on failure.** A crashed process comes back without a human.
- **Rolling updates.** New versions start and pass a health check before old ones stop.
- **More than one machine.** Work spreads across servers, and moves when one fails.
- **Service discovery.** Services find each other by name.
- **Secrets.** Credentials reach containers without being baked into images.
- **Ingress and HTTPS.** Requests reach the right service with a valid certificate.
- **Scaling.** More copies when busy, fewer when quiet.

Kubernetes does all of this and much more: custom resources, operators, fine-grained network policies, pluggable storage, multi-tenant quotas. That extra power is why it is the standard for large platforms. It is also why it needs people who understand it. If your list stops at the seven items above, a smaller tool covers it.

## Kubernetes alternatives by category

| Option | Category | Multi-server | You operate | Best for |
| --- | --- | --- | --- | --- |
| Docker Compose on one host | Single host | No | One server | Small apps, internal tools |
| Docker Swarm | Orchestrator | Yes | The cluster | Teams who know Compose |
| HashiCorp Nomad | Orchestrator | Yes | The cluster | Mixed workloads, containers and binaries |
| Kamal | Deploy tool | Yes, per host | The servers | Rails and similar apps on a few hosts |
| K3s, MicroK8s, k0s | Lighter Kubernetes | Yes | The cluster | Kubernetes API with less overhead |
| Google Cloud Run, AWS ECS with Fargate, Azure Container Apps | Managed runtime | Yes | Nothing below the container | Teams already in one cloud |
| Fly.io | Managed runtime | Yes, many regions | Nothing below the app | Apps close to users worldwide |
| Hosted PaaS (Render, Railway, Heroku) | Platform | Yes | Nothing | Teams without ops time |
| Self-hosted PaaS (LogiStack, Coolify, Dokploy) | Platform | Yes | The servers | Teams who want a PaaS on their own machines |

## Stay on one host for longer than you think

A single well-sized server with Docker Compose, restart policies and backups runs a surprising amount of production traffic. It has no orchestration at all, and that is its strength: nothing to learn, nothing to break.

```yaml
# compose.yaml
services:
  web:
    image: ghcr.io/acme/web:1.8.2
    restart: unless-stopped
    env_file: .env
    depends_on:
      - db
  db:
    image: postgres:17
    restart: unless-stopped
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
```

The limits are clear: one machine means one failure domain, and updates usually mean a short restart. When those limits start to hurt, move up one step, not five. See [deploying Docker Compose in production](/blog/deploy-docker-compose-in-production/) for how far this goes.

## Lighter orchestrators

### Docker Swarm

Swarm is built into Docker Engine. You turn it on with one command, join more machines with a token, and deploy with the compose format you already use, plus a `deploy` section:

```bash
docker swarm init
docker stack deploy -c compose.yaml shop
```

```yaml
services:
  web:
    image: ghcr.io/acme/web:1.8.2
    deploy:
      replicas: 3
      update_config:
        order: start-first
        failure_action: rollback
      restart_policy:
        condition: on-failure
```

You get multi-node scheduling, overlay networks with service discovery, rolling updates with automatic rollback, and encrypted secrets. What you don't get is Kubernetes' ecosystem: no operators, no Helm, fewer third-party integrations, and autoscaling is something you add yourself. Swarm is mature and still maintained in Docker Engine, but it moves slowly. Read [Docker Swarm](/blog/docker-swarm/) and [Docker Swarm vs Kubernetes](/blog/docker-swarm-vs-kubernetes/) for the full comparison.

### HashiCorp Nomad

Nomad is a single binary scheduler that runs containers, plain executables and Java apps side by side. It pairs with Consul for service discovery and Vault for secrets. It scales to very large clusters and is simpler than Kubernetes to operate. Since 2023 it is released under the Business Source License, not an open-source license, which matters if you plan to build a product on it.

### Kamal

Kamal, from 37signals, is not an orchestrator. It is a deploy tool: it builds your image, pushes it to a registry, and starts it over SSH on the hosts you list, behind its own proxy for zero-downtime switches. There is no scheduler and no automatic rescheduling when a host fails. For a few known servers and one main app, that simplicity is the point.

## Lighter Kubernetes distributions

K3s, MicroK8s and k0s package Kubernetes into a smaller install with sensible defaults. They cut the setup work, not the concepts. You still write manifests, run an ingress controller and learn kubectl. Choose them when you want the Kubernetes API, for example to use Helm charts or to match a larger company standard, but on modest hardware.

## Managed container runtimes

If you already live in one cloud, a managed runtime removes the cluster entirely:

- **Google Cloud Run** runs a container per request, scales to zero, and bills per use.
- **AWS ECS with Fargate** runs tasks without servers to manage, inside your VPC.
- **Azure Container Apps** offers a similar model on Azure, with scale rules for events and HTTP.
- **Fly.io** runs apps as lightweight virtual machines in many regions, close to users.

The trade-off is cost at steady load and coupling to that provider's networking, identity and logging. For bursty or event-driven work, they are hard to beat.

## A PaaS on top of a simple orchestrator

The last option hides the orchestrator behind a platform. Hosted PaaS products like Render and Railway do this on their infrastructure. A self-hosted PaaS does it on yours.

LogiStack is one example. It runs on Docker Swarm and adds what Swarm lacks on its own:

- Builds from Git on every push, with immutable image tags and one-click rollbacks.
- Caddy as the only proxy, with certificates issued and shared across ingress nodes.
- A reconciler that stores desired state in Postgres and converges Docker to it every 30 seconds. See [Architecture](/docs/reference/architecture/).
- New servers joined from a wizard over SSH, each with an agent for metrics and logs. See [Nodes](/docs/operations/nodes/).
- CPU-based [autoscaling](/docs/deploy/autoscaling/) between a minimum and maximum number of copies.
- Managed databases, backups, preview environments and an audit log, in an Apache 2.0 build with no paid tier.

Be aware of the limits. Swarm keeps volumes local to a node, so a database is pinned to the server that holds its data, and high availability for stateful services is up to you. LogiStack is also a young project with a smaller community than Kubernetes-based platforms. For web apps, APIs, workers and databases on a handful of servers, the trade is usually worth it.

## How to choose

Answer these in order:

1. **Do you need the Kubernetes API?** Required Helm charts, operators, or a company standard mean Kubernetes. Use a managed service such as EKS, GKE or AKS, or K3s on your own hardware.
2. **Are you committed to one cloud?** Use its managed runtime: Cloud Run, ECS with Fargate or Container Apps.
3. **Do you have no ops time at all?** Use a hosted PaaS. See [best PaaS providers](/blog/best-paas-providers/).
4. **Do you want your own servers with little ops work?** Use a self-hosted PaaS on Swarm, such as LogiStack.
5. **Do you want full control with minimal moving parts?** Use Swarm or Nomad directly, or Compose on one host.

## When Kubernetes is the right answer

Kubernetes earns its complexity when you have many teams sharing one platform, dozens or hundreds of services, strict network isolation between tenants, a need for operators that manage stateful systems, or hiring plans that assume Kubernetes skills. If that describes you, pick a managed Kubernetes service and invest in a platform team. If it doesn't yet, start simpler and move when the need is real. Containers built for Swarm or a PaaS move to Kubernetes later without a rewrite.

## FAQ

### What is the simplest alternative to Kubernetes?

Docker Compose on a single server, then Docker Swarm when you need more than one machine. Swarm uses the same compose format and is built into Docker, so there is nothing new to install.

### Is Docker Swarm dead?

No. Swarm mode is still part of Docker Engine and still maintained, though it gets fewer new features than Kubernetes. Several self-hosted platforms, LogiStack included, are built on it.

### Can small teams run production without Kubernetes?

Yes. Many production apps run on a PaaS, a managed container runtime or Swarm. What matters is restarts, rolling updates, backups and monitoring, not the orchestrator's name.

### Is Nomad open source?

Not anymore. HashiCorp moved Nomad to the Business Source License in 2023. You can use it for free in most cases, but the license restricts offering it as a competing service.

If Swarm with a PaaS on top sounds like the right size for you, [install LogiStack](/#install) on one server, deploy a service, and add a second node when you need it. The features page lists everything that comes with it.

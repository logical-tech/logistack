---
title: "Kubernetes vs Docker: how they differ and work together"
description: "Kubernetes vs Docker explained: what each tool does, why they are not rivals, what the dockershim removal changed, and when you need one or both."
date: 2026-11-08
category: Docker
keywords: kubernetes vs docker, docker vs kubernetes, docker or kubernetes, dockershim, docker compose vs kubernetes
---

Someone on your team asks "should we move from Docker to Kubernetes?" and the room splits. Half think it's a natural upgrade, half think it's a six-month detour. Part of the confusion is the question itself. Kubernetes vs Docker is not a choice between two equivalent tools. Docker builds and runs containers. Kubernetes decides where containers run across many machines and keeps them running. Most teams that use Kubernetes still use Docker every day.

This article untangles the two, explains what changed when Kubernetes stopped using Docker as a runtime, and helps you decide what your setup actually needs.

## The short answer

- **Docker** is a toolkit for packaging an app into an image and running that image as a container. Its home is one machine: your laptop, a CI runner, a server.
- **Kubernetes** is a cluster orchestrator. You give it the images and a description of what should run, and it schedules containers across nodes, restarts them, scales them and routes traffic to them.
- They meet at the **image**. A Dockerfile produces an OCI image, and Kubernetes runs OCI images. That shared format is why the two fit together.

## What "Docker" actually means

"Docker" names several things, which feeds the confusion:

| Piece | What it does |
| --- | --- |
| Docker Engine (`dockerd`) | The daemon that builds images, runs containers and manages networks and volumes on one host |
| Docker CLI | The `docker` command that talks to the Engine |
| Dockerfile and BuildKit | The recipe format and the builder that turns it into an image |
| Docker Compose | Runs a multi-container app from one YAML file on one host |
| Docker Swarm | The orchestrator built into Docker Engine, for clusters of Docker hosts |
| Docker Hub | A public image registry |
| Docker Desktop | A desktop app that runs all of the above in a VM on macOS and Windows |

Docker Engine and its CLI are open source (Moby, Apache 2.0). Docker Desktop is a commercial product, free for personal use and small businesses, with paid subscriptions required for larger companies.

When people compare Kubernetes and Docker, they usually mean one of two comparisons: Kubernetes vs **Docker Compose** (one host vs a cluster) or Kubernetes vs **Docker Swarm** (two cluster orchestrators). We cover the second in depth in [Docker Swarm vs Kubernetes](/blog/docker-swarm-vs-kubernetes/).

## What Kubernetes actually is

Kubernetes is an API for describing the desired state of a cluster, plus controllers that make it true. You create objects such as Deployments, Services and Ingresses; the scheduler picks nodes; the kubelet on each node starts containers through a container runtime; controllers keep checking that what runs matches what you declared.

Kubernetes doesn't build images, and since version 1.24 it doesn't use Docker Engine to run them either. It talks to any runtime that implements its Container Runtime Interface (CRI), most often containerd or CRI-O.

## "Kubernetes deprecated Docker": what really changed

In 2020 the Kubernetes project announced it would remove **dockershim**, the adapter that let the kubelet drive Docker Engine. It was removed in Kubernetes 1.24 in 2022. The headline scared people, but the practical impact was narrow:

- **Your images kept working.** Images built with `docker build` are OCI images, and containerd and CRI-O run them unchanged.
- **Your Dockerfiles kept working.** Nothing about how you build changed.
- **Cluster operators changed the node runtime** from Docker Engine to containerd, which Docker Engine itself already used underneath.
- **Tools that relied on the Docker socket on nodes broke**, for example builds that mounted `/var/run/docker.sock` into a pod. Those moved to BuildKit, Kaniko or similar.

So Kubernetes stopped using Docker as plumbing on its nodes. Developers kept using Docker to build and test.

## How the layers stack up

It helps to see where each tool sits:

| Layer | Question it answers | Common tools |
| --- | --- | --- |
| Build | How does my code become an image? | Dockerfile with BuildKit, Buildpacks, Railpack, Kaniko |
| Distribute | Where do images live? | Docker Hub, GHCR, a self-hosted registry |
| Run on one host | How does a container start and stop? | containerd, runc, Docker Engine, Podman |
| Compose on one host | How do several containers run together? | Docker Compose, Podman Compose |
| Orchestrate a cluster | Which node runs what, and what happens when one fails? | Kubernetes, Docker Swarm, Nomad |
| Platform | How do developers deploy without touching the above? | PaaS layers, internal developer platforms |

Docker spans the first four rows and, with Swarm, the fifth. Kubernetes lives in the fifth row only. A refresher on the first rows is in [Docker image vs container](/blog/docker-image-vs-container/).

## How they work together in practice

A typical pipeline uses both. CI builds and pushes with Docker:

```bash
docker build -t ghcr.io/acme/api:3f9c2e1 .
docker push ghcr.io/acme/api:3f9c2e1
```

Then the deploy step tells Kubernetes to roll out the new image:

```bash
kubectl set image deployment/api api=ghcr.io/acme/api:3f9c2e1
kubectl rollout status deployment/api
```

Locally, the same developer runs the app and its database with Compose:

```yaml
services:
  api:
    build: .
    ports: ["3000:3000"]
    environment:
      DATABASE_URL: postgres://app:app@db:5432/app
  db:
    image: postgres:17
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
```

Docker on the laptop and in CI, Kubernetes in production. That split is the most common real-world answer to "Kubernetes or Docker".

## Docker Compose vs Kubernetes for running production

If you already run production with Compose on a server, here is what you gain and give up by moving to Kubernetes:

| | Docker Compose on one server | Kubernetes |
| --- | --- | --- |
| Machines | One | Many |
| Survives a node failure | No | Yes, for stateless workloads and replicated storage |
| Rolling updates | Limited; containers restart in place | Built in, with health checks and rollback |
| Scaling | `docker compose up --scale`, same host | Replicas across nodes, autoscaling |
| Learning curve | An afternoon | Weeks to be comfortable, longer to operate |
| Ops work | Low | High unless managed |

Compose on one well-run server takes many apps further than people expect. We describe how in [deploying Docker Compose in production](/blog/deploy-docker-compose-in-production/).

## When Docker alone is enough

You don't need Kubernetes when:

- Your app fits on one or two servers with headroom.
- A few minutes of downtime during a host reboot is acceptable, or you can schedule it.
- Nobody on the team wants to be the Kubernetes operator.
- Your workloads are ordinary: web apps, APIs, background workers, a database.

## When you need Kubernetes

Kubernetes earns its cost when:

- You run dozens of services across many nodes and need them packed efficiently.
- You need autoscaling of pods and nodes on a cloud provider.
- You depend on operators (for databases, message queues, certificates) or a service mesh.
- Your organization or customers require it, or you already have platform engineers.

## The middle ground

Between "one server with Compose" and "Kubernetes" sits a wide middle: several servers, rolling updates, failover for stateless services, but no platform team. Two options live there.

**Docker Swarm** clusters Docker hosts with the same compose format. It is small, stable and easy to reason about. Our [Docker Swarm guide](/blog/docker-swarm/) walks through a setup.

**A self-hosted PaaS on Swarm** adds what Swarm leaves out. LogiStack is one: open source under Apache 2.0, running on Docker Swarm with Caddy as the proxy. You connect a repository, and each push builds an image in rootless BuildKit, tags it with the deployment ID and rolls it out with a health check before the old container stops. See [deploy from Git](/docs/deploy/from-git/). Postgres holds the desired state of every service, and a reconciler converges Swarm and Caddy to it, so a container changed by hand drifts back.

![The Overview tab of the web service: three running replicas on nodes fra-1 and fra-2, the state panel and the domain](/docs/screens/service-overview.webp)

It is not Kubernetes. If you need operators, CSI volumes or the Kubernetes API, LogiStack won't provide them, and it is a young project with a smaller community. For teams in the middle, though, it keeps the Docker mental model and adds HTTPS, backups, logs, metrics and access control on top.

## What about Docker alternatives?

You can also replace Docker on the build and run side without touching Kubernetes. Podman runs containers without a daemon and accepts most Docker CLI commands. nerdctl gives a Docker-like CLI on top of containerd. Buildah and Kaniko build images without a Docker daemon. The trade-offs are covered in [alternatives to Docker](/blog/alternatives-to-docker/).

## FAQ

### Can Kubernetes run without Docker?

Yes. Since Kubernetes 1.24, nodes use a CRI runtime such as containerd or CRI-O, not Docker Engine. You can still build your images with Docker, because Kubernetes runs any OCI image.

### Should I learn Docker or Kubernetes first?

Docker. Kubernetes assumes you understand images, containers, ports, volumes and environment variables. Once you can build an image and run an app with Compose, Kubernetes concepts make much more sense.

### Is Kubernetes replacing Docker?

No. Kubernetes replaced Docker Engine only as the runtime on its nodes. Docker remains the most common way to build images and run containers on developer machines and single servers.

### Is Docker Compose a replacement for Kubernetes?

For one host, often yes. Compose has no multi-node scheduling or failover, so it can't replace Kubernetes for clusters. Docker Swarm, which reads compose files, covers small clusters.

### Do I need Kubernetes to run containers in production?

No. Many production apps run on a single server with Compose, on Docker Swarm, or on a PaaS. Kubernetes makes sense once scale, team structure or ecosystem needs justify its operating cost.

If you want the middle ground without building it yourself, LogiStack installs on a Linux server with one command and adds servers from the dashboard as you grow. See [the install steps](/#install).

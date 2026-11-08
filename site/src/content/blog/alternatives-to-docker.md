---
title: "Alternatives to Docker: 9 container tools compared"
description: "Alternatives to Docker compared: Podman, containerd, CRI-O, Buildah, LXC and Incus, Apptainer and desktop options, with what each replaces and when to switch."
date: 2026-11-08
category: Comparisons
keywords: alternatives to docker, docker alternatives, podman vs docker, containerd, docker desktop alternatives
---

You might be looking for **alternatives to Docker** because of Docker Desktop's license terms at your company, because a security team wants no root daemon on servers, because Kubernetes no longer talks to Docker directly, or because you only need part of what Docker does. Each of those reasons points to a different tool. "Docker" is several things bundled together, and most alternatives replace one piece, not all of them.

This guide splits Docker into its parts, compares the main replacements for each, and is honest about when staying on Docker is the better call.

## What exactly are you replacing?

Docker is a bundle:

| Piece | What it does | Main alternatives |
|---|---|---|
| CLI and daemon (`dockerd`) | Runs and manages containers on a host | Podman, nerdctl with containerd |
| Low-level runtime | Starts the actual container process | containerd, CRI-O, runc, crun |
| Image builder | Turns a Dockerfile into an image | Buildah, BuildKit standalone, Kaniko |
| Docker Desktop | VM, GUI and tooling on macOS and Windows | Podman Desktop, Rancher Desktop, Colima, OrbStack |
| Compose | Multi-container apps from YAML | Podman Compose, `podman kube play` |
| Swarm | Orchestration across hosts | Kubernetes, Nomad |

Images are not on this list because they are not Docker-specific. Docker images follow the OCI image format, so every tool below runs them. Switching tools does not mean rebuilding your images.

## 1. Podman

Podman is the closest drop-in replacement for the Docker CLI. Led by Red Hat and licensed under Apache 2.0, it runs containers without a central daemon: each container is a child process of the command that started it, supervised by `conmon`. It runs rootless by default, so a regular user can start containers without any root-owned service.

```bash
podman run -d --name web -p 8080:80 docker.io/library/nginx:1.27
podman ps
alias docker=podman   # most everyday commands work unchanged
```

Podman also has pods, a group of containers sharing a network namespace, modelled on Kubernetes pods. It can run Kubernetes YAML locally with `podman kube play`, and integrates with systemd through Quadlet unit files.

**Choose it when** you want no root daemon, you work on Red Hat-family systems where it is the default, or you want systemd to manage containers.

**Watch for** differences with Compose files (Podman Compose and `podman compose` cover most, not all, of them), rootless networking that behaves differently for low ports, and tools that expect the Docker socket.

## 2. containerd with nerdctl

containerd is the runtime underneath Docker itself. It is a CNCF graduated project and the default runtime in most managed Kubernetes services. On its own, it has a minimal CLI (`ctr`) meant for debugging. nerdctl adds a Docker-compatible CLI on top, including `nerdctl compose`.

```bash
nerdctl run -d --name web -p 8080:80 nginx:1.27
nerdctl compose up -d
```

**Choose it when** you want the same runtime your Kubernetes nodes use, or a smaller footprint than full Docker Engine.

**Watch for** a smaller user community than Docker or Podman for the nerdctl layer.

## 3. CRI-O

CRI-O is a container runtime built only for Kubernetes. It implements the Kubernetes Container Runtime Interface and nothing else. OpenShift uses it by default. You do not run containers by hand with it in day-to-day work.

**Choose it when** you run Kubernetes and want a runtime whose scope is exactly what the kubelet needs.

**Background:** Kubernetes removed its built-in Docker shim in version 1.24. Clusters now talk to containerd or CRI-O directly. Images built with Docker still run there unchanged. Our [Kubernetes vs Docker](/blog/kubernetes-vs-docker/) post explains why this caused more confusion than breakage.

## 4. Buildah

Buildah builds OCI images without a daemon, either from a Dockerfile or step by step from a shell script. It shares its storage and image libraries with Podman.

```bash
buildah bud -t registry.example.com/app:1.4.2 .
buildah push registry.example.com/app:1.4.2
```

**Choose it when** you build images in CI runners that cannot run a Docker daemon, or want scripted builds without a Dockerfile.

## 5. BuildKit standalone and Kaniko

BuildKit is the build engine inside modern Docker. It also runs on its own, including rootless, through `buildkitd` and the `buildctl` client, with strong caching and multi-platform builds. Kaniko builds images inside a container without privileges and was popular in Kubernetes CI; Google archived the original repository in 2025, so check the state of community forks before adopting it.

## 6. LXC and Incus

LXC runs system containers: a full Linux userspace with an init system, closer to a lightweight VM than to an app container. Incus, a community fork of LXD under the Linux Containers project, manages LXC containers and VMs through one API and CLI.

**Choose it when** you want long-lived "machines" (a dev box, a legacy service with several daemons) at container cost, common in homelabs and Proxmox setups.

**Not a fit when** you want the image-per-release, disposable-container workflow. That is what OCI tools are built for.

## 7. Apptainer

Apptainer, formerly Singularity, targets high-performance computing. Images are single files, containers run as the calling user, and it integrates with batch schedulers and GPUs on shared clusters. It can import OCI images.

**Choose it when** you run scientific workloads on a shared HPC cluster where users cannot have root.

## 8. Docker Desktop alternatives for macOS and Windows

On a laptop, the question is usually Docker Desktop, not Docker Engine. Docker Desktop is free for personal use, education, non-commercial open source and small businesses, and requires a paid subscription for larger companies under Docker's terms. If that affects you, these replace the VM and tooling:

| Tool | Platforms | License | Engine inside | Notes |
|---|---|---|---|---|
| Podman Desktop | macOS, Windows, Linux | Apache 2.0 | Podman | GUI plus Kubernetes helpers |
| Rancher Desktop | macOS, Windows, Linux | Apache 2.0 | containerd or dockerd | Bundles a local Kubernetes |
| Colima | macOS, Linux | MIT | Docker Engine or containerd | CLI only, built on Lima |
| OrbStack | macOS | Commercial, free for personal use | Docker Engine | Fast, light, Linux VMs too |

Colima and OrbStack keep the real Docker Engine inside their VM, so your existing CLI, Compose files and scripts work unchanged. The Docker Engine and CLI on Linux are open source and need no subscription.

## 9. Orchestrators instead of Swarm

If what you want to replace is Docker Swarm, you are looking at orchestrators, not runtimes. Kubernetes is the default for large platforms and has the biggest ecosystem. HashiCorp Nomad schedules containers and plain binaries with a simpler model; note it moved to the Business Source License in 2023. Read [Docker Swarm vs Kubernetes](/blog/docker-swarm-vs-kubernetes/) and [Kubernetes alternatives](/blog/kubernetes-alternatives/) for that decision.

## Quick comparison

| Tool | Replaces | Daemon | Rootless | Docker CLI compatible | Best for |
|---|---|---|---|---|---|
| Podman | Docker CLI and engine | No | Default | Mostly | Servers without a root daemon |
| containerd + nerdctl | Docker engine | Yes | Supported | Mostly | Kubernetes-aligned hosts |
| CRI-O | Runtime for Kubernetes | Yes | Partial | No | Kubernetes and OpenShift nodes |
| Buildah | `docker build` | No | Yes | Partial | Daemonless CI builds |
| BuildKit | `docker build` | Optional | Yes | Via buildx | Fast, cached, multi-platform builds |
| LXC / Incus | VMs, not Docker | Yes | Supported | No | System containers |
| Apptainer | Docker on HPC | No | Yes | No | Shared research clusters |

## When to stay on Docker

- **Your tools assume the Docker socket.** CI runners, monitoring agents and many self-hosted platforms talk to the Docker Engine API.
- **You use Docker Swarm.** No alternative runtime runs Swarm.
- **Your team already knows it.** Switching costs time, and the gain is often small for a server that runs Docker Engine (open source, no subscription).
- **You run on Linux servers.** The Docker Desktop license question does not apply to Docker Engine.

That last point is worth repeating: most reasons to leave Docker are about Docker Desktop on laptops. On a Linux server, Docker Engine is open source.

## Where LogiStack stands

To be clear about our own product: LogiStack, the open-source PaaS we build, runs on Docker Engine with Docker Swarm. The installer sets up Docker and Swarm if they are missing. It does not run on Podman or containerd alone. That is a deliberate choice: Swarm gives multi-node scheduling, overlay networks and rolling updates with no extra cluster software to operate. See the [architecture reference](/docs/reference/architecture/).

What it does take from the alternatives: builds run in rootless BuildKit, not through the Docker daemon, and every image it runs is a standard OCI image, so anything you build elsewhere deploys there unchanged. See [deploy from an image](/docs/deploy/from-image/) and [registries](/docs/deploy/registries/).

If you need Kubernetes or a daemonless runtime on your servers, LogiStack is not the right fit and a Kubernetes-based platform will serve you better. If you want containers on your own servers with the least to operate, it is worth a look. Read more on [containerization](/blog/containerization/).

## FAQ

### What is the best alternative to Docker?

For most people replacing the Docker CLI and engine, Podman. It runs the same images, accepts nearly the same commands and needs no root daemon. For Docker Desktop on a Mac, Colima or OrbStack keep Docker Engine itself and change only the VM around it.

### Can Podman run docker-compose files?

Mostly. `podman compose` and Podman Compose run most compose files, and Podman can also expose a Docker-compatible socket so Docker Compose itself talks to Podman. Complex files with specific networking or build options may need adjustments.

### Do I need Docker to run Kubernetes?

No. Kubernetes uses containerd or CRI-O through the Container Runtime Interface. You can still build images with Docker and run them on Kubernetes, because both sides use the OCI image format.

### Is Docker still free?

Docker Engine and the Docker CLI are open source and free on Linux. Docker Desktop is free for personal use, education, non-commercial open source and small businesses, and requires a paid subscription for larger companies.

### Will my Docker images work with other tools?

Yes. Docker builds OCI-compatible images, which Podman, containerd, CRI-O and Kubernetes run unchanged. Registries such as Docker Hub and GHCR serve the same images to all of them.

If you are staying on Docker Engine and want it to feel like a managed platform, [install LogiStack](/#install) on a Linux server. It sets up Docker and Swarm for you and deploys your existing images as they are.

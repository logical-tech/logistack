---
title: "Docker Swarm vs Kubernetes: which orchestrator fits your team"
description: "Docker Swarm vs Kubernetes compared on setup, networking, scaling, storage, ecosystem and running cost, with a clear guide to which one fits your team."
date: 2026-11-08
category: Comparisons
keywords: docker swarm vs kubernetes, swarm or kubernetes, kubernetes vs swarm, container orchestrator comparison
---

You have outgrown one server and need an orchestrator. Every search for Docker Swarm vs Kubernetes ends in the same advice, "it depends", followed by a feature checklist that doesn't tell you what your next six months look like. This comparison is about that: what each tool asks of you day to day, where each one breaks down, and which teams should pick which.

Short version: Kubernetes is the industry standard with a vast ecosystem and a matching operational cost. Docker Swarm is a small, stable orchestrator built into Docker that a single developer can run. Most of the decision comes down to how many people you have to operate the platform.

## The two in one table

| | Docker Swarm | Kubernetes |
| --- | --- | --- |
| Where it comes from | Built into Docker Engine (Moby project) | CNCF project, started at Google in 2014 |
| License | Apache 2.0 | Apache 2.0 |
| Install | `docker swarm init` on any Docker host | A distribution (kubeadm, k3s, k0s) or a managed service (EKS, GKE, AKS) |
| Config format | Compose files with a `deploy` section | YAML manifests per object, often templated with Helm or Kustomize |
| State store | Raft log inside the managers | etcd |
| Scheduling | Resources, constraints, spread | Resources, affinity, taints, topology spread, priorities, custom schedulers |
| Ingress | Layer 4 routing mesh; bring your own proxy | Ingress or Gateway API with a controller you choose |
| Autoscaling | None built in | Horizontal Pod Autoscaler, plus cluster autoscalers on cloud |
| Storage | Local volumes and volume plugins | PersistentVolumes with CSI drivers |
| Extensibility | Little: what Swarm does is fixed | Custom resources and operators for almost anything |
| Ecosystem | Small | Very large: Helm charts, operators, service meshes, policy engines |
| People to run it | One developer, part time | Usually a platform engineer or a managed service |

## Architecture: one binary vs a control plane

Swarm's whole control plane lives inside `dockerd`. A manager node stores state in Raft, schedules tasks and serves the Docker API. Workers run tasks. There is nothing else to deploy, upgrade or secure separately, and upgrading Docker upgrades Swarm.

Kubernetes splits the control plane into components: the API server, etcd, the scheduler and the controller manager, plus a kubelet and a network plugin on every node. Each one is a separate thing to configure and monitor. The upside is that each piece is replaceable and extensible. The downside is that a self-managed cluster has more failure modes, and certificates, etcd backups and version skew become your problem.

Both use the same core idea: you declare desired state, and controllers work continuously to make reality match it. If that pattern is new to you, our guide to [container orchestration](/blog/container-orchestration/) explains it.

## Getting started

A three-node Swarm takes minutes:

```bash
docker swarm init --advertise-addr 10.0.0.10
docker swarm join-token worker   # run the printed command on the other nodes
docker stack deploy -c stack.yml shop
```

A bare-metal Kubernetes cluster with kubeadm involves a container runtime, kubeadm, kubelet and kubectl on every node, a pod network add-on, and join tokens with certificate hashes. Lightweight distributions such as k3s shrink that to a single install script per node, and managed services hide it entirely. Either way, you still learn Kubernetes' object model before your app runs.

The same app makes the difference concrete. In Swarm, the compose file you use locally gains a `deploy` section:

```yaml
services:
  web:
    image: ghcr.io/acme/web:1.4.2
    ports: ["8080:3000"]
    deploy:
      replicas: 3
      update_config:
        order: start-first
```

In Kubernetes, the same thing needs a Deployment and a Service, and an Ingress for a hostname:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 3
  selector:
    matchLabels: { app: web }
  template:
    metadata:
      labels: { app: web }
    spec:
      containers:
        - name: web
          image: ghcr.io/acme/web:1.4.2
          ports: [{ containerPort: 3000 }]
---
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector: { app: web }
  ports: [{ port: 80, targetPort: 3000 }]
```

Neither is hard to read. The difference is how many object types you have to understand when something goes wrong.

## Networking

Swarm gives you overlay networks and a routing mesh that accepts a published port on every node. Service discovery is DNS by service name. It works without configuration, but it stops at layer 4: hostnames, TLS and path routing need a reverse proxy you add yourself. The mesh also hides client IPs, so most production setups publish the proxy in host mode instead.

Kubernetes leaves networking to plugins (Calico, Cilium, Flannel and others) and to an ingress or Gateway API controller. You get network policies, layer 7 routing and, if you want one, a service mesh. You also get more to choose and more to debug.

## Scaling

Swarm scales when you tell it to:

```bash
docker service scale shop_web=6
```

Kubernetes ships the Horizontal Pod Autoscaler, which adjusts replicas from CPU, memory or custom metrics, and on cloud providers a cluster autoscaler adds and removes nodes. If your traffic swings widely during the day, this is a real advantage.

## Storage and stateful services

This is where the gap is widest. Swarm volumes are local to a node unless you install a volume plugin, so in practice you pin each database to one node with a placement constraint and back it up yourself.

Kubernetes has PersistentVolumeClaims, StorageClasses and CSI drivers for cloud disks, Ceph, Longhorn and more. A pod that moves to another node can take its volume with it. Database operators add replication, failover and backups on top. If you run many stateful workloads that must survive node loss without manual steps, Kubernetes is the stronger choice.

## Security and access

Swarm encrypts node-to-node control traffic with mutual TLS by default and stores secrets encrypted in Raft. It has no users or roles: access to a manager's Docker socket is full control of the cluster.

Kubernetes has RBAC, service accounts, admission controllers, Pod Security Standards and network policies. Getting them right takes work, but the controls exist. Either way, the container-level basics still apply.

## What it costs to run

The license cost of both is zero. The real cost is time:

- **Swarm** needs Docker upgrades, an odd number of managers, a proxy, a registry, monitoring and backups. One person who knows Docker can own it alongside other work.
- **Self-managed Kubernetes** needs all of that plus control plane upgrades every few months to stay on a supported version, etcd backups, CNI and ingress controller upgrades, and someone who keeps up with the ecosystem.
- **Managed Kubernetes** removes the control plane work, adds a per-cluster fee on most clouds, and ties you to that provider's networking and storage.

## Which one should you pick

Pick **Docker Swarm** when:

- One to five people build and run everything.
- Your workloads are web apps, APIs, workers, cron jobs and a few databases.
- You run on a handful of VPS or bare-metal servers, possibly outside the big clouds.
- You value a platform you can fully understand over one you can extend.

Pick **Kubernetes** when:

- You have, or plan to hire, people whose job is the platform.
- You need operators, a service mesh, fine-grained network policies or GPU scheduling.
- Your company already standardised on it, or customers require it.
- You need autoscaling across nodes on a cloud provider.

If neither fits, there are other options covered in [Kubernetes alternatives](/blog/kubernetes-alternatives/) and the broader [container orchestration tools](/blog/container-orchestration-tools/) roundup.

## Moving between them later

Your images don't care. An OCI image built for Swarm runs on Kubernetes unchanged. What you rewrite is the deployment config: compose files become manifests or Helm charts. Tools like Kompose convert simple compose files to Kubernetes YAML as a starting point. Keep config in environment variables, keep state out of containers, and the move stays a few days of work rather than a rewrite.

## Swarm with the missing pieces added

Most of Swarm's weak spots in the table above are things that sit around the orchestrator, not inside it: HTTPS, builds, autoscaling, monitoring, access control. That is the space LogiStack fills. It is an open-source, self-hosted PaaS that runs on Docker Swarm and keeps the desired state of every service in Postgres. A reconciler converges Swarm and the Caddy proxy to that state, so a hand-edited service drifts back to what you declared.

On top of Swarm it adds:

- Deploys from Git or an image, with builds in rootless BuildKit and immutable image tags for instant rollbacks.
- Caddy as ingress with automatic HTTPS.
- [CPU-based autoscaling](/docs/deploy/autoscaling/) between a minimum and maximum, which Swarm lacks.
- Roles per organization, folder, project or environment, SSO and an audit log, all in the free build.
- A wizard that joins new servers to the Swarm over SSH. See [Nodes](/docs/operations/nodes/).

![The Scaling section with Automatic selected: running 3 copies now, between 2 and 6](/docs/screens/service-scaling.webp)

It won't give you Kubernetes' ecosystem or CSI-backed volumes that follow a pod across nodes. Databases stay pinned to the node that holds their data, with scheduled backups. LogiStack is also young, with a smaller community. If those limits matter, choose Kubernetes.

## FAQ

### Is Docker Swarm dead?

No. Swarm mode ships in every Docker Engine release and is maintained in the Moby project, and Mirantis supports it commercially. It gets fewer new features than Kubernetes, but its API is stable and it remains a sound choice for small clusters.

### Is Kubernetes overkill for a small team?

Often, yes. If you have a few services on a few servers, Kubernetes adds concepts and upgrades that cost more time than they save. Managed Kubernetes reduces the burden, but you still learn and debug its object model.

### Can I use Docker Compose files with Kubernetes?

Not directly. Kubernetes uses its own manifests. Kompose can translate a simple compose file into Kubernetes objects, which you then refine by hand. Swarm reads compose files natively with `docker stack deploy`.

### Which is faster, Swarm or Kubernetes?

Your containers run at the same speed on both, since both usually run them with containerd. Swarm usually deploys and schedules faster on small clusters because it has fewer layers. At large scale, Kubernetes' scheduler and autoscaling make better use of resources.

### Can I run Swarm and Kubernetes on the same servers?

Technically yes, but it is rarely a good idea: both expect to own the node's resources and networking. Run them on separate machines if you are migrating from one to the other.

If Swarm's size fits your team, LogiStack gives you a full platform on it with one command on a Linux server. It is free under Apache 2.0 with no paid tier. [Install it](/#install), read the [architecture](/docs/reference/architecture/).

---
title: "Docker Swarm in 2026: a practical guide to Swarm mode"
description: "Learn how Docker Swarm works, set up a cluster, deploy stacks with rolling updates and secrets, and see where Swarm needs help in production."
date: 2026-11-08
category: Orchestration
keywords: docker swarm, docker swarm mode, swarm cluster, docker stack deploy, swarm tutorial
---

Your app runs on one server with `docker compose up -d`. Then the server needs a kernel update, or traffic doubles, or a disk fills at 2 a.m. and everything goes down together. You want a second machine, but you don't want to learn a whole new platform to get it. Docker Swarm exists for this moment: it turns a handful of Docker hosts into one cluster, using the same images and almost the same compose files you already have.

This guide explains how Docker Swarm works, walks through a real cluster setup, and is honest about what Swarm leaves for you to build. It ends with how a control plane on top of Swarm fills those gaps.

## What Docker Swarm is

Swarm mode is the orchestrator built into Docker Engine. There is nothing extra to install: any machine running Docker can become a Swarm node with one command. Once nodes join, you stop starting containers by hand and start declaring **services**. You say "run three copies of this image with 512 MB each" and Swarm decides where they run, restarts them when they die, and moves them when a node disappears.

The vocabulary is small:

| Term | Meaning |
| --- | --- |
| Node | A Docker host in the cluster. Either a manager or a worker. |
| Manager | Holds the cluster state, schedules work and answers API calls. Can also run containers. |
| Worker | Runs containers the managers assign. Has no say in cluster decisions. |
| Service | The desired state: an image, a replica count, ports, limits, networks. |
| Task | One scheduled container of a service. Swarm replaces failed tasks with new ones. |
| Stack | A group of services deployed together from one compose file. |

Services come in two modes. A **replicated** service runs a fixed number of tasks wherever they fit. A **global** service runs exactly one task on every node that matches its constraints, which is how you deploy agents, log shippers and edge proxies.

## How Swarm works under the hood

### Managers and Raft

Managers keep the cluster state in a replicated log using the Raft consensus algorithm. A change (a new service, a scaled replica count) is committed once a majority of managers agree. That majority rule is why the number of managers matters:

| Managers | Can lose | Notes |
| --- | --- | --- |
| 1 | 0 | Fine for a lab. The cluster can't change state if it dies. |
| 3 | 1 | The usual production choice. |
| 5 | 2 | For larger clusters or flaky networks. |
| 7 | 3 | Rarely worth the extra coordination. |

Keep the count odd. Four managers tolerate the same single failure as three, with more chatter. If you lose quorum, running containers keep running, but you can't deploy or reschedule until a majority is back.

### Scheduling

When you create or update a service, a manager picks nodes for each task. It filters out nodes that lack the CPU or memory the task reserves, nodes that fail placement constraints such as `node.labels.zone==a`, and nodes that are drained. Among the rest it spreads tasks to balance the load.

### Networking

Swarm creates two things on `docker swarm init`:

- An **overlay network** driver, which uses VXLAN on UDP port 4789 so containers on different hosts talk as if they share a LAN. You create one overlay per app or environment and attach services to it.
- The **ingress routing mesh**. Publish port 8080 on a service and every node in the cluster accepts connections on 8080, then forwards them to a healthy task, wherever it runs.

Inside an overlay, services find each other by name through Swarm's built-in DNS. A service named `api` resolves to a virtual IP that load-balances across its tasks.

The routing mesh has one well-known catch: it rewrites the source address, so your app sees an internal IP instead of the client's. If you need real client IPs for logs, rate limits or geo rules, publish the proxy's ports in `host` mode on dedicated ingress nodes instead of through the mesh. More on Swarm networking in our [Docker networking guide](/blog/docker-networking/).

## Set up a Docker Swarm cluster

You need two or more Linux servers that can reach each other on these ports:

| Port | Protocol | Used for |
| --- | --- | --- |
| 2377 | TCP | Cluster management, to managers |
| 7946 | TCP and UDP | Node discovery between all nodes |
| 4789 | UDP | Overlay traffic between all nodes |

Cloud firewalls often block UDP by default. If services deploy fine but can't reach each other across nodes, check 4789/udp first.

On the first server, use its private address:

```bash
docker swarm init --advertise-addr 10.0.0.10
```

Print the join command for workers and run it on each other server:

```bash
# on the manager
docker swarm join-token worker

# on each new node
docker swarm join --token SWMTKN-1-3k9x...-8f2a... 10.0.0.10:2377
```

Check the result from the manager:

```bash
docker node ls
```

To grow to three managers later, run `docker swarm join-token manager` instead, or promote existing workers with `docker node promote node-2 node-3`.

Labels let you steer workloads. Mark the node with fast disks for databases:

```bash
docker node update --label-add data=true node-3
```

## Deploy a stack

A Swarm stack file is a compose file with a `deploy` section. This one runs a web app with three replicas, rolling updates that start the new task before stopping the old one, resource limits, and a secret:

```yaml
services:
  web:
    image: ghcr.io/acme/web:1.4.2
    ports:
      - "8080:3000"
    networks: [app]
    secrets: [db_password]
    environment:
      DB_PASSWORD_FILE: /run/secrets/db_password
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/health"]
      interval: 10s
      retries: 3
    deploy:
      replicas: 3
      update_config:
        parallelism: 1
        delay: 10s
        order: start-first
        failure_action: rollback
      restart_policy:
        condition: on-failure
      resources:
        limits:
          cpus: "0.50"
          memory: 512M

  db:
    image: postgres:17
    networks: [app]
    secrets: [db_password]
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
    volumes:
      - pgdata:/var/lib/postgresql/data
    deploy:
      placement:
        constraints: [node.labels.data == true]

networks:
  app:
    driver: overlay

volumes:
  pgdata:

secrets:
  db_password:
    external: true
```

Create the secret from stdin so it never lands in your shell history, then deploy:

```bash
openssl rand -base64 32 | docker secret create db_password -
docker stack deploy -c stack.yml shop
docker stack services shop
docker service ps shop_web
```

Swarm secrets are stored encrypted in the Raft log and mounted as in-memory files under `/run/secrets/` only in tasks that ask for them. Configs work the same way for non-sensitive files such as an `nginx.conf`.

## Rolling updates, rollbacks and maintenance

Change the image tag and Swarm replaces tasks one batch at a time:

```bash
docker service update --image ghcr.io/acme/web:1.4.3 shop_web
```

With `order: start-first` and a health check, the new task must be healthy before the old one stops, which is the basis of [zero-downtime deployments](/blog/zero-downtime-deployments/). With `failure_action: rollback`, a failing update reverts on its own. You can also roll back by hand:

```bash
docker service rollback shop_web
```

Before patching a host, drain it. Swarm moves its tasks elsewhere and schedules nothing new there:

```bash
docker node update --availability drain node-2
# patch and reboot
docker node update --availability active node-2
```

Tasks don't move back on their own after you reactivate a node. They rebalance on the next update of each service.

## What Docker Swarm does not do

Swarm is deliberately small. That is its strength, and it also means a production setup needs several pieces Swarm doesn't ship:

- **No HTTPS or hostname routing.** The routing mesh is layer 4. You still need a reverse proxy that maps `shop.example.com` to a service and gets certificates. See our [comparison of Caddy, Traefik and Nginx](/blog/caddy-vs-traefik-vs-nginx/).
- **No autoscaling.** Replica counts change only when you or a script change them.
- **No builds or registry.** Every node must pull the image, so multi-node clusters need a registry and immutable tags.
- **Volumes stay on one node.** A named volume lives on the host that created it. A database task that lands on another node starts empty unless you pin it.
- **No backups, logs history or metrics.** `docker service logs` streams, it doesn't retain or search. Monitoring is up to you.
- **No users or permissions.** Anyone with access to a manager's Docker socket controls the whole cluster.
- **No drift correction outside Swarm's own objects.** Swarm keeps the replica count you last set. If someone runs `docker service scale web=5` from a shell, that is now the desired state, and nothing remembers it should be 2.

## Is Docker Swarm still maintained?

Yes. Swarm mode lives in the open-source Moby project that Docker Engine is built from, and it ships in every Docker Engine release. Mirantis, which bought Docker's enterprise business in 2019, also supports Swarm in its commercial products. Swarm gets fewer new features than Kubernetes, and its community is much smaller, but its API has been stable for years. For many teams that stability is the point.

If you are deciding between the two, read [Docker Swarm vs Kubernetes](/blog/docker-swarm-vs-kubernetes/).

## Running Swarm with a control plane on top

The gaps above are where most Swarm setups grow a pile of scripts. LogiStack is an open-source, self-hosted PaaS that fills them with one control plane, and it runs on Docker Swarm itself.

- **Desired state in Postgres, enforced by a reconciler.** Every service, domain and variable is a row. A reconciler compares those rows with what Docker and Caddy report every 30 seconds and fixes the difference. A service scaled by hand from a shell goes back to the count you set. See the [architecture reference](/docs/reference/architecture/).
- **Caddy as the ingress.** Caddy runs as a global service on nodes labelled for ingress, with ports 80 and 443 in host mode, so your apps see real client IPs. Certificates are shared across ingress nodes.
- **Immutable image tags.** Builds are tagged with the deployment ID, never `:latest`, so a rollback points at an exact image without rebuilding.
- **Nodes from a wizard.** Add a server over SSH: LogiStack checks it, installs Docker, joins it to the Swarm and starts an agent that reports metrics and logs. See [Nodes](/docs/operations/nodes/).
- **CPU-based autoscaling** between a minimum and maximum you choose, which Swarm doesn't have natively.

![The Nodes list with five servers: three ready, one draining and one down](/docs/screens/nodes.webp)

It also respects what you built before: LogiStack labels every object it creates with `logistack.managed=true` and never touches containers, services or volumes without that label.

The honest trade-off: LogiStack is a young project with a smaller community than the big platforms, and it is Swarm, not Kubernetes. If you need the Kubernetes ecosystem, it isn't the right fit.

## FAQ

### Is Docker Swarm good for production?

Yes, for small and medium clusters that run stateless web apps, APIs, workers and a few databases pinned to nodes. Plenty of companies run it in production precisely because it has few moving parts. It is a weaker fit when you need custom controllers, service meshes or a large ecosystem of operators.

### How many nodes can Docker Swarm handle?

Swarm handles clusters of hundreds of nodes, but most real deployments are between one and a few dozen. The practical limit is usually your networking and the number of managers, not Swarm's scheduler. Keep three or five managers whatever the worker count.

### Do I need Docker Compose to use Swarm?

No, you can create services with `docker service create`. In practice a compose file deployed with `docker stack deploy` is the easiest way to keep services in version control. Note that some compose keys, such as `build:`, are ignored by Swarm: images must be built and pushed first.

### Can Swarm run on a single server?

Yes. A one-node Swarm gives you services, rolling updates, secrets and health-based restarts on a single machine, and lets you add nodes later without changing how you deploy. It has no redundancy, so back up the data.

### What replaces Swarm's missing features?

A reverse proxy for HTTPS, a registry, a metrics and logs stack, a backup tool and some way to manage access. You can assemble those yourself or use a self-hosted PaaS that bundles them.

If you want Swarm's simplicity without building the rest yourself, LogiStack installs on one Linux server with a single command and grows to more nodes from the dashboard. It is free under Apache 2.0. Start at [the install section](/#install), or look through [all features](/features/) first.

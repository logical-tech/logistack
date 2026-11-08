---
title: "Docker networking explained: bridge, host, overlay and more"
description: "Docker networking explained: bridge, host, overlay and macvlan drivers, DNS between containers, published ports and the firewall rule that surprises people."
date: 2026-11-08
category: Networking
keywords: docker networking, docker network types, docker bridge network, docker overlay network, docker port publishing
---

Your app container cannot reach the database at `localhost:5432`. Or the database you thought was private answers on the public internet because `ufw` did not block it. Both are **Docker networking** problems, and both come from the same gap: Docker builds its own network for containers, with its own DNS and its own firewall rules, and it does not behave like processes on a plain Linux host. This guide explains the network drivers, how containers find each other, how ports reach the outside, and the mistakes that expose services.

## How Docker networking works in one paragraph

Each container gets its own network namespace: its own interfaces, routing table and `localhost`. Docker connects that namespace to a network through a driver. On a single host, the default driver is a Linux bridge with NAT to the outside. Containers on the same user-defined network can resolve each other by name through Docker's embedded DNS server at `127.0.0.11`. To reach a container from outside the host, you publish a port, and Docker writes iptables (or nftables) rules that forward traffic to it.

## Why localhost does not work between containers

Inside a container, `localhost` is the container itself. If your app runs in one container and Postgres in another, `localhost:5432` points at the app's own namespace, where nothing listens. Use the other container's name on a shared network:

```bash
docker network create appnet
docker run -d --name db --network appnet -e POSTGRES_PASSWORD=change-me postgres:16.4
docker run --rm --network appnet postgres:16.4 pg_isready -h db -p 5432
```

The last command prints `db:5432 - accepting connections`. That name resolution is the single most useful thing Docker networking gives you.

## Docker network drivers

| Driver | Scope | What it does | Use it for |
|---|---|---|---|
| `bridge` | One host | Private subnet behind NAT, DNS on user-defined networks | Most single-host apps |
| `host` | One host | Container shares the host's network stack | Performance-sensitive or port-heavy apps |
| `none` | One host | Only a loopback interface | Batch jobs that need no network |
| `overlay` | Cluster | Virtual network spanning several Docker hosts | Docker Swarm services |
| `macvlan` | One host | Container gets its own MAC and IP on the physical LAN | Apps that must look like a separate device |
| `ipvlan` | One host | Like macvlan, sharing the host's MAC | LANs that limit MAC addresses per port |

### The default bridge versus a user-defined bridge

When you run a container without `--network`, it joins the default `bridge` network (`docker0`). That network has a known limitation: no DNS between containers. You would have to use IP addresses or the legacy `--link` flag.

Create your own bridge instead. User-defined bridges give you:

- Name resolution between containers.
- Isolation from containers on other networks.
- The ability to connect and disconnect running containers.

```bash
docker network create --driver bridge backend
docker network connect backend my-app
docker network inspect backend
```

Docker Compose does this for you: every project gets a `<project>_default` bridge, and each service name becomes a DNS name. See [what is Docker Compose](/blog/what-is-docker-compose/) for the full picture.

### Internal networks

A network created with `--internal` has no route to the outside world. Containers on it can talk to each other but not to the internet, which suits a database that should never make outbound connections:

```bash
docker network create --internal data
```

### Host networking

With `--network host`, the container uses the host's interfaces directly. There is no NAT and no port mapping: if the app listens on port 8080, it listens on the host's port 8080. It is the fastest option and removes isolation, so use it only when you need it, for example for software that opens many dynamic ports.

### Overlay networks

Overlay networks connect containers across several Docker hosts. They are the networking layer of Docker Swarm. Traffic between nodes is encapsulated in VXLAN, and can be encrypted with `--opt encrypted`.

```bash
docker network create --driver overlay --attachable backend
```

The nodes must reach each other on these ports, and cloud firewalls often block the UDP ones by default:

| Port | Protocol | Purpose |
|---|---|---|
| 2377 | TCP | Swarm cluster management |
| 7946 | TCP and UDP | Node discovery and gossip |
| 4789 | UDP | VXLAN overlay traffic |

If a service on a second node is unreachable while everything on the first node works, check 4789/udp first. More on clusters in [Docker Swarm](/blog/docker-swarm/).

### macvlan and ipvlan

These drivers put containers directly on your physical network with their own IP address, as if they were separate machines. They are common in homelabs, for example for a DNS server that devices on the LAN query directly. By default, the host itself cannot reach its own macvlan containers, which surprises people the first time.

## Publishing ports

Containers are unreachable from outside the host until you publish a port:

```bash
docker run -d -p 8080:80 nginx:1.27            # all host interfaces, port 8080
docker run -d -p 127.0.0.1:8080:80 nginx:1.27  # only from the host itself
docker run -d -p 53:53/udp my-dns:1.0          # UDP
```

`EXPOSE` in a Dockerfile does not publish anything. It documents which port the app listens on.

### The firewall surprise

Docker writes its own iptables rules for published ports, and they are evaluated before the rules that `ufw` manages. A port published with `-p 5432:5432` is reachable from the internet even if `ufw deny 5432` is active. Three ways to avoid it:

1. Do not publish internal services at all. Let them talk over a Docker network.
2. Bind to loopback: `-p 127.0.0.1:5432:5432`.
3. Filter at the cloud provider's firewall, which sits in front of the server.

The first option is the right default. Only a reverse proxy should publish 80 and 443.

## A reverse proxy as the front door

In production, one container publishes 80 and 443 and routes each hostname to the right service over a Docker network. Caddy, Traefik and Nginx all do this. The services behind it publish nothing:

```yaml
services:
  proxy:
    image: caddy:2.9
    ports: ["80:80", "443:443"]
    networks: [edge]
  app:
    image: ghcr.io/acme/app:2.3.0
    networks: [edge, backend]
  db:
    image: postgres:16.4
    networks: [backend]

networks:
  edge: {}
  backend:
    internal: true
```

The proxy can reach the app, the app can reach the database, and the proxy cannot reach the database at all. For the proxy choice, see [Caddy vs Traefik vs Nginx](/blog/caddy-vs-traefik-vs-nginx/).

## Debugging Docker networking

```bash
docker network ls
docker network inspect backend --format '{{range .Containers}}{{.Name}} {{.IPv4Address}}{{"\n"}}{{end}}'
docker exec app getent hosts db              # does DNS resolve?
docker run --rm --network container:app nicolaka/netshoot ss -tlnp   # what listens inside app?
docker port app                              # which ports are published?
```

The `--network container:<name>` trick runs a debugging image inside another container's network namespace, so you get `curl`, `dig` and `tcpdump` without installing them in your app image.

## How LogiStack sets up the network

LogiStack, the open-source PaaS we build, runs on Docker Swarm with Caddy as the only thing listening on 80 and 443. Its [architecture reference](/docs/reference/architecture/) documents every network it creates:

| Network | Who joins it | Why |
|---|---|---|
| `ls-env-<id>` | Every service of one environment | Services reach each other by name; environments are isolated from each other |
| `ls-ingress` | Caddy and services that have a domain | Incoming HTTP traffic; databases never join it |
| `ls-control` | The control plane only | Apps never join it |
| `ls-db`, `ls-storage`, `ls-game` | Databases, storage or game servers, plus the API and worker | The database editor, object browser and game consoles |

One trade-off is stated plainly in the docs: Caddy and the API join fixed networks so adding an environment never restarts them, which means services with a domain can reach each other on `ls-ingress`.

Ports 80 and 443 are published in host mode so Caddy sees the real client IP. Ports you publish for a service bind on the node running it, or on every node through the Swarm routing mesh if you choose. The [network map](/docs/networking/network-map/) draws every service, the networks it joins and the ports it publishes on one diagram, and [Cloudflare Tunnels](/docs/networking/cloudflare-tunnels/) let you publish a service with no inbound port open at all.

![The LogiStack network map, showing services, networks and published ports](/docs/screens/network.webp)

## FAQ

### What is the default Docker network?

A bridge network called `bridge`, backed by the `docker0` interface on the host. Containers started without `--network` join it. It has no DNS between containers, so create a user-defined bridge for anything that talks to another container.

### How do two Docker containers communicate?

Put them on the same user-defined network and use the container or service name as the hostname. Docker's embedded DNS resolves the name to the container's IP, and it keeps working when the container is recreated with a new IP.

### Why can I reach my database from the internet when UFW blocks the port?

Docker inserts its own iptables rules for published ports ahead of UFW's chains. Do not publish the database port, or bind it to `127.0.0.1`, or block it in your cloud provider's firewall.

### What is the difference between bridge and overlay networks?

A bridge network lives on one host. An overlay network spans several Docker hosts and carries traffic between them, which is what Docker Swarm services use to talk across nodes.

### Should I use host networking for performance?

Only if you measured a real bottleneck. Host networking removes NAT overhead but also removes isolation and port remapping. For typical web apps behind a reverse proxy, the bridge overhead is small.

If you would rather have isolated environment networks, a proxy with automatic HTTPS and a map of what talks to what set up for you, [install LogiStack](/#install) on a server and deploy your first service.

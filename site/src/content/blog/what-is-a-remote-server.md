---
title: "What is a remote server? Types, uses and how to run apps on one"
description: "What is a remote server and how do you use one? Learn the types, how to connect over SSH, how to secure it, and how to deploy your apps on it."
date: 2026-11-08
category: Self-hosting
keywords: what is a remote server, remote server, vps, how to connect to a remote server, deploy app to remote server
---

Your app runs on your laptop, and now other people need to reach it. Closing the lid takes it offline, your home connection changes IP, and your router blocks inbound traffic. The answer is to run it somewhere else: a machine that stays on, has a stable address and sits on a fast network. So what is a remote server, exactly? It is any computer you use over a network instead of sitting in front of it, usually a Linux machine in a data center that you manage over SSH.

This guide covers the kinds of remote servers you can rent or build, how to connect to one, the first things to secure, and the ways to get your applications running on it.

## What a remote server means in practice

"Remote" describes how you reach the machine, not what it is. A server is remote when you control it through a network connection: a shell over SSH, a web dashboard, an API. You never plug in a keyboard.

Most remote servers that developers use have a few things in common:

- **A public IP address**, so browsers and other servers can connect to it.
- **A Linux operating system**, typically Ubuntu or Debian, with no desktop.
- **SSH access** for administration, authenticated with a key pair.
- **Always on**, with power and network handled by whoever runs the data center.

The term covers a wide range, from a 2 GB virtual machine to a rack of dedicated hardware.

## Types of remote servers

| Type | What you get | Good for | Watch out for |
| --- | --- | --- | --- |
| VPS (virtual private server) | A virtual machine with a share of a host's CPU, memory and disk | Most web apps, side projects, small teams | Shared CPU can vary under neighbors' load |
| Cloud instance | A VM on a large cloud with APIs, managed networking and many extra services | Teams that need autoscaling groups, managed databases, many regions | Billing complexity, egress charges |
| Dedicated server | A whole physical machine | Heavy, steady workloads, large databases, builds | Longer setup, hardware failures are yours to plan for |
| Colocation | Your own hardware in someone else's data center | Full control with professional power and network | Upfront cost, remote hands for repairs |
| Home server | A machine in your home that you reach over the internet | Homelabs, learning, private services | Residential IPs, power and ISP limits |

For a first deployment, a VPS is almost always the right starting point. It is cheap, you can resize it later, and providers let you snapshot and rebuild it in minutes. If you are in Europe, our guide on [choosing a VPS in Europe](/blog/choosing-a-vps-in-europe/) covers locations, data protection and what to compare. If you have hardware at home, see [homelab self-hosting](/blog/homelab-self-hosting/).

## What you can run on a remote server

Anything you can run on Linux:

- Web apps and APIs in any language.
- Databases such as Postgres, MySQL or Redis.
- Background workers, cron jobs and queues.
- Self-hosted tools: analytics, wikis, Git servers, monitoring, password managers.
- Game and voice servers.
- Development environments you reach from any laptop.

Containers make this easier, because each app brings its own runtime and libraries. One server can run a dozen unrelated apps without them clashing.

## How to connect to a remote server

You connect with SSH, the Secure Shell. It encrypts the session and authenticates you with a key pair: a private key that stays on your machine and a public key you place on the server.

Create a key if you do not have one:

```bash
ssh-keygen -t ed25519 -C "you@example.com"
```

Most providers let you paste the public key (`~/.ssh/id_ed25519.pub`) when you create the server. Then connect:

```bash
ssh root@203.0.113.7
```

To skip typing the address each time, add an entry to `~/.ssh/config`:

```text
Host prod
    HostName 203.0.113.7
    User root
    IdentityFile ~/.ssh/id_ed25519
```

Now `ssh prod` is enough. The same config works for `scp` and `rsync` when you copy files.

### Reach a private port with an SSH tunnel

SSH can forward a port from the server to your laptop. This is how you open an admin page that should never be public:

```bash
ssh -L 3000:127.0.0.1:3000 prod
```

While the session is open, `http://localhost:3000` on your laptop reaches port 3000 on the server's loopback interface.

## First steps to secure a new server

A fresh server with a public IP gets scanned within minutes. Do these before you deploy anything.

### Update the system

```bash
apt update && apt full-upgrade -y
apt install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades
```

### Use keys only

Once key login works, turn off password authentication. Create `/etc/ssh/sshd_config.d/10-hardening.conf`:

```text
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
```

Then reload SSH, and test a new session before you close the current one:

```bash
sshd -t && systemctl reload ssh
```

### Close every port you do not need

Use your provider's firewall, which filters traffic before it reaches the machine. A web server typically needs:

| Port | Open to | Why |
| --- | --- | --- |
| 22/tcp | Your IP, if possible | SSH |
| 80/tcp | Everyone | HTTP and certificate validation |
| 443/tcp | Everyone | HTTPS |
| 443/udp | Everyone | HTTP/3 |

One trap catches many people: Docker publishes container ports through iptables rules that bypass UFW and firewalld. A database container started with `-p 5432:5432` is reachable from the internet even if `ufw status` says otherwise. Do not publish ports you do not mean to expose, and rely on the provider's firewall for anything you must block.

### Plan for backups

The server is not a backup of itself. Copy databases and volumes to storage somewhere else, such as an S3-compatible bucket at another provider, on a schedule, and test a restore at least once.

## How to deploy apps to a remote server

There are three common approaches, each with more automation than the last.

### 1. By hand

Copy the code, install the runtime, run it under systemd, put a reverse proxy in front for HTTPS. It works and teaches you a lot. It also means every deploy is a manual sequence, and every new app repeats it.

### 2. Docker Compose

Write a `docker-compose.yml`, copy it to the server, and run:

```bash
docker compose pull && docker compose up -d
```

Add a reverse proxy container such as Caddy or Traefik for hostnames and certificates. Our [Caddy vs Traefik vs Nginx](/blog/caddy-vs-traefik-vs-nginx/) comparison helps you pick one. This is a solid setup for a few services, though builds, rollbacks, secrets and backups are still up to you.

### 3. A self-hosted PaaS

A platform as a service on your own server gives you a Heroku-style workflow: connect a Git repository, push, and the platform builds an image, starts it, routes a domain and issues a certificate. You keep the server, the data and the bill. Read [what is a self-hosted PaaS](/blog/self-hosted-paas/) for the broader picture.

LogiStack is one of these. It is open source under Apache 2.0, runs on Docker Swarm and uses Caddy as its proxy. You install it with one command on an Ubuntu 22.04+ or Debian 12+ server with 2 GB of RAM:

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

Until you finish setup, the dashboard listens only on the server's loopback interface, and you reach it through the SSH tunnel shown above. See [Install LogiStack](/docs/getting-started/install/) for the full steps, including a dry run that changes nothing.

## When one remote server is not enough

A single server is a single point of failure, and builds compete with running apps for CPU. Common next steps:

- **Move builds or databases to their own machine.** Heavy builds stop slowing down production.
- **Add servers to a cluster.** With Docker Swarm, several servers act as one pool. LogiStack's **Add server** wizard connects over SSH once, checks the machine, installs Docker and joins it to the swarm. See [Nodes](/docs/operations/nodes/).
- **Use a private network between servers.** Most providers offer one. Keep cluster traffic (Swarm uses 2377/tcp, 7946/tcp and udp, 4789/udp) off the public interface.

![The Add server wizard in LogiStack, asking for name, address, SSH user, SSH key, role and labels](/docs/screens/node-new.webp)

## FAQ

### What is the difference between a remote server and a cloud server?

A cloud server is one kind of remote server: a virtual machine on a cloud provider's infrastructure. "Remote server" is the broader term for any machine you manage over the network, including dedicated hardware and a box in your home.

### Is a VPS a remote server?

Yes. A VPS is a virtual machine on a provider's host that you access over SSH. It is the most common type of remote server for web apps and side projects.

### How much RAM does a remote server need for web apps?

It depends on the apps, but 2 GB is a practical minimum for a server running Docker and a few small services, and 4 GB gives room for builds. Databases and build steps use the most memory, so size for those.

### Can I use my home computer as a remote server?

Yes, with limits. Home connections often have changing IPs, block inbound ports or sit behind carrier-grade NAT. Tools like Cloudflare Tunnel and Tailscale work around that without opening ports.

### Is a remote server secure by default?

No. A new server usually allows password logins and has outdated packages. Update it, switch to SSH keys only, close unused ports in the provider's firewall, and set up backups before you put data on it.

When the server is ready, the fastest way to get your apps running with HTTPS, backups and logs is to [install LogiStack](/#install) and follow its setup wizard. The [features page](/features/) shows what you get on that one server.

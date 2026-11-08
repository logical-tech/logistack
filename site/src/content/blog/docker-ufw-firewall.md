---
title: "Docker and UFW: why published ports bypass your firewall"
description: "Why Docker published ports bypass UFW, how to check what is exposed, and four fixes that work, from internal networks to DOCKER-USER rules and cloud firewalls."
date: 2026-11-08
category: Security
keywords: docker ufw, docker bypasses ufw, docker firewall, docker-user chain, ufw docker published ports
---

You ran `ufw default deny incoming`, allowed SSH, 80 and 443, and `ufw status` looks perfect. Then a scanner finds your Postgres on port 5432, open to the internet, because a compose file said `ports: ["5432:5432"]`. This is not a bug in UFW and not a misconfiguration on your part. It is how Docker networking works: Docker published ports bypass UFW. This guide explains why, shows how to check what your server actually exposes, and walks through four fixes, with the trade-offs of each and the special cases for Docker Swarm.

## Why Docker bypasses UFW

UFW is a front end for iptables. It manages rules in the `INPUT` chain, which handles traffic addressed to the host itself. When you publish a container port, Docker adds a NAT rule that rewrites the destination to the container's private IP. From that moment the packet is no longer addressed to the host. It is **forwarded** to a container, so it goes through the `FORWARD` chain, where Docker's own rules accept it. UFW's `INPUT` rules never see it.

```text
packet to 203.0.113.7:5432
  └─ nat PREROUTING ─ DOCKER chain: DNAT to 172.18.0.5:5432
       └─ filter FORWARD ─ DOCKER-USER (empty) ─ DOCKER: ACCEPT
            └─ container            (UFW's INPUT rules: never consulted)
```

`ufw deny 5432` adds a rule to `INPUT`. The packet takes the `FORWARD` path. The deny does nothing.

The same applies to firewalld, which gets a `docker` zone of its own, and to any host firewall that only filters `INPUT`.

## Check what you actually expose

Do not trust `ufw status` for container ports. Look at what Docker publishes, then test from outside.

List published ports on the host:

```bash
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```

A line like `0.0.0.0:5432->5432/tcp` means every interface, including the public one. `127.0.0.1:5432->5432/tcp` means only the host itself.

On Swarm, check services too, since the routing mesh publishes on every node:

```bash
docker service ls --format 'table {{.Name}}\t{{.Ports}}'
```

Then test from a different machine, which is the only test that counts:

```bash
nmap -Pn -p 1-65535 --min-rate 2000 203.0.113.7
nc -vz 203.0.113.7 5432
```

Anything open that you did not mean to serve is a finding.

## Fix 1: do not publish internal ports

The best fix is to not need one. Containers on the same Docker network reach each other by service name without any published port. Only the reverse proxy needs to publish 80 and 443.

```yaml
services:
  proxy:
    image: caddy:2.10
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    networks: [web]
  app:
    image: ghcr.io/acme/app:2026.11.08
    environment:
      DATABASE_URL: postgres://app:${PG_PASSWORD}@db:5432/app
    networks: [web, data]
  db:
    image: postgres:17
    # no "ports:" at all
    networks: [data]
networks:
  web:
  data:
    internal: true
```

The database is reachable as `db:5432` from the app and from nowhere else. `internal: true` also stops the database container from making outbound connections. Our guide to [Docker networking](/blog/docker-networking/) covers networks and service discovery in detail.

When you need to reach the database from your laptop, use an SSH tunnel instead of a published port:

```bash
ssh -L 5432:localhost:5432 deploy@203.0.113.7
```

This needs the port bound on the host's loopback, which brings us to the second fix.

## Fix 2: bind to loopback

Publish on `127.0.0.1` and the port exists only for processes on the host and for SSH tunnels:

```yaml
services:
  db:
    image: postgres:17
    ports:
      - "127.0.0.1:5432:5432"
```

Simple and effective with plain Docker and Docker Compose. Two caveats:

- **Docker Swarm services cannot bind to a host IP.** Swarm's `ports` syntax has no address field, so a Swarm service publishes on every interface or not at all. On Swarm, use fix 1, 3 or 4.
- **IPv6.** Publishing without an address also binds `[::]` when IPv6 is enabled in Docker. Binding to `127.0.0.1` avoids that, but check `docker ps` output for `[::]:` entries elsewhere.

You can make loopback the default for every port published without an address, in `/etc/docker/daemon.json`:

```json
{
  "ip": "127.0.0.1"
}
```

After `sudo systemctl restart docker`, `-p 8080:80` binds to loopback only, and you have to write `0.0.0.0:80:80` explicitly to go public. This affects only plain containers, not Swarm services.

## Fix 3: filter in the DOCKER-USER chain

Docker creates an empty `DOCKER-USER` chain and jumps to it from `FORWARD` before its own rules. It never flushes it. That makes it the supported place to filter traffic to containers. You can manage it from UFW's `after.rules` file so it loads with UFW and survives reboots.

First find your public interface name:

```bash
ip route get 1.1.1.1 | grep -oP 'dev \K\S+'
# eth0, ens3, enp1s0 ...
```

Then append this block to the end of `/etc/ufw/after.rules`, replacing `eth0`:

```text
# BEGIN docker-user
*filter
:DOCKER-USER - [0:0]
-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
-A DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 80 --ctdir ORIGINAL -j RETURN
-A DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 443 --ctdir ORIGINAL -j RETURN
-A DOCKER-USER -i eth0 -p udp -m conntrack --ctorigdstport 443 --ctdir ORIGINAL -j RETURN
-A DOCKER-USER -i eth0 -s 198.51.100.10 -j RETURN
-A DOCKER-USER -i eth0 -j DROP
-A DOCKER-USER -j RETURN
COMMIT
# END docker-user
```

What each line does:

- **Established traffic returns** to Docker's rules, so replies to connections your containers open keep working.
- **Ports 80 and 443** from the internet are allowed through to containers.
- **One trusted address** (an office or a monitoring host) can reach every published port. Remove the line if you do not need it.
- **Everything else arriving on the public interface is dropped** before it reaches a container.
- **Traffic from other interfaces** (container to container, a private network between your servers) returns untouched.

Why `--ctorigdstport` and not `--dport`? By the time a packet reaches `FORWARD`, Docker's NAT has already rewritten its destination port to the container's port. Conntrack remembers the original port the client asked for, which is the one you care about.

Apply and check:

```bash
sudo ufw reload
sudo iptables -L DOCKER-USER -n -v
```

Then repeat the external scan. Port 5432 should now be filtered even though Docker still publishes it.

Notes before you rely on it:

- **These rules affect only forwarded traffic.** SSH and anything else the host itself serves still go through UFW's normal `INPUT` rules, so you cannot lock yourself out of SSH with this block.
- **IPv6 needs the same block** in `/etc/ufw/after6.rules` with `ip6tables` semantics, if Docker has IPv6 enabled.
- **It works with the Swarm routing mesh**, because mesh traffic is also forwarded through `FORWARD` and passes `DOCKER-USER`.
- The open-source `ufw-docker` script automates a similar setup with `ufw route allow` commands, if you prefer managing rules through the `ufw` CLI.

## Fix 4: the provider's firewall

Cloud firewalls (security groups, Hetzner Cloud Firewalls, DigitalOcean Cloud Firewalls and the like) filter traffic before it reaches your server. Docker cannot bypass what never arrives. Allow 22, 80 and 443 there, plus the specific ports a service really needs, and keep the host firewall as a second layer.

This is the easiest fix to get right and the hardest to get wrong later, because no `docker run -p` on the host can widen it. Its limits: not every provider offers one, and rules are per provider, so multi-cloud setups need one set per cloud.

## What not to do: disable Docker's iptables

You will find advice to set `"iptables": false` in `daemon.json`. Docker then stops writing firewall rules, and UFW controls everything. It also breaks container networking: containers lose outbound internet access, published ports stop working, and Swarm overlay networks fail, unless you rebuild NAT and forwarding rules by hand. It trades a clear problem for many obscure ones. Avoid it.

## Choosing a fix

| Fix | Works on Swarm | Effort | Protects against future mistakes |
| --- | --- | --- | --- |
| No published internal ports | Yes | Low | Only if everyone follows it |
| Bind to `127.0.0.1` | No | Low | With `"ip": "127.0.0.1"` as default |
| DOCKER-USER rules | Yes | Medium | Yes, for anything not on the allow list |
| Provider firewall | Yes | Low | Yes |
| `"iptables": false` | No | High | Breaks networking |

A sound default for most servers: publish only the reverse proxy, run everything else on internal networks, and put a provider firewall in front. Add DOCKER-USER rules when you have no provider firewall or need host-level control. Our [secure a new VPS](/blog/secure-a-new-vps/) checklist covers the rest of the host.

## How LogiStack handles it

LogiStack is an open-source, self-hosted PaaS on Docker Swarm, and its layout follows fix 1. Caddy holds 80 and 443 and routes each domain to its service over an internal overlay network, so apps with a domain need no published port. Each environment has its own private network, and a managed database is reachable only inside its environment, by its service name. The [install docs](/docs/getting-started/install/) and [networking overview](/docs/networking/) state the bypass plainly: a published port is open to the internet even if UFW says it is closed.

![LogiStack network map showing services, their networks and published ports](/docs/screens/network.webp)

When a service does need a published port, for a game server or an SMTP relay, you choose in its settings whether it binds on the node that runs it or on every node through the routing mesh. The [network map](/docs/networking/network-map/) lists every published port on one diagram, which is a quick way to audit what is exposed. For servers that should have no inbound ports at all, [Cloudflare Tunnels](/docs/networking/cloudflare-tunnels/) publish services through an outbound connection.

LogiStack's installer does not change your firewall, so the fixes above still apply to anything you publish yourself.

## FAQ

### Why does Docker bypass UFW?

UFW filters the `INPUT` chain, for traffic addressed to the host. Docker rewrites the destination of published ports to the container's IP, so the traffic is forwarded through the `FORWARD` chain, where Docker's rules accept it before UFW sees it.

### How do I block a Docker published port with UFW?

Add rules to the `DOCKER-USER` chain, for example through `/etc/ufw/after.rules`, matching the original destination port with `--ctorigdstport`. Simpler alternatives are not publishing the port, binding it to `127.0.0.1`, or blocking it at your provider's firewall.

### Does this also affect firewalld?

Yes. Docker adds its own zone and rules, and published ports are reachable regardless of your firewalld zones. The same fixes apply: avoid publishing, use `DOCKER-USER`, or filter at the provider.

### Can I bind a Docker Swarm service to 127.0.0.1?

No. Swarm's port publishing has no host address option, so a published Swarm port listens on every interface. Use internal overlay networks, `DOCKER-USER` rules or a provider firewall instead.

### Is it safe to set iptables to false in Docker?

It closes the bypass but breaks outbound access, published ports and Swarm overlay networking unless you write the NAT rules yourself. For most servers it causes more problems than it solves.

If you want a layout where only the proxy is public and databases never need a published port, [install LogiStack](/#install) on your hardened server.

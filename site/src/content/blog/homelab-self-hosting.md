---
title: "Homelab self-hosting: build a container server at home"
description: "Homelab self-hosting with containers: pick hardware, handle CGNAT and dynamic IPs with tunnels or Tailscale, get HTTPS, and keep backups off-site."
date: 2026-11-08
category: Self-hosting
keywords: homelab self-hosting, homelab containers, self-host at home, cloudflare tunnel homelab, tailscale homelab, raspberry pi docker server
---

You have a spare mini PC, a list of apps you would rather run yourself, and a home connection that was never designed to host anything. The router blocks inbound traffic, your public IP changes, and your provider may not even give you a public IP at all. Homelab self-hosting is mostly about solving those three problems cleanly, then running your apps in containers so the machine stays easy to rebuild.

This guide covers hardware, the operating system, the networking options for reaching services from outside, HTTPS, backups, and how to grow from one box to several. It uses LogiStack as the example platform, but the ideas apply to any container setup.

## What a homelab is good for

A homelab is a server, or a few, that you run at home for your own use. Typical reasons:

- **Private services** you do not want on someone else's cloud: photos, documents, password manager, home automation.
- **Learning** Linux, containers, networking and clustering on real hardware.
- **Staging** for apps you later deploy to a VPS.
- **Always-on tools** like media servers, ad blockers, Git servers and dashboards.

It is not a great home for a public business site. Residential connections have weaker uptime guarantees, upload bandwidth is often limited, and a power cut takes everything down. For that, rent a server: see [choosing a VPS in Europe](/blog/choosing-a-vps-in-europe/).

## Choose the hardware

You do not need a rack. Most homelabs start with one quiet, low-power machine.

| Option | Strengths | Trade-offs |
| --- | --- | --- |
| Mini PC (recent low-power x86) | Small, quiet, low power, x86 compatibility, NVMe slot | Limited expansion, usually one disk |
| Used office small-form-factor PC | Cheap, more RAM slots and drive bays | Larger, draws more power |
| Raspberry Pi or other Arm board | Very low power, silent | arm64 only, boot from SSD rather than an SD card for reliability |
| Old laptop | Free if you have one, built-in battery as a mini UPS | Fans, heat, limited storage |
| Tower server or NAS | Many drives, ECC memory on some models | Noise, power, cost |

For a container host, prioritize in this order:

1. **RAM.** 8 GB is comfortable for a dozen small services. LogiStack itself needs at least 2 GB.
2. **An SSD or NVMe drive.** Databases and container images on spinning disks or SD cards feel slow and wear out SD cards fast.
3. **Wired Ethernet.** Wi-Fi works, but a cable removes a whole class of problems.
4. **Low idle power.** The machine is on all day, every day.

Arm boards work well as long as your images publish an `arm64` variant. LogiStack runs on amd64 and arm64, and can build images for either platform.

## Install the operating system

Use a server distribution without a desktop. Ubuntu Server 22.04 or later and Debian 12 or later are well supported by Docker and by LogiStack's installer.

During installation:

- Give the machine a fixed address, either statically or with a DHCP reservation on your router.
- Enable the OpenSSH server and add your public key.
- Skip extra packages. Containers bring their own dependencies.

If you want to run several isolated systems on one box, install a hypervisor such as Proxmox VE first and put your container host in a VM. That makes snapshots and experiments easy, at the cost of some RAM.

## Install the platform

On the server, run the installer. On a home network, pass the LAN address explicitly if the machine has more than one interface:

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash -s -- --advertise-addr 192.168.1.20
```

Until setup is done, the dashboard is reachable only through an SSH tunnel from your laptop:

```bash
ssh -L 3000:127.0.0.1:3000 you@192.168.1.20
```

Then open `http://localhost:3000` and follow the setup wizard. The [install guide](/docs/getting-started/install/) covers requirements, the dry run and every flag.

## Reach your services from outside

This is the part that makes homelabs different from a VPS. You have three good options, and you can combine them per service.

### Option 1: port forwarding and dynamic DNS

The classic setup: forward ports 80 and 443 on your router to the server, and keep a DNS record updated with your current public IP through a dynamic DNS client.

It works when:

- Your ISP gives you a real public IPv4 address, not one shared through carrier-grade NAT (CGNAT).
- Your ISP does not block inbound ports 80 and 443.

Check for CGNAT by comparing the WAN address your router shows with the address a site like `ifconfig.me` reports:

```bash
curl -4 ifconfig.me
```

If they differ, or the router's WAN address is in `100.64.0.0/10`, you are behind CGNAT and port forwarding will not reach you.

Port forwarding also puts your home IP in public DNS and exposes your router to the internet. Keep only 80 and 443 open, and never forward database or admin ports.

### Option 2: Cloudflare Tunnel

A Cloudflare Tunnel needs no open inbound port at all. A small `cloudflared` process on your server dials out to Cloudflare and keeps the connection open. Visitors reach Cloudflare's edge, which sends each request down the tunnel to your server.

It works behind CGNAT, with dynamic IPs, and with ISPs that block inbound ports. Your home IP never appears in DNS. The trade-offs:

- Your domain's DNS must be on Cloudflare.
- Cloudflare terminates TLS at its edge, so it sees your traffic in clear text.
- Every request reaches your server from `cloudflared`, so IP-based allow lists on your side no longer see the visitor's address.

In LogiStack, Cloudflare Tunnels are a built-in integration. You connect Cloudflare as a DNS provider, create a tunnel in a wizard, and choose per domain whether it goes through the tunnel or the public proxy. LogiStack runs `cloudflared` in the swarm and creates the proxied CNAME for you. See [Cloudflare Tunnels](/docs/networking/cloudflare-tunnels/).

![LogiStack's Cloudflare Tunnels page with a Create tunnel button](/docs/screens/tunnels.webp)

### Option 3: Tailscale for private access

Many homelab services should never be public at all: the router admin page, Grafana, a database UI, your file server. Tailscale builds a private WireGuard network, a tailnet, between your own devices. A service published on the tailnet is reachable from your phone and laptop anywhere, and from nobody else.

LogiStack's Tailscale integration runs `tailscaled` on every server so each one joins your tailnet, and lets you publish a chosen service on its own tailnet hostname, such as `https://grafana.<your-tailnet>.ts.net`, with a certificate from Tailscale. It uses userspace networking, so it needs no TUN device on the host. See [Tailscale](/docs/networking/tailscale/).

### Which option to use

| You want to | Use |
| --- | --- |
| Reach admin tools only from your own devices | Tailscale |
| Share an app publicly from behind CGNAT or a blocked port | Cloudflare Tunnel |
| Serve publicly with your own TLS and a real public IP | Port forwarding and dynamic DNS |
| Keep a service internal to other services | Nothing, keep it on the internal network |

A sensible default: Tailscale for everything private, a tunnel for the few things you share, and no open ports on the router.

## HTTPS at home

If you use port forwarding, the proxy can get certificates from Let's Encrypt over HTTP-01, which needs port 80 reachable from the internet. If port 80 is blocked or you are behind CGNAT, use the DNS-01 challenge instead: the proxy proves control of the domain by writing a TXT record through your DNS provider's API. DNS-01 also issues wildcard certificates, so one certificate covers every service.

LogiStack supports DNS-01 with Cloudflare, Route 53, Hetzner DNS, DigitalOcean, OVHcloud and Porkbun. Tunnel domains get their certificate from Cloudflare's edge, and Tailscale publications get theirs from Tailscale.

Avoid relying on free wildcard DNS names like sslip.io for anything you keep. They share one Let's Encrypt budget with every other user, which our article on [Let's Encrypt rate limits](/blog/lets-encrypt-rate-limits/) explains.

## Backups: get the data out of the house

Your homelab sits in one building, on one power circuit, often on one disk. Plan for losing all of it.

- **Back up databases and volumes on a schedule** to S3-compatible storage outside your home. LogiStack encrypts backups before they leave the server and sends them to destinations such as Cloudflare R2, Backblaze B2, AWS S3 or MinIO. See [Backups](/docs/data/backups/).
- **Test restores.** LogiStack can run a scheduled restore check into a throwaway container and report whether it worked.
- **Keep the credentials file safe.** The installer writes `/etc/logistack/credentials`, which holds the master key that encrypts your secrets. Store a copy in your password manager.
- **Add a small UPS** if power cuts are common. A clean shutdown protects databases and disks.

## Grow from one box to a small cluster

When one machine runs out of memory, add another rather than replacing it. LogiStack runs on Docker Swarm, so several machines act as one pool. The **Add server** wizard connects over SSH once, checks the machine, installs Docker, joins it to the swarm and starts the agent.

On a home network, the Swarm ports (2377/tcp, 7946/tcp and udp, 4789/udp) only need to be open between your machines, never on the router. Node labels let you pin a database to the box with the fast SSD and keep builds off the low-power one.

## FAQ

### What is the best hardware for a homelab?

For most people, a low-power mini PC with 16 GB of RAM and an NVMe drive. It is quiet, cheap to run and has enough headroom for many containers. A Raspberry Pi works for lighter loads if your images support arm64.

### Can I self-host behind CGNAT?

Yes. Port forwarding will not work, but a Cloudflare Tunnel or Tailscale does, because both make outbound connections from your server. Use DNS-01 for any certificates you issue yourself.

### Is it safe to expose a homelab to the internet?

It can be, with care. Prefer a tunnel over open ports, keep admin tools on a private network like Tailscale, put authentication in front of anything public, and keep the system updated. Never forward database or SSH ports from the router.

### Do I need Kubernetes for a homelab?

No. Kubernetes is a great learning project, but it adds a lot to run for a few services. Docker Compose or Docker Swarm covers most homelabs. Read [Docker Swarm vs Kubernetes](/blog/docker-swarm-vs-kubernetes/) for the trade-offs.

### How much power does a homelab use?

It depends on the hardware. Mini PCs and Arm boards draw little at idle, while old towers and servers with many drives draw much more. Measure with a plug-in power meter before deciding what stays on all day.

If you want your homelab to feel like a hosted platform, with Git deploys, one-click templates, tunnels and Tailscale in the same dashboard, [install LogiStack](/#install) on your first box and add the next one when you need it.

---
title: "Choosing a VPS in Europe for self-hosting your apps"
description: "Choosing a VPS in Europe: compare location, data protection, CPU, disk, IPv4 and providers, and size a server for a self-hosted PaaS like LogiStack."
date: 2026-11-08
category: Self-hosting
keywords: vps europe, choosing a vps, best vps europe, gdpr vps hosting, eu vps provider, self-hosting vps
---

You have decided to run your apps on your own server, your users are mostly in Europe, and now you face a page of providers that all claim fast NVMe and great value. Choosing a VPS in Europe is less about finding the single best host and more about matching a few concrete criteria to your situation: where your users are, which law your data falls under, what your workload needs, and how much of the server's care you want to own.

This guide walks through those criteria, compares well-known European and international providers by stable facts, and shows how to size a server for a self-hosted platform. It does not list prices, because they change often and differ by region. Check each provider's pricing page on the day you buy.

## Start with your users and your data

Two questions narrow the field before you look at specs.

**Where are your users?** Latency grows with distance. A server in Frankfurt, Amsterdam or Paris reaches most of Western and Central Europe quickly. A server in Helsinki is a good fit for the Nordics and the Baltics. If your users are spread across Europe, a central location is the safe default.

**Which rules apply to your data?** If you process personal data of people in the EU, the GDPR applies to you wherever the server is. Hosting inside the EU or EEA keeps data transfers simple. Some teams also prefer a provider headquartered in the EU, because a company based elsewhere can be subject to its home country's laws on data access even when the machine is in Frankfurt. This is a judgment call for your legal adviser, not a technical one, but it is worth deciding early because it rules providers in or out.

## What to compare between VPS providers

| Criterion | What to check | Why it matters |
| --- | --- | --- |
| Data center locations | Countries and cities, not just "EU" | Latency, data residency, redundancy across sites |
| Company jurisdiction | Where the provider is headquartered | Which laws apply to the provider itself |
| CPU type | Shared or dedicated vCPU, x86 or Arm | Consistent performance for builds and databases |
| Memory | GB per plan, ability to resize | The usual limit for containers and builds |
| Disk | NVMe or SSD, size, local or network storage | Database speed, image and build cache space |
| Traffic | Included transfer and overage policy | Surprise bills on busy sites or large downloads |
| IPv4 and IPv6 | Whether IPv4 is included or billed separately | Cost and compatibility |
| Private networking | Free private network between servers | Safe cluster traffic for multi-server setups |
| Firewall | A network firewall in the control panel | Blocking ports before traffic reaches the VM |
| Snapshots and backups | Availability and how they are billed | Fast recovery from a bad upgrade |
| Provisioning | Cloud-init user data, API, Terraform | Rebuilding servers without manual steps |
| DNS API | Whether the provider runs DNS with an API | Automated DNS records and wildcard certificates |

### Shared or dedicated vCPU

Most entry plans use shared vCPUs: you get time on physical cores that other customers also use. For web apps that spend most of their time waiting on the network or the database, that is fine. For long builds, CPU-heavy workers or busy databases, dedicated vCPU plans give consistent performance. A common pattern is a shared plan for the app server and a dedicated one for the build or database node.

### x86 or Arm

Several European providers now offer Arm servers, often with more cores or memory for the money. Most popular images publish both `amd64` and `arm64` variants, but check yours. If you build your own images, make sure your build pipeline produces the architecture your server runs.

### Disk

Local NVMe is the fastest option and the right one for databases. Network block storage survives the VM and is easy to resize, but it is usually slower. Leave room for container images and build caches, which grow faster than most people expect.

### IPv4

Some providers bill a public IPv4 address separately from the server, and some let you run IPv6-only to save it. IPv6-only works for many cases, but some clients, APIs and services still expect IPv4. For a first server, keep an IPv4 address.

## European VPS providers at a glance

The table describes providers by their headquarters and general focus. It is not a ranking, and every provider listed runs data centers in Europe.

| Provider | Headquartered in | Known for |
| --- | --- | --- |
| Hetzner | Germany | Cloud servers in Germany and Finland, x86 and Arm plans, dedicated servers, a DNS service with an API |
| OVHcloud | France | VPS, public cloud and dedicated servers across many European countries, its own DNS |
| Scaleway | France | Cloud instances in Paris, Amsterdam and Warsaw, plus managed services |
| IONOS | Germany | VPS and cloud servers aimed at small businesses |
| netcup | Germany | VPS and root servers with generous resources |
| UpCloud | Finland | Cloud servers with fast storage in several European cities |
| Infomaniak | Switzerland | Cloud servers in Switzerland, sustainability focus |
| Exoscale | Switzerland | Cloud servers in several European zones |
| DigitalOcean, Vultr, Akamai (Linode) | United States | Simple cloud VMs with European regions, wide documentation |

Every one of these can run a self-hosted platform. The US-headquartered providers are a good choice if you want global regions from one account and jurisdiction is not a concern for you. The European ones are the natural fit if you prefer an EU or Swiss company.

## How to size a VPS for a self-hosted PaaS

A self-hosted PaaS runs its own services next to your apps: a control plane, a database for its state, a proxy, and builds when you deploy from Git. Size for all of them.

LogiStack, for example, needs at least 2 GB of RAM and 10 GB free disk on Ubuntu 22.04+ or Debian 12+, on amd64 or arm64. Practical starting points:

| Use | vCPU | RAM | Disk |
| --- | --- | --- | --- |
| Trying it out, a couple of small apps | 2 | 2 to 4 GB | 40 GB |
| A small team, several apps, Git builds | 2 to 4 | 4 to 8 GB | 80 GB |
| Many apps plus databases | 4 to 8 | 8 to 16 GB | 160 GB or more |

Builds use more memory than running apps, so leave headroom if you build large projects on the same server. When one machine is not enough, add a second one and move builds or databases there instead of buying one large server.

## Test a new server before you commit

Most providers bill by the hour, so spin up a server and measure before moving production to it.

```bash
# What you actually got
nproc && free -h && df -h /

# CPU
sudo apt install -y sysbench fio mtr-tiny
sysbench cpu --threads="$(nproc)" --time=30 run

# Random disk I/O, the number databases care about
fio --name=randrw --filename=/root/fio.test --size=1G --rw=randrw \
    --bs=4k --iodepth=32 --direct=1 --ioengine=libaio \
    --runtime=60 --time_based --group_reporting
rm /root/fio.test

# Latency from the server to a host your users or APIs use
mtr -rwc 20 example.com
```

Run the same commands on two or three candidates at the same time of day. Also run `mtr` from your own location toward the server's IP to see what your users will feel.

## Set up the server for LogiStack

Most providers on the list accept cloud-init user data when you create a server. Paste this into the **User data** or **Cloud config** field and LogiStack installs during the first boot:

```yaml
#cloud-config
runcmd:
  - curl -fsSL https://stack.logicaltech.it/install.sh | bash -s -- --yes
```

Then open these ports in the provider's firewall:

| Port | Open to |
| --- | --- |
| 22/tcp | Your IP |
| 80/tcp, 443/tcp, 443/udp | Everyone |

If you later add servers, attach them to the provider's private network and allow the Swarm ports (2377/tcp, 7946/tcp and udp, 4789/udp) only between your nodes. The [install guide](/docs/getting-started/install/) and [Nodes](/docs/operations/nodes/) pages cover both steps.

If your provider runs DNS with an API that LogiStack supports (Hetzner DNS, OVHcloud, DigitalOcean, Cloudflare, Route 53 or Porkbun), connect it in the setup wizard. LogiStack then creates the records for a per-server wildcard and issues one wildcard certificate for every generated hostname. See [Per-server wildcard DNS](/docs/networking/wildcard-dns/) and why it matters in [Let's Encrypt rate limits](/blog/lets-encrypt-rate-limits/).

## Keep backups at a second provider

A snapshot at the same provider protects you from a bad upgrade, not from an account problem or a data center incident. Send database and volume backups to S3-compatible storage at a different company. LogiStack schedules encrypted backups to any S3 destination, such as Cloudflare R2, Backblaze B2, AWS S3 or MinIO. See [Backups](/docs/data/backups/).

## FAQ

### Which country is best for a VPS in Europe?

Germany, the Netherlands and France host the most data centers and sit close to most European users, so they are safe defaults. Pick Finland or Sweden for Nordic users, and Switzerland if you want a Swiss provider. Measure latency from where your users are before deciding.

### Is a cheap VPS good enough for production?

Often, yes, for web apps with modest traffic. Shared vCPUs and network storage are the usual weak points, so test CPU and disk with your own workload. Keep backups off the server whatever you pay.

### Do I need a GDPR-compliant VPS provider?

You need a provider that signs a data processing agreement and handles data in line with the GDPR if you store personal data of EU residents. Most providers in this guide offer one. Whether you also need an EU-headquartered company depends on your own risk assessment.

### How much RAM do I need for Docker apps?

Plan around 2 GB as the minimum for a server running Docker plus a platform like LogiStack, and 4 GB or more if you build images on the same machine. Each database and app adds its own share on top.

### Can I move to another provider later?

Yes, if your setup is reproducible. Keep apps in containers, deploy from Git, and back up data to storage outside the provider. Then a move is a new server, a restore and a DNS change.

Once you have picked a server, [install LogiStack](/#install) with one command and deploy your first app from Git. If you are still weighing the bigger picture, read [what is a remote server](/blog/what-is-a-remote-server/) or browse the [features](/features/).

---
title: "Best European PaaS: EU-hosted and self-hosted options"
description: "Compare the best European PaaS options for data residency: EU-headquartered platforms like Clever Cloud and Scalingo, plus self-hosted PaaS on EU servers."
date: 2026-11-08
category: Comparisons
keywords: european paas, best european paas, eu paas, gdpr paas, eu data residency hosting, european heroku alternative
---

A customer contract says personal data must stay in the EU. Your legal team asks who can access the database, not just where it sits. Or you would simply rather pay a European company. Each of these sends you looking for the best European PaaS, and the answer depends on which question you are really asking: where the data lives, which company controls it, or both. This guide separates those questions, compares EU-headquartered platforms, and covers the option that answers all of them at once: a self-hosted PaaS on a European server.

## Region, company and jurisdiction are different things

Most large platforms offer a Frankfurt or Paris region. That solves **data location**, and for many teams it is enough. It does not change **who controls the data**. A provider headquartered in the US remains subject to US law, such as the CLOUD Act, which can require it to hand over data it controls even when that data is stored in Europe.

So there are three levels to choose from:

1. **EU region of a non-EU provider.** Data is stored in the EU. The company is not European.
2. **EU-headquartered provider.** Data in the EU, operated by a European company under European law. Check where its own infrastructure comes from, since some European platforms run on US hyperscalers.
3. **Self-hosted on an EU server.** You run the platform on a server from a European host. The platform vendor never holds your data at all.

None of this is legal advice. Your data protection officer decides which level your contracts and risk need. This guide helps you know what each option actually offers.

## What to check in a European PaaS

| Question | Why it matters |
| --- | --- |
| Where is the company headquartered? | Decides which law applies to the operator |
| Whose data centers does it run on? | An EU platform on a US cloud inherits part of that cloud's exposure |
| Which regions can you pick? | Some contracts name a specific country |
| Is there a DPA and a sub-processor list? | Required under GDPR for any processor |
| Certifications | ISO 27001, health data hosting (HDS in France), SecNumCloud for French public sector |
| Exit path | Standard containers and Postgres dumps make leaving possible |

## European PaaS providers compared

| Platform | Headquartered in | Infrastructure | Model | Good fit |
| --- | --- | --- | --- | --- |
| Clever Cloud | France | Its own data centers in France; SecNumCloud zone via Cloud Temple | Managed PaaS | Regulated workloads, wide runtime support |
| Scalingo | France | European data centers; Outscale SecNumCloud region | Managed PaaS | Heroku-style apps, health data |
| Upsun (formerly Platform.sh) | Founded in France | Regions in Germany, Ireland, Sweden, France and Switzerland on several cloud providers | Managed PaaS, Git-driven environments | Agencies, PHP and CMS projects, many environments |
| Koyeb | France | Regions in Europe, the US and Asia | Serverless containers and GPUs | Spiky APIs, inference |
| Sliplane | Germany | European infrastructure | Managed container hosting | Simple Docker apps at a flat price |
| Scaleway | France | Its own data centers in Paris, Amsterdam and Warsaw | Cloud with serverless containers | Teams wanting a full EU cloud |
| LogiStack (self-hosted) | Italy | Any server you choose | Self-hosted PaaS | Full control, fixed cost, data never leaves your server |

Facts in this table come from each vendor's own site as of November 2026. Check them again before you sign, since ownership and regions change.

## Managed European PaaS options

### Clever Cloud

Clever Cloud is a French PaaS that runs on its own data centers in France and is expanding its Paris region to five availability zones. It supports a long list of runtimes, from Node.js, Python, PHP, Ruby and Java to Go, Rust, Elixir, Haskell and Docker, and manages PostgreSQL, MySQL, MongoDB, Redis, Elasticsearch and more. It holds ISO 27001 and HDS certification, and offers a SecNumCloud zone through its partner Cloud Temple. It also offers on-premise and air-gapped deployments.

Pick it when you need a mature managed platform under French law with certifications a regulator recognizes.

### Scalingo

Scalingo is a French PaaS with the closest feel to Heroku: push code, it detects the language and runs it. All data centers are in Europe, and it states that no data is transferred outside the EU. Managed databases include PostgreSQL with pgvector and point-in-time recovery, MySQL, MongoDB, OpenSearch and InfluxDB. It is ISO 27001 certified, offers an HDS option and a SecNumCloud region on Outscale.

Pick it if your team liked Heroku and wants the same model under EU jurisdiction. See [Heroku alternatives](/blog/heroku-alternatives/) for the wider field.

### Upsun

Upsun, formerly Platform.sh, builds a full environment for every Git branch, including copies of the data services. That is excellent for agencies and teams with many parallel features. Its EU regions are in Germany, Ireland, Sweden and France, with Switzerland and the UK also available. The regions run on infrastructure from several cloud providers, including US-headquartered ones, so check which provider backs the region you choose if jurisdiction matters to you.

### Koyeb

Koyeb is a Paris-based serverless platform for containers and GPUs, with scale to zero and serverless Postgres. In February 2026 it announced an agreement to join Mistral AI, another French company. It fits AI inference and bursty APIs; read its current terms if you need a long-term contract.

### Sliplane

Sliplane is a Berlin-based service that runs Docker containers from GitHub or an image on European infrastructure, with managed Postgres and S3-compatible object storage. As of November 2026 its App Runtime starts at 9 euros per month. It is simple and predictable, with fewer features than a full PaaS.

### Scaleway

Scaleway, a French cloud provider, offers serverless containers alongside instances, managed databases and Kubernetes in its own data centers. It is a full cloud more than a PaaS, which suits teams that want EU infrastructure for everything and are happy to assemble the pieces.

### What about Northflank, Render and Railway?

Northflank is headquartered in the UK, which is European but outside the EU. Render, Railway, Fly.io, Vercel and Heroku are US companies, several with EU regions. They are good platforms, and for many teams an EU region is enough. They do not meet a requirement for an EU-headquartered operator.

## Self-hosted PaaS: the strongest residency answer

A self-hosted PaaS turns the question around. You rent a server from a European host, install the platform, and your code, databases and backups stay on that server and on storage you choose. The platform's authors never see your data, because they never hold it.

You pick the jurisdiction twice: once with the server provider, once with the backup destination. Hetzner, OVHcloud, Scaleway, IONOS, netcup, UpCloud and Infomaniak all run European data centers. The [guide to choosing a VPS in Europe](/blog/choosing-a-vps-in-europe/) compares them.

### LogiStack

LogiStack is an open-source PaaS under Apache 2.0, made by Logical, an Italian company. It runs on Docker Swarm with Caddy for automatic HTTPS, on Ubuntu or Debian servers with at least 2 GB of RAM.

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

What it gives you for a data residency setup:

- **Everything on your servers.** Builds run in rootless BuildKit on the server, and images can go to a built-in registry on that server.
- **Databases you host.** Postgres, MySQL, MariaDB, MongoDB, Redis and libSQL, with a table editor in the dashboard, so nobody needs a desktop client with production credentials.
- **Backups where you choose.** Encrypted with your key before they leave the server, sent to an S3-compatible bucket at a European provider, to [self-hosted S3 storage](/blog/self-hosted-s3-storage/), or to SFTP and WebDAV targets such as a storage box. See [backup destinations](/docs/data/backup-destinations/).
- **European DNS.** The Hetzner DNS integration writes records and issues wildcard certificates over DNS-01, alongside Cloudflare and Route 53. See [DNS providers](/docs/networking/dns-providers/).
- **Access control and records.** Roles per project or environment, SSO through OIDC or SAML, and an audit log of every change with secrets redacted, which helps when an auditor asks who changed what.
- **More than one server.** Add nodes in the same country, or across European locations, and Swarm places replicas on them.

Every feature is in the free build. There is no hosted LogiStack service, so there is no LogiStack account holding your data. The instance does contact GitHub to check for new releases.

The honest trade-offs: you operate the servers, including patches, monitoring and on-call. LogiStack is a young project with a smaller community than the managed platforms above. It runs on Swarm, not Kubernetes. And certifications such as ISO 27001 or HDS belong to your organization and your hosting provider, not to the software.

### Other self-hosted options

Coolify, Dokploy, CapRover and Dokku also run on any European server and keep your data there. The [self-hosted PaaS guide](/blog/self-hosted-paas/) explains how they differ.

## Managed or self-hosted?

| If you... | Choose |
| --- | --- |
| Need a certified operator (HDS, SecNumCloud) and no servers to run | Clever Cloud or Scalingo |
| Want Heroku's workflow under EU law | Scalingo |
| Run many branch environments for client projects | Upsun, after checking the region's provider |
| Run AI inference or bursty APIs | Koyeb or Scaleway |
| Want a flat price for a few containers | Sliplane |
| Want the data to never leave infrastructure you control | A self-hosted PaaS on an EU server |

## FAQ

### What is the best European PaaS?

For a managed platform with certifications, Clever Cloud and Scalingo are the most established French options. If you want complete control over where data lives and who can reach it, a self-hosted PaaS such as LogiStack on a European server is the strongest answer.

### Is an EU region of a US provider GDPR compliant?

It can be. GDPR allows processing by non-EU providers with the right contracts and safeguards. The open question is jurisdiction: a US company can be required under US law to disclose data it controls. Ask your data protection officer whether that risk is acceptable for your data.

### Is a self-hosted PaaS GDPR compliant?

The software does not make you compliant on its own. It makes compliance simpler, because you choose the server's country, the backup destination and who has access, and no extra processor sees the data.

### Which European hosting providers work with a self-hosted PaaS?

Any provider that gives you an Ubuntu or Debian server with root access, such as Hetzner, OVHcloud, Scaleway, IONOS, netcup or UpCloud.

If you want European data residency without trusting another processor, run LogiStack on a server in the country you choose. The [install guide](/docs/getting-started/install/) covers the requirements, and the [features page](/features/) lists everything that ships in the free build.

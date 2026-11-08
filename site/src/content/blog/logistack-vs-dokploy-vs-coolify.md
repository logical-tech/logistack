---
title: "LogiStack vs Dokploy vs Coolify: a fair comparison"
description: "LogiStack vs Dokploy vs Coolify compared on license, architecture, proxy, databases, multi-server support and team features, with where each one wins."
date: 2026-11-08
category: Comparisons
keywords: logistack vs dokploy vs coolify, dokploy vs coolify, coolify alternative, dokploy alternative, self-hosted paas comparison
---

You have decided to run your own PaaS, and the shortlist has three names on it. Dokploy and Coolify are the established choices with large communities. LogiStack is the newcomer, and we build it, so read this with that in mind. We have tried to make this LogiStack vs Dokploy vs Coolify comparison one you could hand to a colleague: facts from each project's own site and repository as of November 2026, the trade-offs of each, and a plain statement of where the other two are the better pick.

## The short version

- **Pick Coolify** if you want the largest community, the widest range of databases and one-click services, and a simple model where each server runs plain Docker.
- **Pick Dokploy** if you want a polished interface on Docker Swarm, a hosted version, and you are fine with SSO, audit logs and fine-grained roles being part of a paid Enterprise plan.
- **Pick LogiStack** if you want every feature, including SSO, custom roles and the audit log, in the free open-source build, and you value a design where desired state lives in a database and a reconciler keeps Docker and the proxy in line with it.

All three are free to self-host and all three deploy from Git, run databases and issue HTTPS certificates. The differences are in architecture, licensing of advanced features, maturity and community size.

## At a glance

| | LogiStack | Dokploy | Coolify |
| --- | --- | --- | --- |
| License | Apache 2.0, all code | Apache 2.0, plus a proprietary-licensed directory | Apache 2.0 |
| Paid editions | None | Hosted plans and an Enterprise plan | Hosted dashboard (Coolify Cloud) |
| Built with | TypeScript | TypeScript | PHP with Laravel |
| Container runtime | Docker Swarm services | Docker Swarm, plus standalone remote servers | Standalone Docker containers per server |
| Proxy | Caddy, configured through its admin API | Traefik | Traefik by default, Caddy optional |
| How servers connect | Swarm nodes, each with an agent dialing out over WebSocket | Remote servers over SSH, or Swarm nodes | Servers over SSH |
| Databases | Postgres, MySQL, MariaDB, MongoDB, Redis, libSQL | Postgres, MySQL, MariaDB, MongoDB, Redis, libSQL | Postgres, MySQL, MariaDB, MongoDB, Redis, Dragonfly, KeyDB, ClickHouse, SQLite (experimental) |
| Built-in database editor | Yes: tables, queries, schema, documents, keys, roles | No | No |
| Backups | Databases and volumes to any S3 destination, encrypted, with scheduled restore checks | Databases to S3-compatible storage | Databases to local disk or S3-compatible storage |
| SSO and audit log | Both included, free | Both on the Enterprise plan | OAuth and OIDC sign-in, free |
| Hosted option | No | Yes | Yes |
| Community | New and small | Large, about 38k GitHub stars | Largest, about 66k GitHub stars |

Star counts are from each repository in November 2026, rounded. Hosted pricing as listed on each vendor's pricing page in November 2026: Dokploy's Hobby plan is $4.50 per server per month and its Startup plan starts at $15 per month; Coolify Cloud is $5 per month including two servers, plus $3 for each additional server. Both hosted products manage the dashboard; your apps still run on servers you supply.

## License and what is free

All three publish their code and let you self-host for free. The differences are at the edges.

**Coolify** is Apache 2.0. Its pricing page says the self-hosted version has all features with no restrictions. The paid product is Coolify Cloud, a hosted control plane that connects to your servers.

**Dokploy** is dual-licensed: most of the repository is Apache 2.0, and anything under a `proprietary` directory falls under a separate license. Its pricing page lists SSO and SAML, SCIM provisioning, audit logs, fine-grained roles and white labeling under the Enterprise plan, which you buy through sales. If your team needs those, budget for them.

**LogiStack** is Apache 2.0 throughout, with no paid edition. SSO with OIDC and SAML, custom roles granted per organization, folder, project or environment, passkeys and enforced two-factor, and the audit log are in the build you install. Sponsors fund development.

## Architecture

This is where the three differ most, and where you should spend your reading time.

### Coolify: a control plane that drives Docker over SSH

Coolify's instance connects to each server over SSH, prepares Docker on it, and runs your resources as regular containers. Each server has its own proxy. If the Coolify instance goes down, your apps keep running; you lose automation until it comes back. The model is easy to reason about: one server is one Docker host, and you can always inspect it with plain `docker` commands. The cost is that there is no scheduler across servers. A container lives where you put it.

### Dokploy: Swarm with Traefik

Dokploy deploys applications as Docker Swarm services and uses Traefik for routing and certificates. It supports two multi-server styles: remote servers, each with its own Traefik and managed from the central UI, and Swarm nodes for scaling one app across machines. It can also use dedicated build servers that push to a registry. This gives you more scheduling options than Coolify, with Swarm's concepts to learn.

### LogiStack: desired state plus a reconciler

LogiStack also runs on Swarm, but it is built around one rule: desired state lives in Postgres, and a worker converges Docker and Caddy to it. Concretely:

- The dashboard, REST API, project manifests and MCP server only change database rows. A reconciler compares them with what Docker reports every 30 seconds, records the observed state and removes orphaned objects it created.
- It talks to Docker through the Engine API over the Unix socket, not through shell commands.
- Every build gets an immutable tag, `<registry>/<org>/<service>:<deploymentId>`, so a rollback reuses the exact image without rebuilding.
- Caddy is the only process on ports 80 and 443. LogiStack compiles all domains into one Caddy JSON config and loads it through the admin API. Certificates are stored in Redis and shared across ingress nodes, so a second ingress node doesn't request its own.
- Each node runs an agent that opens one outbound WebSocket to the API for metrics, logs, terminals, file access and volume backups. SSH is used once, to bootstrap the node.

The [architecture page](/docs/reference/architecture/) covers networks, labels and the deployment state machine in detail. The trade-off: more moving parts in the control plane (Postgres, Redis, worker, agents), in exchange for operations you can retry safely.

## Deploying apps

All three cover the basics: Git providers including GitHub, GitLab, Gitea and Bitbucket, Dockerfile builds, prebuilt images, Docker Compose, environment variables and preview deployments for pull requests.

Some differences worth knowing:

- **Builders.** Coolify builds with Nixpacks, a Dockerfile or as a static site, and Dokploy offers Nixpacks, buildpacks, Railpack and Dockerfiles. LogiStack builds with rootless BuildKit from a Dockerfile, with Railpack, or as a static site, for amd64, arm64 or both. See [Deploy from Git](/docs/deploy/from-git/).
- **Templates.** Coolify's one-click service catalog is large and well tested by its community. Dokploy has its own template set. LogiStack has a catalog of more than 500 templates with generated secrets, newer and less battle-tested.
- **Reviewing changes.** LogiStack holds changed settings as a pending diff, with secrets withheld, until you deploy them.
- **Autoscaling.** LogiStack can add and remove copies of a service by CPU load between limits you set, with a replay of the last day before you turn it on. See [Autoscaling](/docs/deploy/autoscaling/).

## Databases and backups

Coolify supports the widest range of engines, including Dragonfly, KeyDB and ClickHouse. If you need those, it is the clear choice.

LogiStack supports fewer engines but goes further with each one. Every database has an editor in the dashboard: browse and edit rows, run queries, view the schema as a diagram, browse MongoDB documents and Redis keys, and create database users with per-table permissions. Backups cover databases and volumes, are encrypted before they leave the server, and can be checked by a scheduled job that restores the latest backup into a throwaway container. See [Backups](/docs/data/backups/).

Dokploy covers the common engines with scheduled backups to S3-compatible storage, which is enough for many teams.

## Teams, security and automation

| | LogiStack | Dokploy | Coolify |
| --- | --- | --- | --- |
| Organizations or teams | Yes | Yes, limited by plan on hosted | Yes |
| Roles | Built-in and custom, per scope | Basic roles; fine-grained on Enterprise | Team roles |
| SSO | OIDC and SAML, free | Enterprise plan | OAuth providers and generic OIDC, free |
| Audit log | Yes, with diffs and export | Enterprise plan | Not listed as a feature |
| REST API | Yes, OpenAPI | Yes, plus a CLI | Yes |
| MCP server for AI agents | Built into the API at `/mcp` | Official MCP server as a separate package | Check current docs |

If your company requires SSO and an audit trail, LogiStack gives you both for free, and Dokploy gives you both on its Enterprise plan. Coolify gives you sign-in through GitHub, GitLab, Google, Azure and other OAuth providers, plus generic OIDC, at no cost.

## Maturity and community

Be realistic here. Coolify and Dokploy have years of production use, large Discord communities, many tutorials and many people who have hit your bug before you. LogiStack is new. Its documentation is thorough, but its community is small and fewer edge cases have been found in the wild. If that risk matters more to you than features, pick one of the other two.

## Moving between them

If you already run Dokploy or Coolify, LogiStack can take over the same server without a maintenance window. You install it next to the existing platform, and a wizard reads the old install, imports projects, services, databases, domains and variables, moves services one at a time with a rollback for each, and then hands ports 80 and 443 from the old proxy to Caddy with the existing certificates. Databases keep their data in place: LogiStack adopts the same Docker volumes.

```bash
# Run on the server that already has Dokploy or Coolify
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

The installer detects the existing platform and leaves its proxy in charge until you switch traffic. Read [Migrate from Dokploy](/docs/operations/migrate-from-dokploy/) or [Migrate from Coolify](/docs/operations/migrate-from-coolify/) before you start, including what does not carry over.

## LogiStack vs Dokploy vs Coolify: where each one wins

**Coolify wins on** community size, the range of database engines and one-click services, a simple per-server Docker model, and a cheap hosted dashboard.

**Dokploy wins on** a clean, mature interface on Swarm, flexible multi-server options including build servers, a hosted version, and an Enterprise plan with a sales and support relationship.

**LogiStack wins on** having every feature free, including SAML, custom roles and the audit log, a reconciler-based design where operations are idempotent, a built-in database editor, backups with restore checks, an MCP server built into the API, and a migration path from both of the others.

## FAQ

### Is LogiStack a fork of Dokploy or Coolify?

No. LogiStack is written from scratch and shares no code with either project. It takes ideas from the whole category, as each project does.

### Which is easiest to install?

All three install with one command on a fresh Linux server. LogiStack's installer runs checks first, offers a `--dry-run`, and keeps the setup page private until you finish the guided setup wizard.

### Can I run Coolify or Dokploy and LogiStack on the same server?

Only during a migration. LogiStack's Caddy needs ports 80 and 443, so the installer leaves ingress off while another platform's proxy holds them, and takes over when you switch traffic.

### Which one should a team with compliance requirements choose?

If you need SAML sign-in and an audit log without a sales contract, LogiStack includes both. If you need a vendor contract and SLA, Dokploy's Enterprise plan offers that. Coolify covers OIDC sign-in for free and fits well when an audit log is not a requirement.

Whichever you choose, you will own your servers and your data. If LogiStack's trade-offs fit your team, [install it](/#install) on a test server, or read the [features page](/features/) first to see everything that comes in the free build.

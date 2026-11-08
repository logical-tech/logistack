---
title: "Self-host Gitea or Forgejo: a private Git server with Docker"
description: "Self-host Gitea or Forgejo with Docker: choose between them, deploy with Postgres, set up SSH on a custom port, add CI runners and back up repositories."
date: 2026-11-08
category: Self-hosting
keywords: self-host gitea, forgejo docker, gitea vs forgejo, self-hosted git server, gitea docker compose, forgejo self hosted
---

Your code lives on someone else's platform, under their pricing, their outages and their policy changes. You want a private Git server you control, but GitLab wants several gigabytes of RAM just to idle. Gitea and Forgejo are the light answer: a single Go binary with repositories, pull requests, issues, packages and CI, running comfortably on a small server.

This guide helps you choose between Gitea and Forgejo, then self-host either one with Docker: the database, SSH on a custom port, the first admin account, CI runners, and backups.

## Gitea vs Forgejo: which to self-host

Forgejo started in 2022 as a soft fork of Gitea, after Gitea's domain and trademark moved to a for-profit company. In 2024 it became a hard fork with its own development. The two still look and work alike, and most of what you learn applies to both.

| | Gitea | Forgejo |
| --- | --- | --- |
| Governance | Gitea Ltd, a company, with community contributors | Community project under Codeberg e.V., a non-profit |
| License | MIT | GPLv3 or later |
| Hosted offering | Gitea Cloud and enterprise support from the company | None from the project; Codeberg runs it for open source |
| CI | Gitea Actions with `act_runner` | Forgejo Actions with Forgejo Runner |
| Federation | Not a focus | Work on ActivityPub federation in progress |
| Config env prefix | `GITEA__section__KEY` | `FORGEJO__section__KEY` |

How to pick:

- **Choose Forgejo** if non-profit, community governance matters to you, or you like that Codeberg runs it at scale every day.
- **Choose Gitea** if you want a company to buy support from, or the MIT license matters for how you distribute changes.

Both are production-ready for a team. Migrating between them is possible but gets harder as the forks diverge, so pick once and stay.

## Pick a database

Both support SQLite, PostgreSQL and MySQL or MariaDB.

- **SQLite** is fine for a personal server with a few users.
- **PostgreSQL** is the better default for a team: concurrent writes from CI, webhooks and the web interface stay fast, and a database dump gives you a consistent backup without stopping the service.

LogiStack has templates for each combination, including:

- [Gitea](/templates/gitea/) and [Forgejo](/templates/forgejo/): one container each, SQLite by default.
- [Gitea with PostgreSQL](/templates/gitea-with-postgresql/) and [Forgejo with PostgreSQL](/templates/forgejo-with-postgresql/): a managed PostgreSQL 16 database next to the forge.
- MySQL and MariaDB variants of both, if your team already runs that engine.

The rest of this guide uses the PostgreSQL variants.

## Deploy Gitea or Forgejo with Docker

On a fresh server with ports 80 and 443 open, install LogiStack:

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

Then deploy:

1. Open a project, select **New service**, then the **Templates** tile.
2. Search for `forgejo` or `gitea` and pick the PostgreSQL variant.
3. Enter your hostname in **Public URL**, for example `git.example.com`. The database user and password are generated.
4. For Forgejo, **Forgejo migrations allowed domains** can stay empty for now (see below).
5. Review and select **Deploy**, then point the DNS record at the server.

![The template gallery with a search field and category filters](/docs/screens/templates.webp)

Each template creates the forge from a pinned image (`codeberg.org/forgejo/forgejo:15`, or Gitea pinned by digest), listening on port 3000 behind Caddy, with its data in a volume at `/data`. That volume holds the Git repositories, LFS objects, attachments, avatars and the `app.ini` config. The database holds users, issues, pull requests and settings.

The Forgejo with PostgreSQL template wires the database with environment variables:

```bash
FORGEJO__database__DB_TYPE=postgres
FORGEJO__database__HOST=postgresql
FORGEJO__database__NAME=forgejo
FORGEJO__database__USER=<generated>
FORGEJO__database__PASSWD=<generated>
FORGEJO__server__ROOT_URL=https://git.example.com
FORGEJO__server__DOMAIN=git.example.com
FORGEJO__server__SSH_DOMAIN=git.example.com
FORGEJO__server__SSH_PORT=22222
```

The `FORGEJO__section__KEY` variables are written into `app.ini` on start, so you can manage the whole config from the service's **Environment** tab. The step-by-step template flow is in [Deploy an app from a template](/docs/deploy/templates/).

## SSH access on port 22222

HTTPS clones go through Caddy like any web request. SSH clones cannot, because SSH is not HTTP. Both templates publish the container's SSH port 22 on port **22222** of the node that runs it, in host mode.

Port 22 on the server stays with the host's own SSH daemon, so you do not lose admin access. Users clone with the port in the URL:

```bash
git clone ssh://git@git.example.com:22222/team/app.git
```

Or set it once in `~/.ssh/config`:

```text
Host git.example.com
  Port 22222
  User git
```

Then the short form works: `git clone git@git.example.com:team/app.git`.

Three things to check:

1. **Firewall.** Open TCP 22222 on the server and in your provider's firewall. If you use UFW, read [Docker and UFW](/blog/docker-ufw-firewall/) first, because Docker's published ports bypass UFW rules in surprising ways.
2. **Clone URLs in the interface.** Both templates set the SSH port to 22222, the SSH domain and the root URL from the hostname you enter, so the clone button shows the right URL. In Gitea these are `GITEA__server__SSH_PORT`, `GITEA__server__SSH_DOMAIN` and `GITEA__server__ROOT_URL`. If you add a second hostname later, change them on the **Environment** tab and redeploy.
3. **DNS.** SSH connects to the server's IP directly. If the hostname is proxied through a CDN, SSH fails; use a separate DNS-only hostname such as `ssh.git.example.com` for SSH.

## First start and the admin account

On first visit, the forge shows its installation page. Check the database settings it prefilled from the environment, confirm the site URL and SSH port, and create the admin account in the **Administrator account settings** section. If you skip that section, the first user to register becomes admin, so do it now.

Then decide who can sign up. For a private team server, disable open registration:

```bash
FORGEJO__service__DISABLE_REGISTRATION=true
```

Use `GITEA__service__DISABLE_REGISTRATION=true` on Gitea. Invite people by creating their accounts, or connect an OpenID Connect provider in the admin panel so your team signs in with existing accounts.

## Mirror and migrate repositories

Both forges import repositories from GitHub, GitLab, Bitbucket and other forges, including issues, pull requests and releases where the source API allows it. Pull mirrors keep a copy in sync on an interval; push mirrors send your commits to another remote.

Forgejo's template sets two migration settings:

```bash
FORGEJO__migrations__ALLOWED_DOMAINS=
FORGEJO__migrations__ALLOW_LOCALNETWORKS=false
```

Blocking local networks stops a user from asking your server to "migrate" from an internal address, a classic server-side request forgery path. An empty allowed-domains list allows any public host. Set it to a list such as `github.com,gitlab.com` if you want to restrict imports.

## CI with Gitea Actions or Forgejo Actions

Both forges run workflows in a GitHub Actions-compatible YAML format, stored in `.forgejo/workflows/` or `.gitea/workflows/` (both also read `.github/workflows/`). Jobs do not run inside the forge. They run on a separate runner process that registers with the server:

- Gitea uses `act_runner`.
- Forgejo uses Forgejo Runner.

Enable Actions in the admin settings, create a registration token, and deploy the runner as its own service with that token. Run it on a different node from the forge if you can: CI builds eat CPU and memory, and your Git server should stay responsive while a build runs. Jobs that build Docker images need access to a Docker daemon, which gives them root-equivalent power on that host. Treat runners as untrusted machines. The [self-hosted GitHub Actions runners](/blog/self-hosted-github-actions-runners/) post covers isolation in detail, and the same rules apply here.

Many marketplace actions work unchanged. Actions that call GitHub-specific APIs do not.

## Back up your Git server

Losing a Git server loses more than code: issues, reviews, wikis, releases and CI history. Back up both halves, off the server:

- **Database dump** of `postgresql`, daily, with scheduled restore tests.
- **Volume archive** of `forgejo-data` or `gitea-data`, daily. Repositories change all day, and a nightly archive is a reasonable trade-off for most teams.

A volume archive taken while someone pushes can catch a repository mid-write. Git is resilient to that (a half-written pack is ignored), but if you want a fully quiet copy, turn on **Stop forgejo while archiving** and schedule the backup for the middle of the night. The service is down only for the archive's duration.

Setup is in [Back up a database or volume](/docs/data/backups/). Both forges also have a built-in `dump` command that writes one zip with the repositories, database and config. It is a useful extra copy before an upgrade:

```bash
forgejo dump -c /data/gitea/conf/app.ini -f /tmp/forgejo-dump.zip
```

Run it from the **Terminal** tab as the `git` user, then download the file from the container. The [Gitea](/templates/gitea/) image uses `gitea dump` with the same options.

## Upgrades

Forgejo's template follows the `15` major tag, so a redeploy picks up patch releases. Gitea's is pinned by digest. For a major upgrade on either:

1. Read the release notes. Forgejo publishes a migration guide for each major version.
2. Run both backup policies with **Run now**.
3. Change the image tag and redeploy. Migrations run on start.
4. Check the **Logs** tab, then clone, push and open a pull request.

Do not skip several majors in one jump if the notes advise against it.

## FAQ

### Is Forgejo compatible with Gitea?

Mostly, for users: the interface, API and workflow format are close. On the server side the forks diverge with each release, so a direct database migration from a recent Gitea to Forgejo may not be supported. Check the Forgejo migration docs before you switch.

### How much server do I need for Gitea or Forgejo?

Very little for the forge itself: a small VPS handles a team. Disk space grows with repositories and LFS objects. CI runners are what need real CPU and memory, so size those separately.

### Can I use port 22 for Git over SSH?

Yes, but only if you move the host's own SSH daemon to another port first. Most setups keep the host on 22 and give Git a separate port, as the templates do.

### Do Gitea and Forgejo have a container registry?

Yes. Both include a package registry that stores container images, npm, Maven, PyPI and other formats, under the same accounts and permissions as your repositories.

### Should I self-host Git or stay on GitHub?

Stay on GitHub if your open source community lives there or you depend on its marketplace. Self-host when you need code to stay on your own infrastructure, want no per-seat cost, or need to work with internal networks.

A Git server is the foundation everything else deploys from. On LogiStack you can run Forgejo or Gitea next to the apps it builds, with backups and HTTPS handled, and deploy those apps [from Git](/docs/deploy/from-git/). Browse the [templates](/templates/) or [install LogiStack](/#install) to start.

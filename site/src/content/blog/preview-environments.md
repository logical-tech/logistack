---
title: "Preview environments: a live URL for every pull request"
description: "How preview environments give each pull request its own live URL, what they cost, how to keep them safe, and how to run them on your own servers."
date: 2026-11-08
category: Deployment
keywords: preview environments, pull request preview, ephemeral environments, review apps, sandbox environment
---

A reviewer reads a 400-line diff, approves it, and two days later a designer finds the button is off-screen on mobile. Code review shows what changed. It doesn't show what the change does. Preview environments close that gap: every pull request gets its own short-lived copy of the app, with its own URL, so reviewers click through the change before it merges. This guide explains how preview environments work, what they need from your stack, the security trap most teams walk into, and how to run them on your own servers instead of a hosted platform.

## What a preview environment is

A preview environment (also called an ephemeral environment, a review app or a per-branch sandbox) is a temporary deployment tied to one pull request:

1. Someone opens a pull request.
2. The platform creates a fresh environment, builds the branch and deploys it.
3. It posts the URL on the pull request.
4. Every new push to the branch redeploys it.
5. When the pull request merges or closes, the environment and its data are deleted.

The point is isolation. Each pull request runs alone, so two features in review can't break each other, and a broken branch never touches a shared environment.

## Why teams adopt preview environments

- **Reviewers see behaviour, not only code.** Product managers, designers and QA can test a change without cloning the repository.
- **Bugs surface before merge.** A broken migration or a missing variable fails in the preview, not on `main`.
- **Shared staging stops being a bottleneck.** No more "who deployed to staging and broke my test?"
- **Smaller pull requests.** When review is easy, people open more, smaller pull requests.
- **Demos without risk.** Share a preview link with a client to show work in progress.

## Preview environments vs staging

They solve different problems, and most teams need both.

| | Preview environment | Staging environment |
|---|---|---|
| Lifetime | Hours to days | Permanent |
| Scope | One pull request | Everything merged to `main` |
| Data | Empty or seeded | Production-like |
| Who uses it | Reviewers of one change | The whole team, QA, stakeholders |
| Catches | Bugs in one change | Bugs from changes interacting |
| Count | One per open pull request | Usually one |

A preview tells you whether a branch works on its own. [Staging](/blog/staging-environment/) tells you whether all merged branches work together.

## What you need to run preview environments

Whatever platform you use, preview environments rest on the same pieces.

### Pull request events from your Git host

The platform needs to hear when a pull request opens, gets a new commit, or closes. That means a webhook from GitHub, GitLab, Gitea or Bitbucket, and permission to comment on the pull request.

### A template to clone

Each preview should start from a known configuration, usually staging. It copies the services, build settings and variables, then swaps in the branch's commit for the services under review.

### A hostname per preview

Each preview needs its own URL. Two common approaches:

- **Generated hostnames** on a wildcard domain or a service like sslip.io. Nothing to configure, but see the certificate note below.
- **A pattern on your own domain**, such as `pr-42.preview.example.com`, backed by one wildcard DNS record.

### Isolated data

Previews must never share a database with staging or production. A migration in a branch should be free to break its own copy.

### Limits and cleanup

Without a cap, a busy repository can start dozens of previews and fill a server. Without cleanup, abandoned branches keep running forever.

## A note on HTTPS for preview URLs

Each new hostname needs a TLS certificate. If your previews use generated sslip.io or nip.io hostnames, be aware that these domains are not on the Public Suffix List. Let's Encrypt counts its limit of 50 new certificates per registered domain per week against `sslip.io` itself, so every user of the service shares one budget. Certificate requests there fail often.

The fix is a wildcard certificate on a domain you own, issued once with a DNS-01 challenge. One certificate covers every preview hostname under it, and your previews never touch a shared budget. Read more in [Let's Encrypt rate limits](/blog/lets-encrypt-rate-limits/) and the [wildcard DNS guide](/docs/networking/wildcard-dns/).

## The security trap: previews from forks

On a public repository, anyone can fork it and open a pull request. If your platform builds previews from forks, that stranger's code runs on your server, with the preview's environment variables, secrets included. They can print every secret into the page or the logs and use your server's network.

Rules that keep you safe:

- **Never build previews from forks on public repositories.** Keep the option off unless every fork author is trusted.
- **Give previews their own secrets.** Test payment keys, a sandbox email provider, never production credentials.
- **Keep previews on their own network.** A preview should not be able to reach the production database even if a variable is wrong.
- **Cap the number of previews** so a flood of pull requests can't exhaust your server.

## How to set up preview environments in LogiStack

LogiStack is an open-source, self-hosted PaaS. Preview environments are built in and free, like every other feature. When a pull request opens, LogiStack clones an environment you choose into `pr-<number>`, builds the pull request's head commit, gives it its own URL and posts that URL on the pull request. Closing or merging the pull request removes it.

### Before you start

- Connect the repository through a Git provider that sends pull request events: GitHub, GitLab, Gitea or Bitbucket. See [Deploy from Git](/docs/deploy/from-git/).
- Have an environment to clone, usually **Staging**, with at least one service that builds from that repository.

### Turn previews on

Open the project's actions menu and select **Preview deployments…**. The wizard has four decisions.

![The Preview deployments wizard on its What a preview runs step, with the Clone from field](/docs/screens/project-previews.webp)

**What a preview runs.** Pick the environment to **Clone from**, and tick the services that should build the pull request's head commit, such as `web` and `api`. Other services run what the source runs. Volumes and databases are never shared: each preview gets empty ones.

**Where it is reached.** Choose **Generated** hostnames, or **A pattern** on your own domain. A pattern must include `{number}` and can use `{service}` and `{wildcard}`:

```text
pr-{number}.{wildcard}
pr-{number}-{service}.preview.example.com
```

For the second pattern, create one wildcard DNS record, `*.preview.example.com`, pointing at the server.

**Variables.** Add the variables that must differ in a preview. They win over every definition in the source environment, and values are stored as secrets.

```text
STRIPE_SECRET_KEY   sk_test_51H...
PUBLIC_URL          https://pr-42.preview.example.com
```

**Limits and safety.**

| Setting | Range | Default |
|---|---|---|
| At most (previews running at once) | 1 to 50 | 5 |
| Remove after (hours without a commit) | Up to 90 days | 72 hours |
| Preview pull requests from forks | On or off | Off |

Check the summary and select **Turn on previews**.

### What happens next

Open a pull request on the repository. A new `pr-<number>` environment appears in the project, a comment on the pull request shows the preview URL, and each push to the branch redeploys the followed services. On GitHub, each deployment is also reported as a commit status. When the pull request closes or merges, or no event touches it for the **Remove after** hours, the preview is deleted with its volumes and databases.

Full reference: [Preview environments](/docs/deploy/preview-environments/).

### Give previews data

Each preview starts with an empty database. Run migrations with a **pre-deploy command**, and seed data there if your app needs some:

```text
sh
-c
npx prisma migrate deploy && npx prisma db seed
```

The command runs once on the new image before any replica is replaced. See [release commands](/docs/deploy/deployments/).

## How LogiStack compares with hosted preview platforms

Hosted platforms such as Vercel and Netlify made preview deployments popular, and for a frontend-only app they are hard to beat: zero setup, a global CDN and previews in seconds. If your app is a static site or a Next.js frontend talking to a third-party backend, a hosted platform is likely the better fit.

A self-hosted setup earns its keep when the preview has to include your backend, workers and a real database, when you want predictable server costs instead of per-seat or per-usage pricing, or when the code can't leave your infrastructure. The trade-off: you run the servers, and LogiStack is a younger project with a smaller community than the big hosted platforms. See [Vercel alternatives](/blog/vercel-alternatives/) for a longer comparison.

## FAQ

### What is the difference between a preview environment and a sandbox environment?

A sandbox is any isolated place to run code safely. A preview environment is a specific kind of sandbox: tied to one pull request, created and destroyed automatically, with a shareable URL.

### How much do preview environments cost to run?

On your own servers, each preview uses the CPU and memory of its services while it runs. Cap the number of concurrent previews and remove idle ones after a few days, and the cost stays bounded by your server size.

### Can preview environments include a database?

Yes. In LogiStack each preview gets its own empty database and volumes, which are deleted with the preview. Run migrations and seed scripts with a pre-deploy command.

### Are preview environments safe for open-source repositories?

Only if you never build pull requests from forks. A fork's code runs with the preview's secrets, so its author could read them. LogiStack keeps fork previews off by default.

### Do preview environments work with monorepos?

Yes. Choose which services build the pull request's commit, and the rest run what the source environment runs.

Preview environments make review about behaviour instead of diffs, and they don't need a hosted platform. LogiStack builds a full copy of your stack per pull request, backend and database included, on servers you control. [Install LogiStack](/#install) and turn on previews for your first repository.

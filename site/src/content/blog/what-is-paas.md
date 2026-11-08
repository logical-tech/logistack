---
title: "What is PaaS? Platform as a service for developers"
description: "What is PaaS, how a platform as a service turns a git push into a running app, where it helps, where it hurts, and how to pick one in 2026."
date: 2026-11-08
category: Deployment
keywords: what is paas, platform as a service, paas examples, paas vs iaas vs saas, self-hosted paas
---

You wrote an app. Now you need it on the internet with a domain, HTTPS, a database, logs and a way to ship the next version without breaking the current one. You can assemble all of that from a bare server, or you can hand the job to a platform. That second option is what PaaS means: platform as a service, a layer that takes your code and runs it, so you spend your time on the code.

This guide explains what a PaaS does, what it costs you in control and money, how it compares with IaaS and SaaS, and how to choose one, including the option of running the platform yourself.

## What is PaaS, in practical terms?

A PaaS is a contract. You provide source code or a container image plus a little configuration. The platform provides everything between that code and a user's browser:

- **Build**: it turns your repository into a runnable artifact, usually a container image.
- **Run**: it schedules that artifact on machines, restarts it when it crashes and replaces it when you ship.
- **Route**: it gives the app a hostname, a TLS certificate and a load balancer.
- **Attach**: it provisions databases, caches and storage and injects their connection strings as environment variables.
- **Observe**: it collects logs and basic metrics, so you can see what the app is doing.

You never log in to a server, patch an OS or write a reverse proxy config. The unit you think about is the app, not the machine.

## How a PaaS works under the hood

Almost every modern platform follows the same pipeline, whatever its branding:

1. **A trigger arrives.** A push to a branch, a tag, a button in a dashboard or an API call.
2. **The source is built.** The platform detects the language (a buildpack or a tool like Railpack) or runs your Dockerfile. The output is an image with a unique tag.
3. **Configuration is merged.** Environment variables and secrets for that environment are attached to the image at run time, not baked into it.
4. **The new version rolls out.** New containers start, pass a health check and take traffic. Old ones drain and stop.
5. **The router updates.** The proxy points the hostname at the new containers and keeps the certificate valid.

The interesting differences between platforms sit inside those steps: how builds are cached, what counts as healthy, whether a rollback rebuilds or reuses an old image, and where the containers physically run.

## PaaS vs IaaS vs SaaS

The three terms describe how much of the stack someone else runs for you.

| Layer | IaaS | PaaS | SaaS |
| --- | --- | --- | --- |
| Hardware and network | Provider | Provider (or you, if self-hosted) | Provider |
| Operating system | You | Platform | Provider |
| Runtime, containers, proxy | You | Platform | Provider |
| Your application code | You | You | Provider |
| Your data and config | You | You | You (inside their app) |
| Typical examples | AWS EC2, Hetzner Cloud, DigitalOcean Droplets | Heroku, Render, Railway, Google App Engine, self-hosted platforms | Gmail, Notion, Salesforce |

IaaS gives you a virtual machine and leaves the rest to you. SaaS gives you a finished product you configure but cannot change. PaaS sits in the middle: your code, someone else's plumbing.

A useful way to decide is to ask what you want to be on call for. With IaaS, you own kernel updates and disk alerts. With PaaS, you own your app's bugs. With SaaS, you own your account settings.

## What a good PaaS gives you

Not every platform ships the same feature set. These are the features that save real hours:

- **Deploy on push** with webhooks set up for you, plus a way to skip deploys for commits that touch nothing relevant.
- **Zero-downtime rollouts** that wait for a health check before old containers stop. See our guide on [zero-downtime deployments](/blog/zero-downtime-deployments/).
- **One-click rollback** to an exact earlier build, without rebuilding.
- **Environments** for production, staging and one per pull request, each with its own variables. See [preview environments](/blog/preview-environments/).
- **Managed databases with backups** you have tested by restoring them.
- **Automatic HTTPS** with renewals you never think about.
- **Logs, metrics and alerts** in one place.
- **An API**, so CI and scripts can do anything the dashboard does.
- **Access control**, so a contractor can deploy one project without seeing the production database password.

## The benefits, and who feels them

**Small teams ship faster.** A two-person startup does not need a platform engineer if the platform already handles builds, TLS and rollouts.

**Fewer snowflake servers.** Every app runs the same way, so knowledge transfers. A new hire learns one deploy flow, not five.

**Safer releases.** Health-checked rollouts and immutable images mean a bad deploy is a click away from being undone.

**Clear cost boundaries.** Each app is a line item, which makes it easier to see what a side project or a client costs to run.

## The limitations nobody puts on the pricing page

PaaS is not free of trade-offs. Know these before you commit:

- **Price grows with success.** Managed platforms charge per instance, per GB of memory, per seat or per GB of bandwidth. At small scale that is cheaper than an engineer's time. At larger scale the same workload on rented servers can cost a fraction.
- **Lock-in through convenience.** Proprietary config files, platform-only add-ons and custom build systems make leaving expensive. Platforms that build from a standard Dockerfile and run standard containers are easier to leave.
- **Limited control.** You may not choose the region, the kernel, the network layout or how long a request can run. Long-running jobs, WebSockets at scale, GPUs and unusual ports are common pain points.
- **Data residency.** If a regulator or a customer contract says where data must live, a managed platform's region list decides for you.
- **Shared fate.** When the provider has an outage, every app on it has one too, and you can only wait.

## When PaaS is the right call, and when it is not

PaaS fits well when:

- You run web apps, APIs, workers and cron jobs in standard languages.
- Your team is small and nobody wants to manage servers full time.
- You ship often and want each release to be boring.

PaaS fits badly when:

- You need specialized hardware, kernel tuning or unusual networking.
- You run large stateful systems, such as a multi-terabyte database cluster, that need dedicated operations work anyway.
- Your bill on a managed platform has grown past what a few servers plus your own time would cost.

That last case is where a third option comes in.

## Managed PaaS vs self-hosted PaaS

A PaaS does not have to be someone else's service. A **self-hosted PaaS** is the same model, git push to running app, installed on servers you rent or own. You keep the developer experience and swap the per-app bill for a fixed server bill.

| Question | Managed PaaS | Self-hosted PaaS |
| --- | --- | --- |
| Who runs the servers? | The provider | You, on any VPS or bare metal |
| How do you pay? | Per app, instance, seat or usage | The server bill, plus your time |
| Where does data live? | The provider's regions | Wherever you put the servers |
| Who patches the platform? | The provider | You, usually with a one-click update |
| What happens in an outage? | You wait | You debug |

Neither is better in general. Managed platforms win when your time is the scarcest resource and the bill is small. Self-hosted platforms win when the bill or data residency matters more than an hour of maintenance per month. We cover this decision in detail in [what a self-hosted PaaS is and when it beats managed PaaS](/blog/self-hosted-paas/).

## Common PaaS examples

A short, non-exhaustive map of the market:

- **Heroku**: the original git-push platform, now part of Salesforce. Buildpacks, dynos and a large add-on marketplace.
- **Render and Railway**: newer managed platforms with a similar model and a more modern dashboard. See [Railway vs Render](/blog/railway-vs-render/).
- **Fly.io**: runs your containers as lightweight VMs in many regions, close to users.
- **Vercel and Netlify**: focused on frontend frameworks and static sites, with serverless functions for the backend parts.
- **Google App Engine, Azure App Service, AWS Elastic Beanstalk**: PaaS layers inside the big clouds, useful when the rest of your stack already lives there.
- **Self-hosted platforms** such as LogiStack, Coolify, Dokploy, CapRover and Dokku: open source, installed on your own servers.

For a wider list with trade-offs, read [the best PaaS providers](/blog/best-paas-providers/).

## How to choose a PaaS

Ask these questions in order. Each one removes options.

1. **Where must the data live?** If the answer is a specific country or your own hardware, you need a provider with that region or a self-hosted platform.
2. **What do you run?** Web apps only, or also workers, cron jobs, databases, object storage and long-lived connections?
3. **How do you build?** Prefer a platform that accepts a plain Dockerfile. It keeps your exit door open.
4. **How do rollbacks work?** Does a rollback redeploy an exact earlier image, or rebuild from an old commit and hope the dependencies are still the same?
5. **What does it cost at 10x your current size?** Model the bill, not the free tier.
6. **Who needs access?** If clients, contractors or auditors need scoped access, check for roles, SSO and an audit log before you sign up.

## FAQ

### Is Docker a PaaS?

No. Docker is a container runtime and image format. A PaaS uses containers as its building block and adds builds, routing, TLS, rollouts and a dashboard on top. Many self-hosted platforms run on Docker or Docker Swarm.

### Is Kubernetes a PaaS?

Not by itself. Kubernetes is a container orchestrator: it schedules containers but leaves builds, routing defaults and developer workflow to you. Products such as OpenShift add a PaaS layer on top of it. If Kubernetes feels like too much, see [Kubernetes alternatives](/blog/kubernetes-alternatives/).

### Is PaaS cheaper than running my own servers?

At small scale, usually yes, once you count your time. As usage grows, managed PaaS bills often grow faster than the underlying compute. A self-hosted PaaS keeps the workflow and moves you to a flat server bill.

### Can I use a PaaS for databases?

Most platforms offer managed Postgres, MySQL or Redis. Check whether backups are scheduled, encrypted and actually restorable before you trust them with production data.

If you want the PaaS workflow on servers you control, LogiStack is an open-source, self-hosted PaaS on Docker Swarm with Caddy for HTTPS. It deploys from Git or a Docker image, runs six database engines with an editor built in, and schedules encrypted backups, with every feature in the free Apache 2.0 build. Browse the [features](/features/) or [install it](/#install) on a fresh Ubuntu or Debian server with one command.

---
title: "Secrets management for self-hosted apps: a practical guide"
description: "Secrets management for apps on your own servers: where secrets leak, how to store, inject, rotate and audit them, and when Vault or Infisical is worth it."
date: 2026-11-08
category: Security
keywords: secrets management, secrets manager, docker secrets, manage api keys, hashicorp vault alternative
---

A Stripe live key sits in a `.env` file on the server, in a Slack message from last spring, in the CI settings, and in the Git history of a repository three contractors can still clone. Nobody knows who has it. Nobody can rotate it without breaking something. That is the normal state of secrets in a small team, and it is fixable. Secrets management is the discipline of keeping credentials in one place, handing them to the processes that need them and nobody else, and being able to change them on a bad day without an outage. This guide covers where secrets leak, how to store and inject them, how to rotate and audit them, and when a dedicated secrets manager such as Vault or Infisical earns its place.

## What counts as a secret

A secret is any value that grants access or proves identity. If an attacker who reads it can do something you did not intend, treat it as a secret:

- Database passwords and connection strings with credentials in them
- API keys for payment, email, storage and AI providers
- OAuth client secrets, webhook signing secrets, JWT and session signing keys
- TLS private keys and SSH private keys
- Encryption keys for backups or application data

Configuration that is merely internal, like a log level or a feature flag, is not a secret. Keep the two apart. Our guide to [environment variable best practices](/blog/environment-variables-best-practices/) covers plain configuration.

## Where secrets leak

Most leaks are not breaches. They are secrets copied into places that were never meant to hold them.

| Place | How it leaks | Fix |
| --- | --- | --- |
| Git history | A committed `.env` stays in history even after you delete it | `.gitignore` from day one, a pre-commit scanner, rotate anything that was ever committed |
| Docker image layers | `ENV` or `COPY .env` in a Dockerfile bakes the value into every copy of the image | Inject at runtime; for build-time secrets use BuildKit secret mounts |
| Build arguments | `--build-arg` values appear in `docker history` | BuildKit `--secret`, never `ARG` for credentials |
| `docker inspect` | Environment variables are visible to anyone with Docker access on the host | Limit who can reach the Docker socket; prefer secret files for high-value keys |
| Logs | Apps print config on startup, error handlers dump request headers | Mask known values in logs, never log the whole environment |
| Chat and tickets | "Here is the prod password" | Share access to the secrets store, not the value |
| CI variables | Every job and every maintainer can print them | Scope CI secrets to protected branches and specific jobs |

Rotate a secret once it touches any of these. Deleting the file afterwards does not undo a leak.

## Four ways to store secrets

There is no single right tool. There is a ladder, and you climb it as the team and the stakes grow.

### 1. Environment files on the server

A `.env` file outside the repository, readable only by the deploying user (`chmod 600`), injected by Docker Compose. It is simple and works for one person and one server. It breaks down quickly: no history, no audit, every server has its own copy, and rotation means SSH and edit by hand.

### 2. Docker Swarm secrets

Swarm stores secrets encrypted in its Raft log and mounts them as files in `/run/secrets/` inside the containers that ask for them:

```bash
printf '%s' "$DB_PASSWORD" | docker secret create pg_password_v2 -
```

```yaml
services:
  api:
    image: ghcr.io/acme/api:2026.11.08
    secrets:
      - source: pg_password_v2
        target: pg_password
    environment:
      DB_PASSWORD_FILE: /run/secrets/pg_password
secrets:
  pg_password_v2:
    external: true
```

Files are harder to leak than environment variables: they do not show up in `docker inspect` and child processes do not inherit them. The cost is that your app, or its image, must read `*_FILE` variables. Swarm secrets are also immutable, so rotation means creating a new secret and updating the service.

### 3. Encrypted files in Git

Tools like SOPS and age encrypt a YAML or `.env` file so it can live in the repository next to the code. Decryption keys stay with the people and machines that deploy. This gives you history and review through pull requests, but anyone who once had the key can decrypt every past version, so revoking access means rotating the secrets themselves.

### 4. A secrets manager

HashiCorp Vault, Infisical, 1Password with Connect, Doppler, and the cloud providers' secret stores keep secrets in one encrypted service with access policies, versions and an audit trail. Apps or the deploy pipeline fetch values at deploy time or runtime. This is the right tool once several teams, many services or compliance requirements are involved. It is also one more critical system to run: if your self-hosted Vault is sealed or down, deploys stop.

| Approach | History | Audit | Rotation effort | Fits |
| --- | --- | --- | --- | --- |
| `.env` on the server | No | No | Manual, per server | One person, one server |
| Swarm secrets | No | Docker events only | New secret plus redeploy | Swarm clusters without a manager |
| SOPS in Git | Git history | Git log | Edit, commit, redeploy | Small teams with GitOps habits |
| Secrets manager | Yes | Yes | Change once, redeploy or reload | Several teams, compliance |

## Inject secrets at deploy time, not build time

Whatever stores your secrets, the same rule applies: images carry code, not credentials. The image you build for staging should be byte-for-byte the image you promote to production, with different secrets injected when it starts. This keeps secrets out of registries and lets you rotate without rebuilding.

When a build genuinely needs a credential, for example a token for a private package registry, use a BuildKit secret mount. It is available during one `RUN` step and never written to a layer:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=npm_token,env=NPM_TOKEN \
    npm ci
```

```bash
docker build --secret id=npm_token,env=NPM_TOKEN -t api:dev .
```

Our [container security best practices](/blog/container-security-best-practices/) checklist covers the image side in more detail.

## Rotation: plan it before you need it

Every secret will need to change: a contractor leaves, a laptop is stolen, a key shows up in a log. Rotation goes smoothly only if you prepared for it.

- **Know where each secret is used.** If you cannot list the services that read `STRIPE_SECRET_KEY`, you cannot rotate it safely.
- **Prefer providers that allow two active keys.** Create the new key, deploy it, confirm traffic works, then revoke the old one. No downtime.
- **Version secrets.** Being able to roll back to the previous value after a bad rotation turns a 2 a.m. outage into a 2-minute fix.
- **Rehearse.** Rotate a low-risk secret on a schedule, say quarterly, so the procedure works when it matters.
- **Rotate database passwords per role**, not one shared superuser. Give each app its own database user.

## Access and audit

Two questions should have quick answers: who can read this secret, and who did?

- **Least privilege by scope.** A secret for one project should be readable by that project's services and its maintainers, not the whole organization.
- **Separate "can deploy" from "can read".** Many people need to ship code. Few need to see the production database password.
- **Log every reveal.** Reading a secret value in a UI or API should leave an audit entry with who and when. See our post on [audit logs](/blog/audit-logs/).
- **Machines get their own identities.** CI uses a service account with a scoped, expiring key, not a person's credentials.

## When to adopt Vault or Infisical

Adopt a dedicated secrets manager when at least one of these is true:

- Several teams or many services share secrets and you need policies per path.
- An auditor asks for access logs and rotation evidence.
- You need dynamic secrets, such as short-lived database credentials generated per request. Vault does this; most simpler tools do not.
- Secrets must be shared across platforms: Kubernetes, CI, serverless functions and your own servers.

If none apply, a platform with encrypted, versioned, scoped secrets is usually enough, and it is one less service to keep alive. Both Vault and Infisical are in LogiStack's [template catalog](/templates/) as [`vault`](/templates/vault/) and [`infisical`](/templates/infisical/) if you want to run one yourself.

## Secrets management in LogiStack

LogiStack is an open-source, self-hosted PaaS on Docker Swarm. Secrets are a first-class object, separate from plain variables. From the [secrets and environment variables docs](/docs/deploy/environment-variables/):

- **Scoped definitions.** A secret is defined at the organization, a folder, a project, an environment or a single service. A service receives it only when its Environment tab references it, and the container-side name can differ from the secret's key.
- **Encryption per organization.** Each secret version is encrypted with AES-256-GCM under a per-organization data key, which is itself encrypted with a key derived from the instance master key. An admin can rotate the data key, and every version is re-encrypted.
- **Versions and rollback.** Editing a value creates a new version; History shows each author, and Roll back restores an earlier value as a new version.
- **Usages.** Every secret lists the services that reference it, and cannot be deleted while in use.
- **Audited reveals.** Showing a value needs a read permission on the secret's level and is recorded in the audit log.
- **Masking.** Values never appear in variable lists, manifests, the audit log or deployment logs; build and deploy logs replace them, and their base64 form, with `***`.
- **Build secrets.** A secret marked for the build becomes a BuildKit secret, not a build argument.

![The Environment tab of a service referencing environment, project and service secrets](/docs/screens/service-environment.webp)

If you already run a secrets manager, LogiStack can use it instead of storing a copy. [External secrets](/docs/deploy/external-secrets/) connect HashiCorp Vault (KV v2), Infisical or 1Password Connect, and you reference values as `secret://<provider>/<path>#<field>`. Each deployment reads the current value; if any read fails, the deployment stops and the running version keeps serving. Every 15 minutes LogiStack checks for changed values and marks affected services for review, so you redeploy on your terms.

Honest limits: LogiStack injects secrets as environment variables, and external secrets update on redeploy, not live inside a running container.

## FAQ

### What is secrets management?

It is how you store, distribute, rotate and audit credentials such as API keys, database passwords and signing keys. Good secrets management keeps each secret in one encrypted place, gives it only to the services that need it, and records who read or changed it.

### Are environment variables safe for secrets?

They are acceptable when they are injected at runtime from an encrypted store and never baked into images or committed to Git. Their weak spots are `docker inspect`, child processes and apps that log their environment. For the most sensitive keys, mounted secret files are safer.

### Should I use Docker secrets or a secrets manager?

Docker Swarm secrets are a good step up from `.env` files on a single cluster. A secrets manager adds policies, versions, audit logs and sharing across platforms. Choose it when several teams, compliance or dynamic credentials are involved.

### How often should I rotate secrets?

Rotate immediately after any suspected exposure or when someone with access leaves. Beyond that, a scheduled rotation, quarterly for most keys, keeps the procedure tested. Short-lived credentials remove the question entirely where your providers support them.

### How do I remove a secret that was committed to Git?

Rotate it first: the old value is compromised no matter what you do to the history. Then remove it from the history with a tool such as git-filter-repo if you need a clean repository, and add a pre-commit secret scanner.

To get encrypted, versioned, audited secrets on your own servers, with Vault, Infisical or 1Password as an option, [install LogiStack](/#install) and add your first secret under Settings.

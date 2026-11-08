---
title: "Environment variables best practices for production apps"
description: "Environment variables best practices: naming, startup validation, build-time vs runtime values, .env files and safe changes in production."
date: 2026-11-08
category: Deployment
keywords: environment variables best practices, env vars, .env file, build time vs runtime environment variables, configuration management
---

The deploy succeeds, the health check passes, and ten minutes later checkout fails because `STRIPE_WEBHOOK_SECRET` is empty in production. It was set in staging, renamed in a refactor, and nobody noticed until a customer did. Environment variables are the simplest way to configure an app, and that simplicity hides a lot of ways to get them wrong. This guide collects the environment variables best practices that prevent those failures: how to name them, validate them, separate build-time from runtime values, manage `.env` files, and change them in production without surprises.

## Why configuration lives in the environment

The idea is old and still right: the same build artifact should run in development, staging and production, and only its configuration should change. Environment variables are the one mechanism every language, every container runtime and every hosting platform supports. They keep config out of the code, so promoting a release from staging to production is a matter of starting the same image with different values.

That works only if you treat the environment as an interface with a contract, not a bag of strings.

## Name variables for humans

Good names prevent half the bugs.

- **Uppercase with underscores**: `DATABASE_URL`, `SMTP_HOST`. It is the convention every tool expects.
- **Prefix by subsystem**: `REDIS_URL`, `REDIS_TLS`; `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`. Related values sort together and are easy to find.
- **Say the unit**: `CACHE_TTL_SECONDS`, `MAX_UPLOAD_MB`, `REQUEST_TIMEOUT_MS`. `TIMEOUT=30` is a guess waiting to be wrong.
- **Booleans as `true` or `false`**, and parse exactly those. `"false"` is truthy in most languages if you only check that the string is non-empty.
- **Avoid environment names inside keys.** `PROD_DATABASE_URL` and `STAGING_DATABASE_URL` mean the code must know where it runs. Use one `DATABASE_URL` with different values per environment.
- **Respect framework prefixes.** Vite exposes only `VITE_*` to the browser, Next.js only `NEXT_PUBLIC_*`. The prefix is a security boundary: everything with it ships to every visitor.

## Validate at startup and fail fast

Never let an app start with a configuration it cannot run with. Parse every variable once, at boot, into a typed object, and crash with a clear message if something is missing or malformed. A crash at deploy time fails the health check and keeps the old version serving. A crash on the first checkout request does not.

In TypeScript with zod:

```ts
import { z } from "zod";

const Env = z.object({
	NODE_ENV: z.enum(["development", "test", "production"]),
	PORT: z.coerce.number().int().default(3000),
	DATABASE_URL: z.string().url(),
	STRIPE_SECRET_KEY: z.string().startsWith("sk_"),
	STRIPE_WEBHOOK_SECRET: z.string().min(1),
	FEATURE_NEW_CHECKOUT: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
});

export const env = Env.parse(process.env);
```

The same pattern exists everywhere: pydantic-settings in Python, `envconfig` or a small struct parser in Go, typed config classes in Laravel and Rails. The rules are the same:

- **Read the environment in one module.** The rest of the code imports the typed object, never `process.env` directly.
- **Default only what is safe to default.** A port can default. A database URL or an API key must not, or production quietly runs against a local database.
- **Print which keys are missing, never their values.**

## Build time vs runtime

This distinction causes more confusion than any other.

| | Build time | Runtime |
| --- | --- | --- |
| When it is read | While the image is built | When the container starts |
| Where it ends up | Baked into the image or the JS bundle | Only in the running process |
| Change it by | Rebuilding | Restarting or redeploying |
| Examples | `VITE_API_URL`, `NEXT_PUBLIC_SITE_URL`, a package registry token | `DATABASE_URL`, `REDIS_URL`, API keys |

Front-end frameworks replace public variables at build time. If you build one image and deploy it to staging and production, both get whatever `NEXT_PUBLIC_API_URL` was during the build. Two fixes:

1. **Build per environment**, passing the public values as build arguments. Simple, but staging and production run different artifacts.
2. **Serve config at runtime**: an endpoint or a small `config.js` generated at container start that the front end reads. One image, any environment.

Never pass secrets as Docker build arguments. They are visible in `docker history`. If a build needs a credential, use a BuildKit secret mount, covered in our [secrets management](/blog/secrets-management/) guide.

## .env files: useful locally, dangerous in Git

`.env` files are a convenience for local development. Treat them that way.

- **Ignore them in Git from the first commit**: add `.env` and `.env.*` to `.gitignore`, except an example file.
- **Commit a `.env.example`** with every key and a fake or empty value. It documents the contract and is what a new developer copies.

```bash
# .env.example
DATABASE_URL=postgres://app:app@localhost:5432/app
REDIS_URL=redis://localhost:6379
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
LOG_LEVEL=debug
```

- **Know the quoting rules of your loader.** Docker Compose's `env_file` and the `dotenv` libraries differ on quotes, `#` comments and `$` expansion. A password containing `$` or `#` is the classic victim. Test with a value that contains both.
- **Do not depend on `.env` in production.** Production values belong in your platform or secrets store, not in a file someone copied over SSH.

## Separate secrets from configuration

Not every variable is equal. `LOG_LEVEL=warn` can appear in a screenshot. `DATABASE_URL` with a password in it cannot. Keep them in different places with different rules:

- **Plain config** can be visible to everyone on the team, live in a manifest, and show up in deploy diffs.
- **Secrets** are encrypted, write-only after creation, versioned, and every read is audited.

Mixing them in one file means everyone who can see the log level can also see the payment keys.

## One variable, many environments

As soon as you have staging, production and preview environments, you face the same key with different values. A clear precedence rule keeps it manageable:

1. **Organization-wide defaults**: `LOG_LEVEL=info`, `SENTRY_DSN`.
2. **Per project**: `APP_NAME`, shared buckets.
3. **Per environment**: `DATABASE_URL`, `PUBLIC_URL`, `LOG_LEVEL=warn` in production.
4. **Per service**: anything one service needs differently.

The most specific value wins. Write the rule down, and make sure your tooling can show which level a running value came from. Our post on [staging environments](/blog/staging-environment/) covers keeping environments close to each other.

## Changing variables in production

A variable change is a deployment. Treat it like one.

- **Containers do not reload environment variables.** The process reads them at start. A change takes effect only after a restart or redeploy.
- **Review the diff before applying.** Seeing `LOG_LEVEL: info → debug` and `DATABASE_URL: changed` in one view catches mistakes.
- **Roll out gradually** with a rolling update, so a bad value fails the health check on the first new replica instead of all of them. See [zero-downtime deployments](/blog/zero-downtime-deployments/).
- **Keep history.** Knowing what the value was yesterday is how you roll back.

## Debugging environment variables

When a value seems wrong, check what the process actually sees, not what you think you set:

```bash
# Inside a running container
docker exec api printenv LOG_LEVEL

# What a container was started with (also shows values, so mind who is watching)
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' api | grep -v -i secret
```

Common causes: the container was not recreated after the change, a more specific scope overrides the value, or the framework baked the old value at build time.

## Environment variables in LogiStack

LogiStack is an open-source, self-hosted PaaS on Docker Swarm, and it follows the practices above by design. From the [secrets and environment variables docs](/docs/deploy/environment-variables/):

- **Plain variables cascade** from organization to project to environment to service, and the most specific wins. A service's Inherited panel shows where each value comes from and which ones are overridden.
- **Secrets are separate**: encrypted, versioned and referenced explicitly by each service that needs them. When you type a value on a service under a sensitive-looking name (`PASSWORD`, `TOKEN`, `KEY`, `SECRET`), the Secret toggle turns on by itself.
- **Paste a `.env` file** and preview which keys become secrets before saving.
- **Build variables are explicit.** Mark a variable Build and it becomes a Dockerfile build argument; a secret marked Build becomes a BuildKit secret instead. See [build types](/docs/deploy/build-types/).
- **Changes wait for a deploy.** Edited values show up as a pending diff, with secrets withheld, until you redeploy.
- **Deployment context variables** such as `LOGISTACK_COMMIT_SHA`, `LOGISTACK_ENVIRONMENT` and `LOGISTACK_URL` are set on every container, and names starting with `LOGISTACK_` are reserved.

![The project Secrets and variables page with a Production secret used by seven services](/docs/screens/project-variables.webp)

## FAQ

### Should I commit .env files to Git?

No. Commit a `.env.example` with every key and placeholder values, and ignore the real `.env`. If a real one was ever committed, rotate every secret it contained.

### What is the difference between build-time and runtime environment variables?

Build-time variables are read while the image or bundle is built and are baked into it. Runtime variables are read when the container starts. Front-end public variables such as `NEXT_PUBLIC_*` and `VITE_*` are build time, so changing them needs a rebuild.

### Why does my app not see an environment variable I just changed?

Processes read the environment when they start. Restart or redeploy the container. If it still shows the old value, check whether a more specific scope overrides it, or whether a framework baked it in at build time.

### Are environment variables secure enough for secrets?

They are fine when injected at runtime from an encrypted store and never committed or baked into images. Limit who can access the Docker host, since `docker inspect` shows them, and never log the full environment.

### How should I name environment variables?

Uppercase with underscores, prefixed by subsystem (`REDIS_URL`), with units in the name (`TIMEOUT_MS`). Use one key per concept with different values per environment rather than `PROD_` and `STAGING_` prefixes.

To manage variables and secrets per organization, project, environment and service from one dashboard, [install LogiStack](/#install) on your own server.

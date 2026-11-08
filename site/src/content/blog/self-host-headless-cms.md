---
title: "Self-host a headless CMS: Directus vs Strapi in production"
description: "Self-host a headless CMS on your own server: compare Directus and Strapi, deploy either with Postgres, and set up uploads, caching and backups for production."
date: 2026-11-08
category: Self-hosting
keywords: self-host headless cms, headless cms self-hosted, directus vs strapi, self-host directus, self-host strapi
---

Your marketing site is a Next.js app, your mobile app needs the same content, and editors want a friendly admin panel instead of pull requests. A hosted headless CMS solves that until the API call quota, the per-seat price, or a data residency review gets in the way. If you self-host a headless CMS, you get the editor UI and the content API on your own server, with the content in a PostgreSQL database you control. This guide compares Directus and Strapi, the two most common choices, and shows how to run each one in production.

## What a self-hosted headless CMS needs

A headless CMS is two things: an admin app where editors write content, and an API (REST or GraphQL) your front ends read from. Running one well means looking after five parts:

1. **The app** itself, a Node.js process.
2. **A database**, PostgreSQL in almost every serious setup.
3. **Uploaded files**: images, PDFs, video. On a volume or in S3.
4. **A cache** such as Redis, for API speed and rate limiting.
5. **Backups** of the database and the uploads, kept off the server.

A template that gets the first four right on day one saves you most of the setup.

## Directus vs Strapi

Both are Node.js, both expose REST and GraphQL, both have role-based permissions and media libraries. They differ in where the content model lives.

| | Directus | Strapi |
| --- | --- | --- |
| Model | Database-first: it wraps any SQL schema, including existing tables | Code-first: content types are files in your project |
| Changing the schema in production | Yes, from the admin app; changes go straight to the database | No; the Content-Type Builder only works in development mode |
| Custom code | Extensions (hooks, endpoints, interfaces) loaded at runtime | Full Node.js project: controllers, services, plugins |
| Deploy model | Run the official image, configure with env vars | Build your own project into an image from Git |
| License | Business Source License: free for organizations under a revenue threshold, paid license above it | MIT for the Community Edition; paid Enterprise features |
| Best for | Teams that want a data platform over SQL, and fast setup | Developers who want the CMS as code, reviewed in Git |

Read Directus's current license terms before you adopt it in a larger company: the BSL is not an OSI open-source license, and the free-use threshold applies to your organization's total finances.

Other options are worth knowing. Payload is code-first and lives inside a Next.js app. Ghost is better if you need a publishing tool with newsletters rather than a general CMS; our guide on [self-hosting Ghost](/blog/self-host-ghost/) covers it. WordPress also works headless through its REST API.

## Directus: what the template deploys

The [Directus template](/templates/directus/) creates three services:

| Service | Image | Role |
| --- | --- | --- |
| `directus` | `directus/directus:12.1.1` | App and API on port 8055, health check on `/server/ping` |
| `database` | `postgis/postgis:13-master` | PostgreSQL with PostGIS for geometry fields |
| `cache` | `redis:6` | API cache, with auto-purge on content changes |

Uploads go to the `directus-uploads` volume and extensions to `directus-extensions`. WebSockets are on, so the realtime API works. The template asks for the domain and an admin email. It generates the secret, the database password and the admin password.

There is also a Directus with PostgreSQL template on the Directus 11 line with PostgreSQL 16, Redis 7 and CORS settings as inputs. Pick it if your front end calls the API from a browser on another origin and you want CORS set from the start.

## Strapi: what the template deploys

The [Strapi template](/templates/strapi/) runs Strapi 5 with PostgreSQL:

| Service | Role | Volumes |
| --- | --- | --- |
| `strapi` | Admin and API on port 1337 | `config`, `src`, `public/uploads` |
| `postgresql` | Content | `strapi-postgresql-data` |

JWT secrets and app keys are generated. Telemetry is off.

One honest detail matters here. The template runs Strapi with `NODE_ENV=development`. That is deliberate: in Strapi, the Content-Type Builder only edits content types in development mode, and the template keeps `src` and `config` on volumes so your models survive a restart. It is a good way to model content and try Strapi. It is not how Strapi recommends running production, where the project is built once, content types are committed to Git, and the server runs with `NODE_ENV=production`.

For production Strapi, keep the project in a repository and deploy it [from Git](/docs/deploy/from-git/). A minimal Dockerfile:

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NODE_ENV=production
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 1337
CMD ["npm", "run", "start"]
```

Pair it with a managed PostgreSQL database and pass `DATABASE_*`, `APP_KEYS`, `JWT_SECRET`, `ADMIN_JWT_SECRET`, `API_TOKEN_SALT` and `TRANSFER_TOKEN_SALT` as secrets. Every push builds a new image and rolls it out with a health check. LogiStack builds it with its Dockerfile build type.

## Deploy the CMS

Install LogiStack on a server with at least 2 GB of RAM, or 4 GB if the CMS shares it with other apps:

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

Then:

1. Point `cms.example.com` at the server.
2. In a project, select **New service** › **Templates**, and search `directus` or `strapi`.
3. Check **What it creates**.
4. Enter the domain. For Directus, set the admin email. Leave passwords on **Auto-generated**.
5. **Deploy**, and wait for **Every service is healthy.**

For Directus, sign in with the admin email and the generated password from the `directus` service's **Environment** tab. For Strapi, open `/admin` and register the first admin user right away.

## Production checklist for a self-hosted headless CMS

### Put uploads somewhere durable

Both templates store uploads on a local volume. That works on one server. If you want uploads in object storage, both support S3: Directus through its `STORAGE_*` variables, Strapi through its upload provider for AWS S3. A bucket on self-hosted S3 storage keeps them on infrastructure you own, and lets you serve images through a CDN.

### Lock down the API

- Give the public role read access only to published content.
- Use static API tokens with narrow permissions for build-time fetches from your front end, stored as secrets in the front end's environment.
- Set CORS to the exact origins of your sites.
- Keep the admin path behind an IP allowlist if editors work from known networks. LogiStack's [access control](/docs/networking/access-control/) adds that at the proxy.

### Cache and rebuild

If your site is statically generated, use a CMS webhook to trigger a rebuild when content is published. A front end deployed from Git on LogiStack has a deploy webhook, and you can call it from a Directus Flow or a Strapi webhook. For server-rendered sites, the Directus template already caches API responses in Redis and purges them on change.

### Use environments

Run a staging copy of the CMS with its own database for schema changes and editor training. Directus can move schema between instances with its schema snapshot and apply commands; Strapi moves schema through Git and content through its transfer feature. Our post on staging environments explains the pattern.

## Back up the database and the uploads

The template databases run as regular containers, so back up their data volumes:

- Create a volume backup for the database service's volume (`directus-database` or `strapi-postgresql-data`) and turn on **Stop the service while archiving** for a consistent copy. Or run `pg_dump` on a schedule inside the database service and upload the dump.
- Create a second policy for the uploads volume.
- For the Strapi template, back up `strapi-src` and `strapi-config` too, since your content types live there.

If you move to a managed LogiStack PostgreSQL database later, you get `pg_dump` backups with scheduled restore checks out of the box. The [backups guide](/docs/data/backups/) covers both.

## FAQ

### Which headless CMS is easiest to self-host?

Directus, because you run the official image and configure it with environment variables; the schema lives in the database. Strapi needs your own project built into an image for production, which is more work but gives you more control.

### Is Directus free for commercial use?

Directus uses the Business Source License. Organizations under its revenue threshold can use it for free, including commercially. Above the threshold, you need a paid license. Read the current terms on the Directus site.

### Can I run Strapi in production from the template?

The template runs in development mode so you can build content types in the admin. For production, commit your project to Git and deploy it with a Dockerfile in production mode, as shown above.

### Do I need Redis for a headless CMS?

Not strictly. It speeds up API responses and is needed for rate limiting and caching across several replicas. The Directus template includes it; Strapi works without it.

### Can one CMS serve several websites?

Yes. Both serve any number of front ends through their API. Model a `site` field or separate collections, and give each front end its own API token.

A self-hosted headless CMS keeps your content, your editors and your API under one roof. [Install LogiStack](/#install), deploy Directus or Strapi, and run your front ends next to it from the same dashboard. For the front-end half, see our guide to [deploying Next.js on your own server](/blog/deploy-nextjs-self-hosted/).

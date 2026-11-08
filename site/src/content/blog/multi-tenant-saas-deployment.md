---
title: "Multi-tenant SaaS deployment: models, routing and data"
description: "Plan a multi-tenant SaaS deployment: pooled vs siloed tenants, data isolation in Postgres, tenant subdomains and custom domains, and per-tenant stacks."
date: 2026-11-08
category: Deployment
keywords: multi-tenant saas deployment, multi-tenancy, saas architecture, tenant isolation, custom domains for saas, row level security
---

Your first customers all shared one app and one database, and that was fine. Now a large customer wants their data separated, another wants `app.theircompany.com` instead of a subdomain of yours, and one tenant's nightly import slows everyone else down. A multi-tenant SaaS deployment is the set of choices that decides how tenants share, or do not share, your infrastructure. Get them right early and growth is mostly configuration. Get them wrong and every large deal turns into a migration.

This guide covers the three tenancy models, how to isolate data in Postgres, how to route tenants by subdomain and custom domain, and how to run per-tenant stacks on a self-hosted platform without a pile of hand-made copies.

## The three tenancy models

Every multi-tenant design sits somewhere on a line from "share everything" to "share nothing".

**Pooled (shared everything).** One app deployment and one database for all tenants. Every table has a `tenant_id` column, and every query filters by it. This is the cheapest and simplest to operate.

**Bridge (shared app, separate data).** One app deployment, but each tenant's data lives in its own Postgres schema or its own database. The app picks the schema or connection per request.

**Siloed (stack per tenant).** Each tenant gets its own app containers and its own database. The code is the same; the deployment is separate.

| | Pooled | Bridge | Siloed |
| --- | --- | --- | --- |
| Cost per tenant | Lowest | Low | Highest |
| Data isolation | Logical (queries and policies) | Schema or database boundary | Full: separate containers and database |
| Noisy neighbour risk | Highest | Medium (shared app, separate data) | Lowest |
| Per-tenant backup and restore | Hard | Easy per database, possible per schema | Easy |
| Schema migrations | Once | Once per schema or database | Once per stack |
| Per-tenant customisation | Feature flags only | Some | Versions, regions, resources |
| Operational overhead | Low | Medium | High without automation |
| Typical fit | Self-serve SMB plans | Mid-market | Enterprise and regulated customers |

Most SaaS products end up hybrid: pooled for self-serve plans, siloed for a few enterprise customers that pay for it. Design the app so that the same code runs in both modes, with the tenant resolved from the request and the database connection chosen from configuration.

## Isolating data in a pooled database

In a pooled design, a missing `WHERE tenant_id = ...` leaks data between customers. Do not rely on every developer remembering it. Make the database enforce it with Postgres row-level security (RLS):

```sql
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON invoices
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
```

At the start of each request or transaction, the app sets the tenant:

```sql
SELECT set_config('app.tenant_id', '2f1c9a7e-5b0d-4c1e-9a3f-7d2e8b6c4a10', true);
```

The third argument, `true`, scopes the setting to the current transaction, which matters if you use a connection pooler in transaction mode. Two more rules:

- The app connects as a role that does **not** own the tables and does not have `BYPASSRLS`. Table owners skip policies unless you force them, as above.
- Migrations and admin jobs connect as a separate role.

Put an index on `tenant_id`, usually as the first column of composite indexes, so every tenant-filtered query stays fast. With many tenants and many app replicas, connection count becomes the next limit; see [PgBouncer connection pooling](/blog/pgbouncer-connection-pooling/).

## Schema or database per tenant

The bridge model gives each tenant a Postgres schema (`tenant_acme`) or a whole database. Per-tenant backup and restore become simple, and a heavy tenant's data does not bloat shared indexes.

The cost is migrations. Every schema change runs once per tenant, so your migration step becomes a loop:

```sh
#!/bin/sh
set -eu
for schema in $(psql "$DATABASE_URL" -Atc "SELECT schema_name FROM tenants WHERE active"); do
  echo "migrating $schema"
  DB_SCHEMA="$schema" npm run db:migrate
done
```

Make each migration safe to re-run, and make the app tolerate a short window where some tenants are on the new schema and some are not. Schema-per-tenant works well into the hundreds or low thousands of tenants. Beyond that, catalog size and migration time push most teams back to pooled tables or to sharding across several databases.

## Routing tenants: subdomains

The common pattern is one hostname per tenant under your domain: `acme.yourapp.com`, `globex.yourapp.com`. The app reads the `Host` header, looks up the tenant and serves it.

You need:

1. A wildcard DNS record, `*.yourapp.com`, pointing at your server.
2. A wildcard certificate. Let's Encrypt issues wildcards only over the DNS-01 challenge, so the platform needs API access to your DNS provider.
3. One route that sends every subdomain to the same app.

On LogiStack, add `*.yourapp.com` as a domain on the app service. A wildcard domain needs a connected DNS provider that manages the zone (Cloudflare, Route 53, Hetzner and others) and always uses DNS-01. An exact hostname on another service, such as `www.yourapp.com` for the marketing site, still wins over the wildcard. See [wildcard DNS](/docs/networking/wildcard-dns/).

A new tenant then needs no infrastructure change at all: insert a row, and their subdomain works.

## Routing tenants: custom domains

Larger customers want their own hostname, such as `portal.acme.com`. The flow:

1. The customer enters the hostname in your app's settings.
2. Your app tells them to create a CNAME from `portal.acme.com` to a hostname you control, such as `custom.yourapp.com`, which resolves to your server.
3. Your app checks the CNAME, then registers the hostname with your proxy so it gets a certificate.
4. The app maps the hostname to the tenant.

Step 3 is where the platform matters. On LogiStack, a domain is created through the REST API with an API key whose owner can write to the app service:

```bash
curl -X POST "$LOGISTACK_URL/api/services/$SERVICE_ID/domains" \
  -H "x-api-key: $LOGISTACK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"hostname":"portal.acme.com","port":3000,"https":true,"cert":"auto"}'
```

Caddy then obtains a certificate for that hostname over HTTP-01 once DNS points at the server. Each custom domain belongs to the customer's own registered domain, so it does not consume your domain's Let's Encrypt budget. Let's Encrypt still applies account-level limits on new orders, so if you onboard hundreds of domains a day, spread the requests out. [Let's Encrypt rate limits](/blog/lets-encrypt-rate-limits/) explains which limits apply.

Remove the domain through the API when a customer leaves, so you stop renewing a certificate for a hostname you no longer serve.

## Siloed tenants: a stack per customer

For enterprise customers who need full isolation, a dedicated region or a pinned version, give them their own copy of the stack. The challenge is keeping dozens of copies identical without clicking through dozens of dashboards.

On LogiStack, there are two natural units:

- **An environment per tenant** inside one project. Environments are isolated sets of services, variables and domains, each on its own private network, so one tenant's app cannot reach another tenant's database. Create one with the kind **Custom**, for example `client-acme`, by duplicating a template environment. See [environments](/docs/deploy/environments/).
- **A project per tenant** inside a folder, for example `Clients/Acme`. Use this when tenants need separate access: a grant on a folder or project gives a customer's team, or your account manager, access to that tenant only. See [roles and permissions](/docs/team/roles-and-permissions/).

Either way, keep the stack definition in code. A [project manifest](/docs/automation/project-manifests/) exports an environment or project as YAML, without secret values, and applies it idempotently from CI. Store one manifest per tier, apply it per tenant with that tenant's variables, and the copies stay in sync.

Duplicating an environment is also available as an API call, `POST /api/environments/{id}/duplicate`, so tenant provisioning can be one step in your signup or sales workflow.

## Noisy neighbours and capacity

Shared infrastructure means one tenant can hurt others. Defend at each layer:

- **App:** per-tenant rate limits and job queues with per-tenant concurrency caps, so one tenant's bulk import cannot fill the worker pool.
- **Containers:** CPU and memory limits on every service. Automatic scaling on CPU adds replicas of stateless services when load rises.
- **Placement:** label nodes and pin a large tenant's siloed services to dedicated nodes, so they never share a CPU with the pool.
- **Database:** statement timeouts per role, and monitoring of slow queries grouped by tenant.

To price siloed tenants, measure them. LogiStack's [usage view](/docs/operations/usage/) reports average CPU, memory, network and volume size per project and environment, over 24 hours or 7 days, so you can see what a tenant's stack costs you to run.

## Deployments across tenants

A pooled app deploys once. A fleet of silos deploys many times, and you want control over the order:

1. Deploy to an internal tenant first.
2. Then a canary group of low-risk tenants.
3. Then everyone else, in batches.

Run schema migrations as a pre-deploy step on each stack, so a failed migration stops that stack's rollout while its old version keeps serving. Keep migrations backward compatible for one release, because tenants on different versions may coexist for hours.

## Choosing your model

Start pooled with row-level security unless you already have customers who require isolation. It is the cheapest to run and the easiest to change. Add schema or database per tenant when per-tenant restore or data size demands it. Add silos for the few customers who need and pay for them, provisioned from a manifest, not by hand.

## FAQ

### What is the best database design for multi-tenant SaaS?

For most products, a shared database with a `tenant_id` column and Postgres row-level security. It is cheap, simple to migrate and safe if the database enforces isolation. Move specific tenants to their own schema, database or stack when they need it.

### How do I give each tenant a custom domain with HTTPS?

Ask the tenant to CNAME their hostname to a name you control, verify it, then add the hostname to your proxy so it obtains a certificate. On LogiStack you add the domain through the REST API, and Caddy issues and renews the certificate automatically.

### Can I mix pooled and siloed tenants?

Yes, and many SaaS products do. Run the same code in both modes, resolve the tenant from the hostname, and choose the database connection from configuration. Self-serve plans share the pool; enterprise customers get their own stack.

### How many tenants can a schema-per-tenant design handle?

Hundreds to low thousands is common. Past that, the number of database objects and the time to migrate every schema usually become a problem. Teams then move back to pooled tables or shard tenants across several databases.

A multi-tenant SaaS deployment does not need Kubernetes. LogiStack gives you wildcard and custom domains with automatic HTTPS, isolated environments, manifests and a REST API for provisioning, all open source and free. [Install it](/#install) on one server and model your first tenant tier.

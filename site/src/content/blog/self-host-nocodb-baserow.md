---
title: "NocoDB vs Baserow: self-host an open-source Airtable alternative"
description: "Compare NocoDB and Baserow as open-source Airtable alternatives, then self-host either one with Docker, a real database, HTTPS and verified backups."
date: 2026-11-08
category: Self-hosting
keywords: airtable alternative, open source airtable alternative, nocodb vs baserow, self-host nocodb, self-host baserow
---

Your team loves Airtable until the record limit hits, the per-seat price doubles with the next hire, or legal asks why customer data sits in yet another US SaaS. An open-source Airtable alternative gives you the same spreadsheet-like database (grid views, forms, kanban boards, linked records, an API) on a server you control. NocoDB and Baserow are the two most mature options. This guide compares them honestly and shows how to self-host either.

## What you lose and keep when you leave Airtable

Be clear on the trade before you migrate a base the sales team depends on.

You keep the core: tables with typed fields, linked records, filtered and grouped views, grid, gallery, form and kanban views, sharing, and a REST API.

You may lose, depending on the tool and edition: Airtable's automation builder and its large integration catalog, interface designer polish, and some field types. You also gain a job: running the server, upgrading it and backing it up.

If your base is small and your team is non-technical, Airtable may still be the better fit. If you have outgrown its limits, need data residency, or want the data in a real SQL database other tools can query, self-hosting pays off.

## NocoDB vs Baserow at a glance

The two tools look similar in a screenshot and differ underneath.

| | NocoDB | Baserow |
| --- | --- | --- |
| Core idea | A spreadsheet UI on top of a SQL database, including one you already have | A self-contained no-code database with its own storage |
| Stack | Node.js | Python (Django) and Vue |
| Data storage | SQLite by default, or PostgreSQL / MySQL; can connect external databases | PostgreSQL |
| Connect an existing database | Yes, a main selling point | No, data lives in Baserow |
| Views | Grid, gallery, form, kanban, calendar | Grid, gallery, form, kanban, calendar |
| API | REST, auto-generated per table | REST, auto-generated per table |
| Business model | Open source with paid cloud and enterprise plans | Open-core: free core, paid Premium and Enterprise features |
| Best for | Developers who want a UI over SQL data | Teams who want an Airtable-like app with the least surprises |

Both projects move fast and both put some features in paid tiers. Before you choose, check each project's pricing and license page for the specific features you need, such as row-level permissions, audit logs or SSO.

### When to choose NocoDB

Pick NocoDB when the data already exists in PostgreSQL or MySQL and you want non-developers to browse and edit it without giving them a SQL client. It turns tables into grids and generates an API on top. It is also the lighter of the two to run.

### When to choose Baserow

Pick Baserow when you are replacing Airtable for a team that builds its own bases from scratch. Its UI and concepts map closely to Airtable, and keeping all data inside Baserow means fewer ways to break things.

Other options worth a look: Grist is strong on spreadsheet formulas, and Teable is a newer project built on PostgreSQL.

## What the LogiStack templates deploy

Both templates are single services with one volume, which keeps them simple to run and back up.

| Template | Image | Port | Volume | Notes |
| --- | --- | --- | --- | --- |
| [NocoDB](/templates/nocodb/) | `nocodb/nocodb`, pinned by digest | 8080 | `nocodb-data` at `/usr/app/data` | Metadata in SQLite on the volume; health check on `/api/v1/health` |
| [Baserow](/templates/baserow/) | `baserow/baserow:1.25.2` | 80 | `baserow-data` at `/baserow/data` | All-in-one image with PostgreSQL and Redis inside, data on the volume |

Both ask for one thing: the public domain.

## Deploy NocoDB or Baserow

Install LogiStack on an Ubuntu or Debian server if you have not already:

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

Then:

1. Create a DNS record such as `tables.example.com` pointing at the server.
2. In a project, select **New service** › **Templates** and search `nocodb` or `baserow`.
3. Read **What it creates**: one service, one volume.
4. Enter your domain as the public URL.
5. Review and **Deploy**.

LogiStack requests the HTTPS certificate and routes the domain to the right port. When the service is healthy, open the URL and create the first account, which becomes the admin. Do this right away. The [templates guide](/docs/deploy/templates/) has each step with screenshots.

![A template detail page listing the services, ports and volumes a template creates](/docs/screens/template-detail.webp)

### Fix Baserow's public URL

The Baserow template sets `BASEROW_PUBLIC_URL` to `http://` plus your domain. Since Caddy serves the site over HTTPS, change it to `https://tables.example.com` on the `baserow` service's **Environment** tab and deploy. Baserow uses this value to build links in emails and to validate requests, so a mismatch shows up as broken links or login problems.

### Move NocoDB metadata to PostgreSQL

Out of the box, NocoDB stores its metadata and any tables you create inside it in SQLite on the volume. That is fine for a pilot. For a team, point it at PostgreSQL:

1. Create a managed PostgreSQL database in the same environment. See [databases](/docs/deploy/databases/).
2. On the `nocodb` service, add the `NC_DB` variable as a secret:

```text
NC_DB=pg://<db-service>:5432?u=<user>&p=<password>&d=<database>
```

3. Deploy.

Take the host, user, password and database name from the database's credentials. Do this before you build anything, because NocoDB does not move existing SQLite data for you. Use the internal hostname of your database service, never a public one.

## Connect NocoDB to an existing database

NocoDB's best-known feature is working on data you already have. In NocoDB, create a new data source and enter the connection details of your app database. The project has changed how it handles external data sources over time, so check that your version and edition include them. Two rules keep this safe:

- **Use a dedicated role with the least privilege.** If people only read data, grant `SELECT`. If they edit, grant `INSERT` and `UPDATE` on specific tables only. Managed LogiStack databases let you create such roles with per-table permissions from the database editor.
- **Never point it at production with schema rights.** A misclick in a spreadsheet UI can drop a column. Use a replica or a staging copy if people explore freely.

## Migrate from Airtable

Neither tool imports everything Airtable has, so plan for some manual work.

- **NocoDB** offers an Airtable import that reads a base through Airtable's API and recreates tables and records.
- **Baserow** offers an Airtable import from a shared base link.
- **Either**: export each table to CSV from Airtable and import it. This always works but loses linked-record relations, which you then rebuild.

After the import, check linked records, attachments, formulas and lookups table by table. Formula syntax differs between all three tools. Automations do not migrate; rebuild them as webhooks to a workflow tool such as [n8n](/templates/n8n/).

## Back up your bases

Everything lives in one volume per template, which makes backups simple but means the volume is all you have.

- **NocoDB with SQLite** or **Baserow**: create a volume backup policy for the data volume and turn on **Stop the service while archiving**. Both write to the database files all the time, and a copy taken mid-write can restore broken. The app is unavailable for the short time the archive takes, so schedule it at night.
- **NocoDB with a managed PostgreSQL database**: back up the database with a dump policy and keep **Verify on a schedule** on. Add a volume backup for `nocodb-data` too if people upload attachments there.

Send backups to a bucket on a different server. The [backups guide](/docs/data/backups/) covers destinations, encryption, retention and restores.

## Upgrades and performance

- **Pin and upgrade on purpose.** The Baserow template pins 1.25.2, an older release. Read Baserow's changelog, back up, then change the image tag in the service settings and deploy. Baserow runs migrations on start. Jumping several versions is usually supported, but test it on a copy first by deploying the template in a second environment and restoring a backup into it.
- **Give Baserow memory.** It runs PostgreSQL, Redis, the backend and workers in one container. Plan for at least 2 GB of RAM for Baserow itself.
- **Keep one replica.** Both templates keep state on a local volume. Do not scale them to several replicas.

## FAQ

### Is NocoDB or Baserow better?

NocoDB is better when you want a spreadsheet UI over an existing SQL database or a lighter install. Baserow is better as a drop-in Airtable replacement for a team that builds bases from scratch. Try both for a week with real data; each takes minutes to deploy.

### Are NocoDB and Baserow really free?

Both have a free self-hosted edition with the core features. Both also sell paid tiers for features such as advanced permissions, SSO or audit logs. Check each vendor's current plan page for what is included.

### Can I use NocoDB or Baserow as a backend for my app?

Yes. Both generate a REST API per table with token authentication. For a real product backend, though, a purpose-built option such as PocketBase or a headless CMS gives you more control over auth and validation.

### How many rows can a self-hosted Airtable alternative hold?

There is no artificial record limit when you self-host. The practical limit is your server and database. Millions of rows work, but very large tables load slower in a grid UI.

### Can I run both on one server?

Yes. Deploy each template in the same or a different project; each gets its own domain and volume. A 4 GB server runs both alongside LogiStack for a small team.

An open-source Airtable alternative gives your team the spreadsheet-database they like with data you own. [Install LogiStack](/#install), deploy NocoDB or Baserow, and add a verified backup in the same dashboard. If you are moving more internal tools off SaaS, our post on [homelab self-hosting](/blog/homelab-self-hosting/) covers the basics of running several apps on one machine.

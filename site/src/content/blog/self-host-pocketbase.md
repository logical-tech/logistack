---
title: "Self-host PocketBase: a Firebase alternative in one file"
description: "Self-host PocketBase as a Firebase alternative: deploy it with HTTPS, create the superuser, add JS hooks, and back up the SQLite data without corrupting it."
date: 2026-11-08
category: Self-hosting
keywords: self-host pocketbase, pocketbase docker, firebase alternative, open source firebase alternative, pocketbase deploy
---

You are building a side project, an internal tool or the first version of a mobile app. You need auth, a database, file uploads and realtime updates, and you don't want to write a backend or get locked into Firebase's pricing and proprietary APIs. If you self-host PocketBase, you get all four in a single Go binary with an admin dashboard, running on a server you control. This guide covers what PocketBase does well as a Firebase alternative, where it stops, and how to deploy it with HTTPS and safe backups.

## Why PocketBase works as a Firebase alternative

PocketBase is an open-source backend, MIT-licensed, that ships as one executable. Inside that file:

- **A database**: SQLite in WAL mode, with collections you define in the admin UI or in migrations.
- **Auth**: email and password, OAuth2 providers (Google, GitHub, Apple and many more), one-time passwords, and API rules per collection.
- **File storage**: uploads attached to records, on local disk or S3-compatible storage, with thumbnail generation for images.
- **Realtime**: clients subscribe to collections or single records over Server-Sent Events.
- **An admin dashboard** at `/_/` to manage data, users, rules, logs and settings.
- **Extensibility**: JavaScript hooks in `pb_hooks`, or use PocketBase as a Go framework.

Official SDKs exist for JavaScript and Dart (Flutter), which covers web and most mobile apps.

## PocketBase vs Firebase vs Supabase

Each makes different bets. Be honest about which fits your project.

| | PocketBase | Firebase | Supabase |
| --- | --- | --- | --- |
| Hosting | Self-hosted only | Google Cloud only | Hosted or self-hosted |
| Database | SQLite | Firestore (NoSQL) | PostgreSQL |
| License | MIT | Proprietary | Apache-2.0 |
| Auth | Built in, OAuth2 | Built in, many providers | Built in, many providers |
| Realtime | SSE subscriptions | Native, very mature | Postgres changes over WebSockets |
| Scaling model | One server, vertical | Managed, global | Postgres scaling, many services to self-host |
| Self-host effort | One container | Not possible | Many containers |
| Cost model | Your server | Usage-based | Plans or your servers |

Choose **PocketBase** when one server is enough, you value simplicity, and you are fine with SQLite. Choose **Firebase** when you need global scale without ops, push messaging and Google's mobile tooling, and accept the lock-in. Choose **Supabase** when you want PostgreSQL, SQL access and room to grow, and can run more moving parts.

Two caveats about PocketBase. First, it is still before version 1.0, and releases can include breaking changes; read the changelog before you upgrade. Second, it scales up, not out. SQLite has one writer, so you run one instance on a bigger server rather than several replicas. That is plenty for a lot of apps, but it is a hard ceiling to plan around.

## What the PocketBase template deploys

The [PocketBase template](/templates/pocketbase/) creates a single service:

| Setting | Value |
| --- | --- |
| Image | `ghcr.io/coollabsio/pocketbase`, pinned by digest |
| Port | 8080 |
| Volumes | `pocketbase-data` at `/app/pb_data`, `pocketbase-hooks` at `/app/pb_hooks` |
| Inputs | The public domain |

`pb_data` holds the SQLite databases and uploaded files: everything that matters. `pb_hooks` holds your JavaScript hooks and survives redeploys.

## Deploy PocketBase step by step

You need a server with LogiStack. A 2 GB VPS is enough for PocketBase and the platform:

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

Then deploy:

1. Create an A record such as `api.example.com` pointing at the server.
2. In a project, select **New service** › **Templates**, search `pocketbase` and open it.
3. Enter `api.example.com` as the public URL.
4. Review and **Deploy**.

Caddy issues the certificate and routes HTTPS to port 8080. The [templates guide](/docs/deploy/templates/) has screenshots of each step.

### Create the superuser

A fresh PocketBase has no admin account. Recent versions print a one-time installer link in the logs on first start. Open the `pocketbase` service's **Logs** tab, find the link that points at `/_/#/pbinstal/...`, replace the host with your domain if needed, and open it to create the superuser.

If you prefer the command line, open the **Terminal** tab of the service and run:

```bash
/usr/local/bin/pocketbase superuser upsert you@example.com 'a-long-generated-password' --dir=/app/pb_data
```

The binary path can differ by image; run `which pocketbase` first if the command is not found. The [logs and terminal guide](/docs/operations/logs-and-terminal/) shows how to open a shell in a running container without SSH.

Create the superuser right after the deploy. Until you do, anyone who finds the installer link first can claim the instance.

## Build your first collection and call it

In the admin at `https://api.example.com/_/`, create a `posts` collection with a `title` text field and a `published` bool. Set its API rules:

- **List/View rule**: `published = true` so anyone can read published posts.
- **Create/Update/Delete rule**: `@request.auth.id != ""` so only signed-in users can write.

From your front end, with the JavaScript SDK:

```js
import PocketBase from "pocketbase";

const pb = new PocketBase("https://api.example.com");

await pb.collection("users").authWithPassword("ada@example.com", "secret-password");

const posts = await pb.collection("posts").getList(1, 20, {
  filter: "published = true",
  sort: "-created",
});

pb.collection("posts").subscribe("*", (e) => {
  console.log(e.action, e.record.title);
});
```

The subscription keeps a long-lived SSE connection open. Caddy proxies it without extra settings.

## Add server logic with JS hooks

PocketBase runs JavaScript files from `pb_hooks` that end in `.pb.js`. Use them for custom routes, validation and side effects. A small example that adds a health route and stamps a slug on every new post:

```js
// pb_hooks/main.pb.js
routerAdd("GET", "/api/hello", (e) => {
  return e.json(200, { ok: true });
});

onRecordCreate((e) => {
  const title = e.record.get("title") || "";
  e.record.set("slug", title.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
  e.next();
}, "posts");
```

Upload the file into the `pocketbase-hooks` volume from the service's **Files** tab, then restart the service. For anything bigger, keep the hooks in Git and build your own image from a Dockerfile that copies `pb_hooks` and `pb_migrations` in, deployed [from Git](/docs/deploy/from-git/). That gives you reviewed changes and repeatable deploys.

## Production settings worth changing

In the admin, under **Settings**:

- **Application URL**: set it to `https://api.example.com` so emails contain the right links.
- **Mail settings**: add SMTP so verification and password reset emails go out. The default sender rarely reaches inboxes.
- **Rate limits**: turn them on for auth endpoints.
- **Files storage**: switch to S3 if you expect many uploads, or want them off the server. A bucket on self-hosted S3 storage works.
- **Superusers**: turn on multi-factor auth for superuser accounts.

On the LogiStack side, keep the service at **one replica**. Two instances writing to separate copies of SQLite would split your data. Set a memory limit with some headroom, and add a disk threshold alert on the node, since uploads and logs grow quietly until the volume is full.

## Back up PocketBase without corrupting SQLite

SQLite files copied while PocketBase writes to them can restore broken. You have two safe options, and using both is better.

1. **PocketBase's built-in backups.** Under **Settings** › **Backups**, schedule backups and, ideally, send them to S3. PocketBase creates a consistent ZIP of `pb_data`.
2. **A LogiStack volume backup.** On the `pocketbase` service, open **Backups**, choose the `pocketbase-data` volume, and turn on **Stop pocketbase while archiving**. The service scales to zero for the copy, then comes back. Schedule it at a quiet hour. Add a second policy for `pocketbase-hooks` if you edit hooks on the server.

Keep the destination on a different server. The [backups guide](/docs/data/backups/) covers encryption with your own key and retention, and our post on [database backup strategy](/blog/database-backup/) explains how often to test a restore.

## FAQ

### Is PocketBase production ready?

Many apps run PocketBase in production. It is pre-1.0, so expect breaking changes between some releases and read the changelog before each upgrade. Pin the image and upgrade on purpose.

### How many users can PocketBase handle?

A single server handles a lot: SQLite in WAL mode serves many concurrent readers, and writes are fast for typical app workloads. It cannot spread across several servers, so very write-heavy or global apps are better on PostgreSQL-based backends.

### Can PocketBase replace Firebase for a mobile app?

For auth, data, files and realtime, yes, with the JavaScript and Dart SDKs. Firebase features such as push messaging, analytics and crash reporting have no PocketBase equivalent, so you add separate services for those.

### Does PocketBase support PostgreSQL?

No. PocketBase is built on SQLite by design. If you need PostgreSQL, look at Supabase or a framework on top of a managed Postgres database.

### How do I migrate data out of PocketBase?

The data is plain SQLite files in `pb_data`, and every collection is reachable through the REST API. You can open the files with any SQLite tool or export through the API, which makes leaving easy.

PocketBase gives you a Firebase-style backend you can read, copy and move. [Install LogiStack](/#install), deploy the template, and you have auth, data and files with HTTPS and scheduled backups in a few minutes. If you are deploying the front end too, see our guide to [deploying a static site](/blog/deploy-static-site/).

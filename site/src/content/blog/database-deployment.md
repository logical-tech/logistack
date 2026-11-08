---
title: "Database deployment: run Postgres or MySQL in production"
description: "A practical database deployment guide: managed vs self-hosted, Docker volumes, private networks, credentials, limits, backups and safe upgrades."
date: 2026-11-08
category: Databases
keywords: database deployment, deploy postgres docker, self-hosted database, database in docker production, managed database vs self-hosted
---

Deploying the app is the easy part. You push, a container builds, traffic moves over. The database is where most teams hesitate, because a container you can throw away holds data you can't. This guide covers database deployment for small and mid-sized teams: when to pay for a managed service, how to run Postgres, MySQL or MongoDB yourself in containers, and the checklist that keeps a self-hosted database boring.

## Managed or self-hosted?

Start with the honest question: should you run the database at all?

| | Managed database (RDS, Cloud SQL, Neon, PlanetScale and similar) | Self-hosted database |
| --- | --- | --- |
| Monthly cost | Higher per GB and per vCPU, plus egress | Server cost only |
| Setup | Minutes | Minutes with a platform, longer by hand |
| Backups and point-in-time recovery | Built in | Your job, or your platform's |
| High availability | A checkbox, at a price | Real work: replication and failover tooling |
| Version and extension choice | Limited to what the provider supports | Anything the engine supports |
| Data location | Provider's regions | Your servers, your jurisdiction |
| Network latency to the app | Depends on region match | Same host or same private network |

Choose managed when the database is critical, you have no one to own operations, and you need automatic failover across zones today. Choose self-hosted when cost, data location or extension freedom matter, when your app and database sit on the same servers anyway, and when you can accept a few minutes of downtime during a failure in exchange for a much smaller bill. Many teams run staging and internal tools self-hosted and keep one critical database managed. That split is reasonable.

## Can you run a database in Docker?

Yes. The objection from a few years ago, "containers are ephemeral", is about the container, not the data. A database container writes to a volume, and the volume outlives the container. Official images for Postgres, MySQL, MariaDB, MongoDB and Redis are maintained, widely used, and handle first-boot initialization from environment variables.

What you have to get right is everything around the container: where the volume lives, who can reach the port, how the container updates, and what happens to the data when the server fails. The checklist below covers each.

## The database deployment checklist

### 1. Persistent storage on a named volume

Mount the data directory on a named volume, not inside the container's writable layer. The paths for official images:

| Engine | Data directory |
| --- | --- |
| PostgreSQL | `/var/lib/postgresql/data` |
| MySQL, MariaDB | `/var/lib/mysql` |
| MongoDB | `/data/db` |
| Redis | `/data` |

Put that volume on a local SSD. Network filesystems such as NFS add latency and can break the locking guarantees databases depend on. More on volume types in our [Docker volumes](/blog/docker-volumes/) guide.

### 2. A private network, no public port

A database almost never needs a port on the public internet. Put it on a private network with the apps that use it, and let them reach it by service name. If you must connect from your laptop, use an SSH tunnel or a VPN rather than opening 5432 to the world. Exposed databases are scanned within minutes of going online.

### 3. Generated credentials, kept as secrets

Generate a long random password for the superuser on first boot and store it as a secret, not in a compose file in Git. Then create a separate user for each app with only the rights it needs. If one app leaks its credentials, the others stay safe.

### 4. Pinned versions

Pin the image to a major version, such as `postgres:17`, never `latest`. A major version upgrade changes the on-disk format for Postgres, and a container that starts on a newer major version against an old data directory refuses to start.

### 5. Resource limits

Set a memory limit, and tune the engine to stay under it. A Postgres configured for 8 GB of `shared_buffers` in a 4 GB container gets killed under load. Leave headroom for the operating system's page cache, which databases rely on.

### 6. Health checks

Use the engine's own probe so the platform knows when the database is ready: `pg_isready`, `mysqladmin ping`, `mongosh --eval "db.adminCommand('ping')"` or `redis-cli ping`.

### 7. Backups that leave the server

Dump on a schedule, encrypt, upload to object storage at another provider, and test restores. The [database backup](/blog/database-backup/) guide walks through it.

### 8. Monitoring

Watch CPU, memory against the limit, disk usage and free space on the volume. A full disk is the most common way a self-hosted database goes down.

## A production-shaped example with Docker Compose

Here is a compose file that follows the checklist for Postgres and an app on one host:

```yaml
services:
  db:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_DB: shop
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD_FILE: /run/secrets/pg_password
    secrets:
      - pg_password
    volumes:
      - pgdata:/var/lib/postgresql/data
    networks:
      - backend
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d shop"]
      interval: 10s
      timeout: 5s
      retries: 5
    deploy:
      resources:
        limits:
          memory: 2g
    # No "ports:" section: only services on "backend" can reach it

  app:
    image: ghcr.io/acme/shop:1.42.0
    environment:
      DATABASE_URL_FILE: /run/secrets/database_url
    secrets:
      - database_url
    depends_on:
      db:
        condition: service_healthy
    networks:
      - backend
    ports:
      - "8080:8080"

volumes:
  pgdata:

networks:
  backend:

secrets:
  pg_password:
    file: ./secrets/pg_password.txt
  database_url:
    file: ./secrets/database_url.txt
```

Compose is a fine way to run this on one server. It leaves some parts to you, such as updates and TLS.

## Databases on Docker Swarm and multi-node clusters

Once you have more than one server, a database needs a few extra rules.

- **Pin it to one node.** A local volume exists on one machine. If the scheduler moves the database to another node, it starts with an empty data directory. Use a placement constraint so it always runs where its volume lives.
- **Update stop-first.** Rolling updates normally start the new container before stopping the old one. Two database processes on one data directory corrupt it. Stop the old one first and accept a short gap.
- **Replicas are not high availability.** Setting `replicas: 3` on a Postgres service starts three independent databases on three empty volumes. High availability for databases means replication inside the engine, plus failover tooling such as Patroni for Postgres or Group Replication for MySQL.

This is one of the places where Docker Swarm and Kubernetes differ less than people expect: both leave database replication to the engine or to an operator built for it.

## Connections and pooling

Each Postgres connection is a separate process with its own memory. Fifty app replicas with a pool of 20 each make 1,000 connections, which is more than a small server can carry. Size pools from the database's side: decide the total the server can handle, then divide by replicas. Put PgBouncer in front when you can't. MySQL handles many connections more cheaply, but the same arithmetic applies.

## Upgrades without surprises

- **Minor versions** (17.4 to 17.6) are drop-in: pull the new image and restart.
- **Major versions** need a data migration: dump and restore, `pg_upgrade`, or logical replication into a new instance. Never change the major tag on an existing volume and hope.
- Rehearse on a copy restored from last night's backup before you touch production.

The [database migration](/blog/database-migration/) guide covers moving data between versions and servers in detail.

## Database deployment with LogiStack

[LogiStack](/features/) applies this checklist when you create a database, so you don't write the compose file yourself. From **New service** › **Database** you pick an engine and version (PostgreSQL, MySQL, MariaDB, MongoDB, Redis or libSQL) and a name. LogiStack then:

- Runs the official image on a persistent volume, pinned to the node that holds the volume, and updates it stop-first.
- Generates credentials, stores them encrypted as secret variables, and uses URL-safe characters so they drop into a connection string.
- Keeps the database private: it has no public domain step and is reachable only by its service name inside the environment's network.
- Applies a resources profile to cap CPU and memory.
- Adds a **Database** tab with a table editor, SQL console and a wizard to create per-app roles.
- Adds a **Backups** tab for scheduled, encrypted dumps to S3 with restore checks.

The step-by-step guide is in [create a managed database](/docs/deploy/databases/), and metrics and alerts are covered in [service and node metrics](/docs/operations/metrics/).

The honest trade-offs: LogiStack runs on Docker Swarm, not Kubernetes, and doesn't set up replication or automatic failover for you. A database runs as one instance with its data on one node, so a node failure means restoring from backup or waiting for the node. For many apps that is an acceptable cost for a much simpler setup; for some, a managed database is the right call.

## FAQ

### Is it safe to run a production database in Docker?

Yes, with a named volume on local disk, a pinned image version, a private network, resource limits and tested backups. Containers add little overhead for databases. Most incidents come from missing backups or a full disk, not from Docker.

### Should my database run on the same server as my app?

For small and mid-sized apps it often should: latency is lower and the setup is simpler. Separate them when the database needs most of the server's memory, or when you want to scale app servers without touching the database.

### Do I need Kubernetes to run databases?

No. Kubernetes operators such as CloudNativePG automate failover well, but they add a whole platform to learn. A single node with good backups, or Docker Swarm with the database pinned to one node, covers most teams. Compare the options in [Docker Swarm vs Kubernetes](/blog/docker-swarm-vs-kubernetes/).

### How do I connect to a private database from my laptop?

Use an SSH tunnel, such as `ssh -L 5432:localhost:5432 user@server` when the port is bound on the host, or a VPN into the private network. Or skip the client entirely and use a web-based editor on the platform that already has access.

A good database deployment is mostly decisions made once: where data lives, who can reach it, how it updates and how it comes back. If you'd rather start from those decisions already made, [install LogiStack](/#install) and create your first database from the dashboard.

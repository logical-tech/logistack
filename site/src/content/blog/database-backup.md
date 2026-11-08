---
title: "Database backup: a strategy that survives a real restore"
description: "Plan a database backup strategy that works: dumps vs snapshots, schedules, off-site S3 storage, encryption, retention and tested restores."
date: 2026-11-08
category: Databases
keywords: database backup, postgres backup, mysql backup, backup to s3, backup strategy, restore testing
---

Most teams learn their database backup is broken on the day they need it. The cron job stopped six weeks ago, the dump is empty because the password changed, or the files sit on the same disk that just failed. This guide shows you how to build a database backup routine that holds up when something goes wrong: what to copy, how often, where to keep it, how to encrypt it, and how to prove it restores.

The examples use PostgreSQL, MySQL, MariaDB, MongoDB and Redis, because those cover most small and mid-sized stacks.

## What your backups have to survive

Start from the failures, not from the tools. A backup is only useful against the failures it was designed for.

- **Disk or server loss.** The VPS dies, the provider loses a volume, or a node never comes back after a reboot.
- **Human error.** Someone runs `DELETE FROM orders` without a `WHERE`, or drops the wrong table in a console.
- **A bad migration.** A deploy rewrites a column and corrupts half the rows before anyone notices.
- **Compromised credentials.** An attacker with your server's keys can delete the database and every backup that key can reach.
- **Account problems.** A billing dispute or a suspended account at one provider locks you out of everything stored there.

Each item changes the design. Server loss means backups must live somewhere else. Human error and bad migrations mean you need several points in time, not just last night. Compromised credentials mean the server should not be able to read or rewrite old backups freely. Account problems mean a second provider for the copies you can't lose.

## Logical dumps vs physical backups

There are two families of database backup, and they solve different problems.

| | Logical dump | Physical backup |
| --- | --- | --- |
| What it copies | SQL statements or an engine archive (`pg_dump`, `mysqldump`, `mongodump`) | The data files on disk, or a filesystem snapshot |
| Size | Smaller, compresses well | Close to the size of the data directory |
| Restores to | Any server with a compatible engine version | The same engine version and usually the same layout |
| Point-in-time recovery | No, only the moment of the dump | Yes, when combined with WAL or binlog archiving |
| Speed on large databases | Slow to restore past tens of gigabytes | Fast, mostly file copy |
| Typical tools | `pg_dump`, `mysqldump`, `mariadb-dump`, `mongodump` | pgBackRest, Barman, WAL-G, Percona XtraBackup, volume snapshots |

For most applications under a few hundred gigabytes, a scheduled logical dump is the right default. It is portable, easy to inspect, and you can restore it into a newer major version. Move to physical backups with WAL archiving when you need recovery to a specific second, or when restore time from a dump becomes longer than you can afford to be down.

## How often to back up: RPO and RTO

Two numbers decide your schedule.

- **Recovery point objective (RPO):** how much data you can afford to lose. A nightly dump means up to 24 hours of writes are gone in the worst case.
- **Recovery time objective (RTO):** how long you can be down while you restore. A 40 GB dump might take an hour to load.

Write both numbers down and check them against reality. If the business says "we can't lose more than an hour of orders", nightly dumps don't meet that, and hourly dumps on a large database may overlap each other. That is the point where point-in-time recovery earns its complexity.

A reasonable starting point for a small product:

- Production database: a dump every 6 hours, or nightly plus before every risky deploy.
- Staging and internal tools: nightly.
- Caches like Redis used only as a cache: no backup at all. Rebuild them.

## Backup commands for each engine

Whatever runs your schedule, the commands underneath look like these. Use a dedicated user with read access where the engine allows it.

```bash
# PostgreSQL: custom format, compressed, restorable table by table
pg_dump --format=custom --no-owner \
  --dbname="postgres://backup:secret@db.internal:5432/shop" \
  --file="shop-$(date -u +%Y%m%dT%H%M%SZ).dump"

# MySQL: consistent snapshot of InnoDB tables without locking writers
mysqldump --single-transaction --routines --triggers --all-databases \
  -h db.internal -u backup -p > "mysql-$(date -u +%Y%m%dT%H%M%SZ).sql"

# MariaDB
mariadb-dump --single-transaction --all-databases \
  -h db.internal -u backup -p > "mariadb-$(date -u +%Y%m%dT%H%M%SZ).sql"

# MongoDB: one archive file, gzip inside
mongodump --uri="mongodb://backup:secret@db.internal:27017/?authSource=admin" \
  --archive="mongo-$(date -u +%Y%m%dT%H%M%SZ).archive" --gzip

# Redis: ask for a fresh RDB snapshot, then copy dump.rdb from the data dir
redis-cli -h redis.internal -a "$REDIS_PASSWORD" BGSAVE
```

A few details matter more than they look:

- `--single-transaction` gives MySQL and MariaDB a consistent view only for InnoDB tables. MyISAM tables still need locks.
- `pg_dump` custom format lets `pg_restore` run in parallel with `-j` and restore a single table when you only need one.
- Timestamps in UTC keep file names sortable and avoid confusion around daylight saving changes.
- Check the exit code. A dump that fails halfway still leaves a file behind.

## Where to store backups

The rule that matters most: **not on the same server.** A backup on the machine you lose doesn't help. S3-compatible object storage is the usual answer, because every backup tool can write to it and the storage is cheap per gigabyte.

| Option | Worth knowing |
| --- | --- |
| AWS S3 | The reference API. Object Lock and lifecycle rules are mature. |
| Cloudflare R2 | No egress fees, so pulling a large backup down to restore is cheap. |
| Backblaze B2 | Low storage cost, S3-compatible API. |
| Hetzner Object Storage | Close to Hetzner servers, EU locations. |
| Wasabi | Bills deleted objects for a 90-day minimum, so short retention costs the same as 90 days. |
| Self-hosted (MinIO, Garage, SeaweedFS) | Full control. Must run on different hardware than the database to count as off-site. |

Create a bucket per purpose and a key that reaches only that bucket, with the four permissions backups need: put, get, delete and list. If your provider supports object lock or versioning, turn it on for the bucket that holds production backups, so a stolen key can't erase history.

If you run your own storage, read our guide on [self-hosted S3 storage](/blog/self-hosted-s3-storage/) for the trade-offs between engines.

## Encrypt before upload

Your dump contains password hashes, emails and anything else your users gave you. Encrypt it on the server, before it leaves, so the bucket only ever holds ciphertext. [age](https://age-encryption.org) is a small, modern tool that fits this job well.

```bash
# Once: create a key pair and store the private key off the server
age-keygen -o backup-key.txt
# Public key: age1q3...  (safe to keep on the server)

# Each run: dump, encrypt with the public key, stream to the bucket
pg_dump --format=custom --dbname="$DATABASE_URL" \
  | age -r age1q3examplepublickey \
  | aws s3 cp - "s3://acme-backups/db/shop-$(date -u +%Y%m%dT%H%M%SZ).dump.age" \
      --endpoint-url "$S3_ENDPOINT"
```

The server only needs the public key to encrypt. Keep the private key in a password manager or another place that doesn't depend on the server. If you lose the key, the backups are noise.

## Retention: how many backups to keep

Without retention, the bucket grows forever. With retention that is too aggressive, the backup from before the bug is already gone when you discover the bug. Two simple rules cover most needs:

- **Keep the newest N backups.** Protects you when the schedule stops: the last good copies never expire just because time passed.
- **Keep anything younger than N days.** Gives you a window to discover silent data corruption.

Combine them: keep the newest 14 plus anything up to 30 days old. For compliance or accounting data, add a monthly copy kept for a year in a separate bucket.

## Test restores, or you don't have backups

This is the step almost everyone skips. A backup you never restored is a hope, not a backup. Things that break silently:

- The dump user lost a permission and the file contains only the schema.
- The engine was upgraded and the old client can't read the new format.
- The encryption key in your password manager belongs to a different policy.
- The restore takes four hours, and nobody knew.

Schedule a restore test. Pull the newest backup, load it into a throwaway container, and run a sanity query:

```bash
docker run -d --name restore-test -e POSTGRES_PASSWORD=test postgres:17
sleep 10
docker cp latest.dump restore-test:/tmp/latest.dump
docker exec restore-test pg_restore -U postgres -d postgres --no-owner /tmp/latest.dump
docker exec restore-test psql -U postgres -c "select count(*) from orders;"
docker rm -f restore-test
```

Alert when the test fails, the same way you alert when the backup fails. Time the restore too, and compare it with your RTO.

## Database backup automation with LogiStack

Wiring all of the above by hand means cron, shell scripts, credentials on disk and a test job you will eventually forget. [LogiStack](/features/) builds it into every database service, so the same routine runs for Postgres, MySQL, MariaDB, MongoDB, Redis and libSQL.

![The new backup policy wizard for a PostgreSQL service](/docs/screens/backup-new.webp)

A backup policy covers one database or one volume and gives you:

- **The right dump per engine:** `pg_dump` custom format, `mysqldump` and `mariadb-dump` with `--single-transaction`, `mongodump --archive`, an RDB snapshot for Redis, or a compressed tar of any volume.
- **A cron schedule in your time zone,** with a preview of the next five runs.
- **Any S3-compatible destination:** AWS S3, Cloudflare R2, Backblaze B2, Hetzner, MinIO, Wasabi or a generic S3 store. The destination is tested before it is saved. See [S3 destinations](/docs/data/s3-destinations/).
- **age encryption on the server.** The dashboard shows the exact `aws s3 cp ... | age -d` command to decrypt a backup without LogiStack.
- **Retention** by count, by age, or both.
- **Scheduled restore checks** that load the newest backup into a throwaway container and run a sanity query. The live database is never touched.
- **Alerts** for failed backups and failed checks, sent to your notification channels.

When you need the data back, the [restore wizard](/docs/data/restore/) loads a backup into a new service beside the original by default, so you can compare before you overwrite anything. The full setup is in the [backups docs](/docs/data/backups/).

## FAQ

### How often should I back up my database?

Match the schedule to how much data you can afford to lose. Nightly is the minimum for anything in production, and every few hours is common for databases that take orders or payments. Always take an extra backup right before a risky migration.

### Is a volume snapshot a good database backup?

Only if the database is stopped or the snapshot is crash-consistent and the engine supports recovering from it. A copy of the data directory taken while the database writes can restore with half-written pages. A logical dump is safer for most teams, and a volume archive with the service stopped is a good fallback for engines like SQLite.

### Should database backups be encrypted?

Yes, when they leave the server. Encrypt before upload, so the storage provider and anyone with the bucket keys see only ciphertext. Keep the private key outside the server, or a lost server takes the key with it.

### How long should I keep backups?

Keep at least two weeks of daily backups, so you can recover from problems found a few days late. Add monthly copies kept longer if accounting, legal or customer contracts ask for them. Check your storage provider's minimum billing period before you set short retention.

### How do I know my backups work?

Restore them on a schedule into a throwaway database and run a query that proves the data is there. Alert on failures. Time the restore so you know your real recovery time.

A good database backup is boring: it runs, it's encrypted, it lives elsewhere, and a test proves it restores every week. If you'd rather get that routine without the scripts, [install LogiStack](/#install) on your server and add a backup policy to your database in a few minutes. For the bigger picture of running databases yourself, read [database deployment](/blog/database-deployment/) next.

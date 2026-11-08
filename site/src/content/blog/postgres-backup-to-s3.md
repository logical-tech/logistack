---
title: "Postgres backup to S3: pg_dump by hand vs automated"
description: "Back up Postgres to S3 with pg_dump: a safe script, credentials, cron or systemd, lifecycle retention, restore checks, and when to automate it all."
date: 2026-11-08
category: Databases
keywords: postgres backup to s3, pg_dump to s3, postgresql backup s3, pg_dump cron, automated postgres backups
---

A Postgres backup to S3 looks like a one-line job: pipe `pg_dump` into `aws s3 cp` and add it to cron. That one-liner is also how teams end up with a bucket full of zero-byte files, because a pipe hides the exit code of the command that failed. This guide builds the job properly by hand: a script that fails loudly, credentials that stay out of argv, a scheduler that tells you when it stops, retention on the bucket side, and a restore check. Then it compares that with letting a platform do the same work.

The strategy behind it (why off-site, how often, how long to keep, why encrypt) is in [database backup](/blog/database-backup/). This post is the Postgres-specific implementation.

## What you need

- `pg_dump` with a major version **equal to or newer** than the server's. A `pg_dump` 15 against a Postgres 17 server refuses to run. In Docker, the easy fix is to run the dump inside a container from the same `postgres:<major>` image.
- The AWS CLI v2, or any S3 client. The AWS CLI works with any S3-compatible service through `--endpoint-url`, including Cloudflare R2, Backblaze B2, Hetzner and self-hosted MinIO or Garage.
- A bucket at a different provider than your database server.
- [age](https://age-encryption.org) for encryption, with the private key stored off the server.

## Step 1: a backup role and a bucket key

Don't back up with the superuser if you can avoid it. Since PostgreSQL 14, the predefined `pg_read_all_data` role can read every table:

```sql
CREATE ROLE backup LOGIN PASSWORD 'long-random-value';
GRANT pg_read_all_data TO backup;
```

On the bucket side, create a key that can only write and list in one prefix. For AWS S3, a minimal policy looks like this:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::acme-backups/postgres/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::acme-backups",
      "Condition": { "StringLike": { "s3:prefix": ["postgres/*"] } }
    }
  ]
}
```

Leave out `s3:DeleteObject` and let lifecycle rules handle retention (step 4). An attacker who gets this key can then add files but not erase your history.

## Step 2: the backup script

```bash
#!/usr/bin/env bash
# /usr/local/bin/pg-backup-s3
set -euo pipefail

: "${PGHOST:?}" "${PGDATABASE:?}" "${S3_BUCKET:?}" "${AGE_RECIPIENT:?}"
S3_PREFIX="${S3_PREFIX:-postgres}"
STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
KEY="${S3_PREFIX}/${PGDATABASE}/${STAMP}.dump.age"
ENDPOINT_ARGS=()
[[ -n "${S3_ENDPOINT:-}" ]] && ENDPOINT_ARGS=(--endpoint-url "$S3_ENDPOINT")

# 1. Dump to a local temp file first, so a failure can't upload a partial file
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pg_dump --format=custom --compress=6 --no-owner --file="$TMP/db.dump"

# 2. Check the archive is readable before shipping it
pg_restore --list "$TMP/db.dump" > /dev/null

# 3. Roles and grants are not in pg_dump; keep them alongside (needs superuser)
if [[ "${DUMP_GLOBALS:-0}" == "1" ]]; then
  pg_dumpall --globals-only --no-role-passwords > "$TMP/globals.sql"
  age -r "$AGE_RECIPIENT" "$TMP/globals.sql" \
    | aws s3 cp - "s3://${S3_BUCKET}/${S3_PREFIX}/${PGDATABASE}/${STAMP}.globals.sql.age" "${ENDPOINT_ARGS[@]}"
fi

# 4. Encrypt and upload
age -r "$AGE_RECIPIENT" -o "$TMP/db.dump.age" "$TMP/db.dump"
aws s3 cp "$TMP/db.dump.age" "s3://${S3_BUCKET}/${KEY}" "${ENDPOINT_ARGS[@]}" --only-show-errors

echo "uploaded s3://${S3_BUCKET}/${KEY} ($(stat -c %s "$TMP/db.dump.age") bytes)"
```

Why it is shaped this way:

- **`set -euo pipefail`** makes any failing command, including one in the middle of a pipe, stop the script with a non-zero exit.
- **Dump to disk, then upload.** Streaming straight into S3 saves disk space, but a dump that dies halfway still leaves a valid-looking object in the bucket. Writing locally first means only complete, checked files leave the server. If disk is tight, stream and check `PIPESTATUS`, and pass `--expected-size` to `aws s3 cp` for dumps over 50 GB so the multipart upload sizes its parts correctly.
- **`pg_restore --list`** reads the archive's table of contents. It catches truncated and corrupt files in a second, without restoring anything.
- **Custom format** compresses, and lets `pg_restore` restore in parallel with `-j` or pull back a single table.
- **No password in argv.** `pg_dump` reads credentials from the environment or a password file, never from a command-line flag, so they don't show up in `ps`.

## Step 3: credentials and scheduling

Put the settings in an environment file readable only by root:

```bash
# /etc/pg-backup-s3.env  (chmod 600)
PGHOST=127.0.0.1
PGPORT=5432
PGUSER=backup
PGPASSWORD=long-random-value
PGDATABASE=shop
S3_BUCKET=acme-backups
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AGE_RECIPIENT=age1examplepublickey...
```

Cron works, but a systemd timer gives you logs in the journal, a clear failure state, and catch-up runs after downtime:

```ini
# /etc/systemd/system/pg-backup-s3.service
[Unit]
Description=Postgres backup to S3
After=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/pg-backup-s3.env
ExecStart=/usr/local/bin/pg-backup-s3
ExecStartPost=/usr/bin/curl -fsS -m 10 https://hc-ping.com/your-check-uuid
```

```ini
# /etc/systemd/system/pg-backup-s3.timer
[Unit]
Description=Run the Postgres backup every 6 hours

[Timer]
OnCalendar=*-*-* 00/6:00:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pg-backup-s3.timer
systemctl list-timers pg-backup-s3.timer
```

The `ExecStartPost` ping goes to a dead man's switch: a service such as Healthchecks.io (or a self-hosted copy) that alerts you when the ping **stops** arriving. That catches the failure you would otherwise miss: the job not running at all. `ExecStartPost` runs only when the script succeeds, so a failed backup also means no ping. [Uptime monitoring](/blog/uptime-monitoring/) covers heartbeat checks in more detail.

If Postgres runs in Docker and the host has no matching `pg_dump`, run the script in a container from the same image as the database, on the same Docker network, and pass the env file with `--env-file`.

## Step 4: retention with lifecycle rules

Delete old backups with a bucket lifecycle rule instead of from the script. The server's key then never needs delete permission.

```json
{
  "Rules": [
    {
      "ID": "expire-postgres-backups",
      "Filter": { "Prefix": "postgres/" },
      "Status": "Enabled",
      "Expiration": { "Days": 30 }
    }
  ]
}
```

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket acme-backups --lifecycle-configuration file://lifecycle.json
```

Most S3-compatible providers support lifecycle expiration, with varying feature sets; check yours. A pure age rule has one weakness: if backups stop for 30 days, the last good one expires too. Your dead man's switch should fire long before that. Turn on versioning or object lock on the bucket if you want deleted or overwritten objects to stay recoverable.

## Step 5: prove it restores

A backup you never restored is a hope. Add a weekly job that downloads the newest file, decrypts it and loads it into a throwaway container:

```bash
#!/usr/bin/env bash
set -euo pipefail
ENDPOINT_ARGS=(--endpoint-url "https://<account-id>.r2.cloudflarestorage.com")  # empty () for AWS S3
LATEST="$(aws s3 ls "s3://acme-backups/postgres/shop/" "${ENDPOINT_ARGS[@]}" \
  | awk '/\.dump\.age$/ {print $4}' | sort | tail -n 1)"

aws s3 cp "s3://acme-backups/postgres/shop/${LATEST}" - "${ENDPOINT_ARGS[@]}" \
  | age -d -i /root/backup-key.txt > /tmp/verify.dump

docker run -d --name pg-verify -e POSTGRES_PASSWORD=verify postgres:17.6
until docker exec pg-verify pg_isready -U postgres; do sleep 1; done
docker cp /tmp/verify.dump pg-verify:/tmp/verify.dump
docker exec pg-verify pg_restore -U postgres -d postgres --no-owner /tmp/verify.dump
docker exec pg-verify psql -U postgres -tAc "select count(*) from orders"
docker rm -f pg-verify && rm -f /tmp/verify.dump
```

This one needs the private key, so run it somewhere other than the production server: a separate machine, or a CI job with the key as a secret. Alert if the row count is zero or lower than yesterday's by more than you expect.

## The hand-rolled job: what you now maintain

Count the parts: a backup role, a bucket policy, a script, an env file, a systemd unit and timer, a heartbeat check, a lifecycle rule, an age key pair, a restore script and somewhere to run it. Multiply by every database you run. Each part is simple, and each is one more thing that drifts: a password rotation that nobody copied into the env file, a major upgrade that leaves `pg_dump` one version behind, a new database nobody added a timer for.

That is fine for one or two databases and a team that likes owning the details. It gets fragile as the number grows.

## The same job in LogiStack

[LogiStack](/features/) is an open-source PaaS you run on your own servers. For a managed PostgreSQL database, the **Backups** tab replaces the pieces above with a policy you create in a wizard ([backups docs](/docs/data/backups/)):

![The new backup policy wizard for a PostgreSQL service](/docs/screens/backup-new.webp)

| Part of the job | By hand | LogiStack backup policy |
| --- | --- | --- |
| Dump | `pg_dump` custom format in your script | `pg_dump` in custom format, compressed |
| Destination | Bucket, key and endpoint in an env file | An S3 destination, or SFTP, WebDAV, Azure, Google Drive, B2 or a node folder |
| Schedule | systemd timer or cron | Cron with a time zone and a preview of the next runs |
| Encryption | age, key pair you manage | age on the server, key shown once to save; a ready decrypt command in the dashboard |
| Retention | Bucket lifecycle rule | Keep the newest N, delete after N days, or both |
| Restore test | Your own script and machine | Scheduled verify restores the newest backup into a throwaway container |
| Failure alerts | Dead man's switch | Failed backups and verifies go to your notification channels |
| Restore | `pg_restore` by hand | A wizard: into a new service beside the original, or overwrite |
| Checksums and history | Your logs | Run history with size, duration and SHA-256 |

Backups stay readable without LogiStack: the files are plain `pg_dump` archives encrypted with age, and the [restore docs](/docs/data/restore/) show the exact `aws s3 cp | age -d | pg_restore` commands for the day the server is gone.

What LogiStack does not add: point-in-time recovery. Backups are dumps at the times you schedule, so your recovery point is the interval between them. If you need restore-to-the-minute, run pgBackRest or WAL-G with WAL archiving, by hand or alongside.

## FAQ

### Can I pipe pg_dump directly to S3?

Yes, with `pg_dump ... | aws s3 cp - s3://...`, but add `set -o pipefail` and check that the dump completed, or a failed dump uploads a truncated file. Writing to a temp file first and checking it with `pg_restore --list` is safer when you have the disk space.

### Should I use pg_dump or pg_dumpall for S3 backups?

Use `pg_dump` per database in custom format: it is compressed and supports parallel and selective restore. Add `pg_dumpall --globals-only` to capture roles and grants, which `pg_dump` leaves out. A full `pg_dumpall` produces plain SQL only, which is slower and less flexible to restore.

### How do I keep old backups from filling the bucket?

Use a lifecycle rule on the bucket to expire objects after a set number of days. It keeps delete permission away from the server's key. Make sure an alert fires if backups stop, or the rule eventually expires your last good copy.

### How do I back up Postgres running in Docker to S3?

Run `pg_dump` from a container using the same `postgres` image as the database, on the same Docker network, so the client and server versions match. Then encrypt and upload the file from that container or the host.

If you'd rather have a policy than a pile of scripts, [install LogiStack](/#install), create a PostgreSQL database, and set up an encrypted S3 backup with restore checks in a couple of minutes.

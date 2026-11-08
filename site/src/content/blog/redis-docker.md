---
title: "Redis in Docker for production: Redis or Valkey, done right"
description: "Run Redis in Docker in production: persistence, passwords and ACLs, memory limits, eviction, kernel settings, and when to switch to Valkey."
date: 2026-11-08
category: Databases
keywords: redis docker, redis docker compose, valkey docker, redis production, redis persistence
---

Running Redis in Docker takes one line: `docker run redis`. Running it in Docker in production takes a few more decisions, and skipping them is how teams end up with a cache that loses sessions on every deploy, a queue that silently drops jobs when memory fills, or an open port that a botnet turns into a crypto miner. This guide covers the settings that matter for Redis in Docker, how they differ when Redis is a cache versus a store, and when Valkey is the better image to pull.

## Redis or Valkey?

In 2024 Redis moved from the BSD license to a dual source-available license (RSALv2 and SSPL), and in 2025 Redis 8 added AGPLv3 as a third option. In response, the Linux Foundation forked the last BSD release into **Valkey**, with backing from AWS, Google, Oracle and others. Valkey is BSD-licensed and wire-compatible with Redis: the same protocol, the same commands, the same clients.

For most apps, the choice comes down to this:

| | Redis | Valkey |
| --- | --- | --- |
| License | RSALv2, SSPL or AGPLv3 (Redis 8) | BSD-3-Clause |
| Governance | Redis Ltd. | Linux Foundation |
| Official image | `redis` | `valkey/valkey` |
| CLI | `redis-cli` | `valkey-cli` (also answers to `redis-cli` in the image) |
| Client libraries | Any Redis client | Any Redis client |
| Bundled modules in 8.x | JSON, search, time series, probabilistic types | Separate modules, such as `valkey-json` and `valkey-bloom` |

If you self-host for your own app, either license is fine for internal use. Pick Valkey if you want a permissive license with no strings, or if your cloud provider's managed cache already moved to it. Pick Redis 8 if you want the bundled JSON and search features in one image. The rest of this guide applies to both; swap the image and the CLI name.

## A production Docker Compose file

```yaml
services:
  redis:
    image: redis:8.2.2
    restart: unless-stopped
    command:
      - redis-server
      - /usr/local/etc/redis/redis.conf
    volumes:
      - redis-data:/data
      - ./redis.conf:/usr/local/etc/redis/redis.conf:ro
    healthcheck:
      test: ["CMD-SHELL", "redis-cli -a \"$$REDIS_PASSWORD\" --no-auth-warning ping | grep PONG"]
      interval: 10s
      timeout: 3s
      retries: 5
    environment:
      REDIS_PASSWORD: ${REDIS_PASSWORD}
    deploy:
      resources:
        limits:
          memory: 1g
    networks:
      - internal

volumes:
  redis-data:

networks:
  internal:
```

And the matching `redis.conf`:

```ini
bind 0.0.0.0
port 6379
protected-mode yes
requirepass change-me-to-a-long-random-value

# Memory: stay under the container limit, leave room for fork and buffers
maxmemory 700mb
maxmemory-policy noeviction

# Persistence: AOF for durability, RDB for compact snapshots
appendonly yes
appendfsync everysec
save 900 1
save 300 10
save 60 10000
dir /data
```

No `ports:` section: apps on the `internal` network reach Redis at `redis:6379`, and nothing else does.

## Cache or store? Decide first

Most Redis misconfigurations come from not deciding what the instance is for. The answer changes three settings:

| | Pure cache | Store (sessions, queues, rate limits) |
| --- | --- | --- |
| `maxmemory-policy` | `allkeys-lru` or `allkeys-lfu` | `noeviction` |
| Persistence | Off, or RDB only | AOF on, plus RDB |
| Backups | None; rebuild from the source | Yes, scheduled |

With `noeviction`, Redis returns an error on writes when memory is full. That sounds harsh, and it is the right choice for a job queue: an error your app logs is far better than a job that silently disappears. With an `allkeys-*` policy, Redis drops old keys to make room, which is exactly what a cache should do.

If you need both, run two instances. A cache and a queue in the same Redis share one memory limit and one eviction policy, and one of them will be wrong.

Queue libraries are specific about this. BullMQ, for example, requires `maxmemory-policy noeviction` and warns at startup if it is set otherwise. Sidekiq has the same requirement for its job data.

## Persistence: RDB, AOF or both

Redis keeps everything in memory. Persistence decides what survives a restart.

- **RDB snapshots** write the whole dataset to `dump.rdb` at intervals set by `save` rules. Compact and fast to load, but you lose everything written since the last snapshot.
- **AOF (append-only file)** logs every write. With `appendfsync everysec`, you lose at most about one second of writes on a crash. The file is larger and Redis rewrites it in the background to compact it.
- **Both** is the usual production choice for a store: AOF for durability, RDB for compact backups. Since Redis 7, the AOF is a set of files under `/data/appendonlydir`.

Whatever you choose, the data directory must be on a volume. Without one, every redeploy starts Redis empty.

## Memory limits and the fork problem

Background saves and AOF rewrites `fork()` the Redis process. The child shares memory with the parent through copy-on-write, but every page the parent changes during the save gets copied. On a busy instance, memory use can approach double during a save.

Two consequences:

1. **Set `maxmemory` well under the container limit.** A common starting point is 60 to 75% of the limit. If the container hits its limit, the kernel kills Redis.
2. **Set `vm.overcommit_memory = 1` on the host.** Without it, Linux may refuse the fork on a large instance and the save fails with `Can't save in background: fork: Cannot allocate memory`. Redis logs a warning at startup when this is not set.

```bash
# On the Docker host, not in the container
echo 'vm.overcommit_memory = 1' | sudo tee /etc/sysctl.d/99-redis.conf
sudo sysctl --system
```

Redis also warns about Transparent Huge Pages, which add latency to forks. Setting THP to `madvise` or `never` on the host removes the warning. Both are host settings: containers share the host's kernel, so you cannot fix them from inside the image.

## Security: password, ACLs and no public port

Redis was designed for trusted networks. An exposed, passwordless Redis is one of the most scanned targets on the internet, because `CONFIG SET` and `SLAVEOF` let an attacker write files and load code.

- **Never publish 6379 to the internet.** Keep it on a private network. For access from your laptop, use an SSH tunnel or a VPN.
- **Always set a password** with `requirepass`, or better, ACL users.
- **Use ACLs for multiple apps.** Give each app a user that can touch only its own key prefix:

```bash
ACL SETUSER worker on >another-long-random-value ~jobs:* +@all -@dangerous
ACL SETUSER web on >third-long-random-value ~sess:* ~cache:* +@read +@write
```

Persist ACL users with an `aclfile` setting, or put `user` lines in `redis.conf`, so they survive a restart.

- **Rename or disable dangerous commands** if old clients force you to share the default user. With ACLs, removing `@dangerous` from app users is the cleaner way.

## Backups

For a store, back up the RDB file. Trigger a fresh snapshot, wait for it to finish, then copy `dump.rdb` off the server:

```bash
redis-cli -a "$REDIS_PASSWORD" --no-auth-warning BGSAVE
# Wait until rdb_bgsave_in_progress is 0
redis-cli -a "$REDIS_PASSWORD" --no-auth-warning INFO persistence | grep rdb_bgsave_in_progress
docker cp "$(docker compose ps -q redis)":/data/dump.rdb "./redis-$(date -u +%Y%m%dT%H%M%SZ).rdb"
```

To restore, stop Redis, put the file in the data directory as `dump.rdb`, and start it. If AOF is on, Redis loads the AOF instead of the RDB on startup, so either restore the AOF directory too or start once with `appendonly no`, then run `CONFIG SET appendonly yes` to rebuild the AOF from the loaded data.

Encryption, off-site storage and retention apply here as for any database. [Database backup](/blog/database-backup/) covers the strategy.

## Monitoring the numbers that matter

`INFO` tells you almost everything:

```bash
redis-cli -a "$REDIS_PASSWORD" --no-auth-warning INFO memory | grep -E "used_memory_human|maxmemory_human|mem_fragmentation_ratio"
redis-cli -a "$REDIS_PASSWORD" --no-auth-warning INFO stats | grep -E "evicted_keys|rejected_connections|keyspace_hits|keyspace_misses"
```

- **`used_memory` vs `maxmemory`**: alert at 80%.
- **`evicted_keys`**: should be zero on a store. Any value means you are losing data.
- **Hit ratio** (`keyspace_hits / (hits + misses)`): for a cache, a falling ratio means it is too small.
- **`mem_fragmentation_ratio`**: far above 1.5 means wasted memory; `activedefrag yes` can help.
- **Slow log**: `SLOWLOG GET 10` shows commands that blocked the server. `KEYS *` in production code is the usual culprit; use `SCAN`.

Container-level CPU and memory charts catch the rest. [Container monitoring](/blog/container-monitoring/) covers the tooling.

## Run Redis or Valkey on LogiStack

[LogiStack](/features/) is an open-source PaaS you install on your own servers. It runs Redis as a managed database: from **New service** › **Database**, pick Redis 8.2 or 7.4 on the official image. LogiStack generates `REDIS_PASSWORD`, stores it as an encrypted secret variable, keeps the data on a persistent volume, and makes the instance reachable only inside the environment as `redis://:<REDIS_PASSWORD>@redis:6379` ([create a managed database](/docs/deploy/databases/)).

![The Database tab of a Redis service, listing keys with their types](/docs/screens/database-redis.webp)

The **Database** tab browses and edits keys of every type and runs commands, so you can check a queue or clear a key without `redis-cli` ([database editor](/docs/data/database-editor/)). The **Backups** tab schedules RDB snapshots to S3, encrypted with age ([backups](/docs/data/backups/)). To restore Redis, LogiStack uses a volume backup of the data directory, so add a volume policy as well if you need a one-step restore.

Prefer Valkey? The [Valkey template](/templates/valkey/) deploys `valkey/valkey` 8.1 with a password, AOF and RDB persistence on a volume, and a health check. Note that it sets `maxmemory-policy noeviction`, the right default for queues; change it in the config file if you use it as a cache.

The honest limit: LogiStack runs one instance per database, with no Redis replication, Sentinel or Cluster. For a cache or a queue on a small team that is usually enough. For Redis that must survive a node failure without a restore, run Sentinel yourself or use a managed service.

## FAQ

### Should I use Redis or Valkey in Docker?

Both work the same for your app, since clients and commands are compatible. Choose Valkey for a BSD license and Linux Foundation governance, or Redis 8 for its bundled JSON and search modules. Moving existing data between them depends on the data file format: Valkey reads files from Redis 7.2 and earlier, but newer Redis releases changed the format. Check compatibility, or migrate keys with a replication or dump tool, before you switch.

### Does Redis in Docker lose data on restart?

Only if the data directory isn't on a volume or persistence is off. Mount `/data` on a named volume and turn on AOF or RDB. With `appendfsync everysec`, a crash loses at most about one second of writes.

### What maxmemory policy should I use?

Use `noeviction` for anything you can't lose: queues, sessions, rate-limit counters. Use `allkeys-lru` or `allkeys-lfu` for a pure cache. If you need both behaviors, run two instances.

### Why does Redis warn about overcommit_memory?

Redis forks to save snapshots and rewrite the AOF. Without `vm.overcommit_memory = 1`, Linux can refuse that fork when free memory looks too low, and the save fails. Set it on the Docker host, since containers share the host kernel.

If you want Redis or Valkey running with a password, a volume and scheduled backups without writing the config by hand, [install LogiStack](/#install) on your server and create one from the dashboard.

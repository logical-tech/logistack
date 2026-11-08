# Traffic analytics

Per-service traffic analytics with no client script by default, plus an optional tiny first-party script. Gaps in host metrics are filled in the same pass. Coolify added traffic analytics in v4.4. This plan covers what we take from the best-known open projects and why.

We take ideas only and copy no code. Licenses: Umami is MIT. Plausible's server is AGPL-3.0 and its tracker is MIT. OpenPanel is AGPL-3.0. Beszel is MIT.

## What we take

### Plausible

- **Daily rotating salt.** Plausible hashes `salt + domain + IP + user agent` with a random salt. A cron rotates the salt at UTC midnight and deletes it after 48 hours, so a visitor from last week can never be linked to today's. We do the same. The API keeps a random 16-byte salt per UTC day in Redis with a 48-hour TTL and hands today's and tomorrow's salts to the agents. The salt never reaches Postgres.
- **No raw IP, no cookies.** The IP and user agent go into the hash on the node and are then dropped.
- **Short beacon fields** (`n`, `u`, `r`) for the optional script, which keeps it under 1 KB.
- **The referrer source is the referrer's host**, and `utm_source` overrides it. We skip their large referrer-name database.
- **The country DB they use for self-hosters.** It is DB-IP Lite (see Countries below).

### Umami

- **UTM parsing.** We read source, medium and campaign from the page URL the script reports. Click IDs (gclid and the like) are ignored on purpose: they identify an ad click.
- **Self-referrals are dropped.** A referrer on the same host is not counted.
- **Bots are counted and kept out.** Umami filters bots on the user agent server-side. We do the same with a short pattern list. Bot requests still count as requests, but never as visitors or pageviews.
- **`hostname` + `path` as the page key**, with the query string removed. Queries carry tokens and personal data.

### OpenPanel

OpenPanel is product analytics: funnels, profiles, cohorts and session replay. All of that is out of scope. Only the idea of a single event shape (`name` + page) carries over, and custom events reuse the pageview pipeline.

### Beszel

Beszel's agent reads host metrics from `/proc` and sysfs, and per-container stats from the Docker Engine API. It keeps rollups at 1m/10m/20m/120m/480m with a separate max. LogiStack already has per-container CPU, memory, network and block I/O, plus host CPU, load, memory, swap, disks and network, with 1m/1h rollups. The cheap gaps we fill:

| Beszel metric | LogiStack before | Now |
|---|---|---|
| Host disk I/O (read/write bytes/s) | missing | `/proc/diskstats`, whole physical disks only |
| Temperatures (hwmon) | missing | `/sys/class/hwmon/*/temp*_input`, hottest sensor stored |
| CPU iowait / steal | folded into idle | `iowaitPercent`, `stealPercent` |
| GPU (nvidia-smi, rocm-smi) | missing | **skipped:** needs vendor CLIs in the agent image |
| Battery, Wi-Fi, SMART, ZFS, systemd | missing | **skipped:** not server-relevant or not cheap |
| Per-interface network | summed | kept summed |

## Countries

DB-IP Lite Country is CC BY 4.0, needs no account and comes as an 8 MB MMDB file at `download.db-ip.com/free/dbip-country-lite-YYYY-MM.mmdb.gz`. Its only conditions are attribution and a monthly refresh, which makes it acceptable. The other options do not fit:

- **MaxMind GeoLite2:** the EULA forbids redistribution and needs a license key.
- **IPinfo Lite:** CC BY-SA and needs a token.
- **IP2Location LITE:** needs a login.

The agent downloads DB-IP on start and once a month, and looks up the country on the node. Only the ISO code is aggregated. The UI credits "IP Geolocation by DB-IP" with a link. Setting `LOGISTACK_AGENT_GEOIP=false` turns this off.

## Design

```
Caddy (JSON access log on stdout, already on)
  -> agent follows the local Caddy container's log
  -> parse, attribute to a domain, aggregate per (minute, domain)
  -> bounded outbox (unacked minutes), `traffic` frame
  -> API: XADD ls:traffic, then `traffic.ack`
  -> worker: upsert traffic_1m (idempotent replace), roll into traffic_1h
  -> REST /services/{id}/traffic, /traffic (org overview) -> web Analytics tab
```

- **Attribution.** The agent gets `traffic.config` with the route table: hostname, path prefix, domain, service and org. It matches routes the way Caddy does: exact host before wildcard, then the longest prefix. The Caddy compiler is unchanged for this. Its access log was already JSON on stdout.
- **Per-minute aggregate.** One aggregate per node and domain holds:
  - request count and status-class counts;
  - bytes in and bytes out;
  - a log-scale latency histogram: 8 buckets per doubling (about 4.5% error), mergeable across nodes and minutes, which makes p50/p95/p99 over any range exact to the bucket;
  - top paths, referrers, countries, UTM sources and events, each capped (see Bounds);
  - pageviews and bot request count;
  - a HyperLogLog sketch of visitor hashes.
- **Unique visitors.** HyperLogLog with p=10 (1,024 registers, about 3% error) over the salted hash. Sketches merge with max, so a resent minute cannot double count, and merging nodes or hours stays exact. No hash is ever stored; registers cannot be turned back into hashes.
- **Pageviews without a script.** A pageview is a `GET` that answered 2xx and asked for `text/html`, from a user agent that is not a bot.
- **Bounds.** The agent's memory is bounded:
  - at most 2,000 distinct domain-minute aggregates open;
  - top-k maps capped at 500 keys, then cut to 50 when the minute closes;
  - an outbox of closed minutes capped at 8 MiB of JSON, oldest dropped first and counted.

  While the API is unreachable, the outbox fills and then sheds. It never grows.
- **Idempotency.** `traffic_1m` has primary key `(node_id, domain_id, ts)` and a resend replaces the row. `traffic_1h` is recomputed from minutes, like the metric rollups.
- **Retention.** `traffic_1m` is partitioned by day and dropped with the monitoring minute retention. `traffic_1h` follows the hour retention.
- **Autoscaler hook.** `TrafficSignal` in `packages/core` gives requests/s and p95 for a service over a window. The worker implements it over `traffic_1m`. The autoscaler does not call it yet.

## Optional script

The script is toggled per domain (`domain.web_analytics`). When it is on, the Caddy route for that domain serves two paths before the upstream:

- `/_ls/a.js`: a script of about 700 bytes that sends pageviews, including SPA `pushState` navigations, and exposes `window.lsa(name)` for custom events;
- `/_ls/e`: answers `204` with no body. The script calls it with `GET` and `keepalive`, using query fields `n` (event name), `u` (page path and UTM), `r` (referrer) and `w` (width).

Both are served by Caddy on the user's own domain, so the script is first party and needs no CORS. The beacon lands in the same access log, so the agent counts it in the same aggregate. Script pageviews replace the heuristic pageviews for that domain. The `/_ls/*` requests themselves are not counted as traffic. Props on custom events, funnels and profiles are out of scope.

## Not done

- Referrer source names ("Google", "Hacker News") from a referrer database.
- GPU and SMART metrics.
- Bounce rate and visit duration, which need sessions and therefore state per visitor.

# Uptime monitoring and public status pages

Status: v1 built on `feat/uptime-status-14a91b`. LogiStack had CPU/RAM thresholds and crash-loop alerts only; this adds external checks, incidents, maintenance windows and public status pages.

## What we studied

Ideas only. We copied no code and kept no code open while writing ours.

| Project | License | What we take | What we leave |
|---|---|---|---|
| [Uptime Kuma](https://github.com/louislam/uptime-kuma) | MIT | A `pending` state between a first failure and `down`. A shorter retry interval while a failure is being confirmed, so "down" lands within one interval. Push monitors at `/api/push/<token>?status=&msg=&ping=`, where an explicit `status=down` skips retries. One reminder per certificate threshold day, remembered so it fires once. Badge kinds (status, uptime). | Resend counted in checks (we count minutes). Incidents with no lifecycle. Maintenance that skips checks entirely (we keep the data). |
| [Gatus](https://github.com/TwiN/gatus) | Apache-2.0 | Two thresholds, failures to go down and successes to come back, as the whole flap story. Response time as a pass/fail condition. Uptime badges per window. Retention by rolling up. | The free-text condition DSL (`[BODY].x == y`, `len()`, `pat()`). It is powerful but needs a parser, error messages and docs, and it does not fit a guided wizard. We expose the same checks as typed fields (status patterns, keyword, JSON path equals, max latency). A DSL can come later as one more field. |
| [openstatus](https://github.com/openstatusHQ/openstatus) | AGPL-3.0 | Incident lifecycle `investigating → identified → monitoring → resolved` as a timeline of updates, where the latest update sets the status. Status pages with a custom domain. Maintenance shown as its own colour on the bars. | Multi-region SaaS probes (see "Not built"). Plan gating (rule 9). |
| [Kener](https://github.com/rajnandan1/kener) | MIT | Status precedence: maintenance over live checks. Auto-opened incidents from monitors. Uptime computed over non-maintenance checks only. Statuses up, degraded, down, maintenance, no data for each day. | JS `eval` monitors (a sandbox we would have to secure). RRULE maintenance (see "Shortcuts"). |

## Model

- **monitor**: kind `http | tcp | dns | tls | push`, typed `config` (`packages/contracts/src/uptime.ts`), timing (`intervalSec`, `retryIntervalSec`, `timeoutMs`), confirmation (`downAfter`, `upAfter`), `resendMinutes`, `autoIncident`. It is optionally tied to a project, service and domain.
- **monitor_check**: raw results, kept 48 hours. `region` is `worker` for now.
- **monitor_hourly** (30 days) and **monitor_daily** (400 days): every check increments the counters with an upsert. Downsampling therefore needs no rollup job and no watermark, and the 90-day bars read 90 rows.
- **incident** + **incident_update**: an incident lists affected monitors. A monitor going down opens at most one open incident (partial unique index), and coming back up resolves it with an automatic update.
- **maintenance_window**: a UTC span, optionally repeated daily or weekly. Listed monitors report `maintenance`, send no alerts, and their checks are stored but left out of uptime.
- **status_page**: slug, optional custom hostname, sections of monitors with public labels, theme (accent, appearance, logo, website), history days.

## Flap handling (packages/core/src/uptime.ts)

`streak` counts consecutive equal results (negative for failures). The confirmed status flips only when `|streak|` reaches `downAfter` or `upAfter`. While a failure is unconfirmed, the next check runs after `retryIntervalSec` instead of `intervalSec`. With the defaults (60 s, retries every 20 s, down after 3), a service that stops at T is reported down at about T + 40 s to T + 100 s, inside one interval after the retries. A monitor that alternates fail/pass never reaches 3 and never alerts. `monitor.up` fires only after a confirmed `down`, never from `pending`.

## Scheduling

Postgres holds `next_check_at` (rule 1). A BullMQ Job Scheduler fires an `uptime` tick every 5 s. The tick claims due monitors with `update … where id in (select … for update skip locked) returning`, so several worker replicas never run the same check. It enqueues one `check` job per monitor, with job id `check:<id>` so the same monitor never runs twice at once. The same tick marks silent push monitors as failed and, once an hour, deletes expired raw and rolled-up rows.

## SSRF

Every target host goes through `resolvePublic` from `@logistack/providers` (the shared SSRF helper). The connection is pinned to the checked address, with the original Host header and TLS SNI. Redirects are followed by hand, at most 5, and each hop is checked again. DNS monitors refuse a private resolver IP unless the instance allows private hosts.

## Events

- `monitor.down` / `monitor.up` (resource `monitor:<id>`, payload `MonitorEventPayload`, with `projectId` / `serviceId` so scoped rules match).
- `certificate.expiring` (already declared, never emitted until now) from TLS monitors, once per threshold day.

All of them reach the existing notification rules.

## Status pages

The API server renders them as plain HTML with no client JS: fast, cacheable, readable without a session.

- `/status/<slug>` on the dashboard host.
- `https://<hostname>/` for a custom domain. The worker adds one Caddy route per published page with a hostname, pointing at the API upstream, through the same `ProxyRoute` path the local registry uses. `compile.ts` is untouched. The API recognises the Host header and serves the page.
- Badges: `/status/<slug>/badge/<monitorId>.svg?type=status|uptime&days=30`.
- JSON: `/status/<slug>/summary.json`.

## Not built (follow-ups)

- **Checks from several nodes through the agent.** It needs a new agent RPC type, an agent-side checker with the same SSRF pinning, and a quorum rule (any/majority/all). None of the four projects documents a quorum, so it is worth doing well rather than cheaply. The `region` column is ready for it.
- **A Gatus-style condition DSL** as an advanced field.
- **Subscribers** (email on incident updates), RSS/Atom feeds, password-protected pages.

## Shortcuts

- Maintenance repeats are UTC spans, so a weekly window drifts by an hour across DST. Upgrade to RRULE + timezone when users ask.
- A day's colour comes from check counts (≥ 99.9 % up, ≥ 99 % degraded, else down), not from time spent down.

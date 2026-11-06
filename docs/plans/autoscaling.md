# Service autoscaling plan

Goal: a user who has never configured an autoscaler turns it on in under a minute and gets sane behaviour. They pick **how few and how many copies** and **one of three behaviours**. Everything else (targets, windows, cooldowns) has a default and lives behind "Advanced".

Scope of v1: `application` services only, horizontal scaling (replicas), on CPU (and optionally memory). Databases, storage, games and compose stay manual: they are stateful or have their own scaling story.

## What already exists

- `ApplicationSpec.replicas` (`packages/contracts/src/service-spec.ts`). The Settings form edits it as a plain number (`apps/web/src/components/service/settings-form.tsx:609`).
- `compileService` sets `Mode.Replicated.Replicas` from `spec.replicas` (`packages/core/src/compile-service.ts:434`).
- The reconciler treats any replica count other than `desiredReplicas(row)` as drift and patches it back without a rollout (`apps/worker/src/reconcile.ts:105`, `:221`). It skips services with a running deployment or a paused backup (`busy`, `paused`).
- Per-container CPU and memory samples in `metric_container_raw`, keyed by `service_id` (agent → `metrics-consumer.ts`).
- `evaluateServiceThresholds` (`apps/worker/src/thresholds.ts`) already averages those samples per container over a window, under a Redis lock, from the `monitoring.ts` loop. The autoscaler is the same shape.
- Resource profiles (Nano/Small/Medium/Large) give services a CPU limit. CPU % only means something against a limit.
- Events + notification rules (`packages/contracts/src/events.ts`), audit log, MCP tools generated from the REST API.

## Design

### Where the replica count lives (rule 1)

The autoscaler never talks to Docker. It writes the replica count to Postgres; the reconciler converges Swarm to it like any other drift.

New table `service_autoscale` (additive migration, rule 10):

| column | meaning |
|---|---|
| `service_id` PK, FK cascade | |
| `enabled` | |
| `min_replicas`, `max_replicas` | 1 ≤ min ≤ max ≤ 20 |
| `behavior` | `balanced` \| `responsive` \| `economical` \| `custom` |
| `target_cpu`, `target_memory` | percent of the limit; `target_memory` null = ignored |
| `replicas` | the autoscaler's current decision; null until the first pass |
| `last_scaled_at`, `last_reason` | for the UI and the cooldown |

`spec.replicas` keeps meaning "replicas when autoscaling is off", so a manifest apply or a pending-diff never fights the autoscaler and turning it off returns to the manual value.

One function decides the count and both callers use it:

```ts
// packages/core
effectiveReplicas(service, autoscale?) =
  stopped ? 0 : autoscale?.enabled && autoscale.replicas != null
    ? autoscale.replicas : spec.replicas
```

- `desiredReplicas` in `reconcile.ts` uses it.
- `compileInput` passes it to `compileService` (pure, new optional input), so a deploy starts at the current scaled count, not back at `spec.replicas`.

### The decision (pure, in `packages/core/src/autoscale.ts`)

```ts
decideScale({ current, min, max, cpu, memory, target, lastScaledAt, lastDirection, now, pendingTasks })
  -> { replicas, reason } | undefined
```

- `cpu`/`memory`: average across running replicas over the window (not the worst one: one hot replica is a balancing problem, not a capacity one).
- Proportional rule: `want = ceil(current × usage / target)`, ignored within ±10 % of target (no flapping).
- **Up fast:** 1-minute window, at most doubling (and at most +4) per step, 60 s cooldown.
- **Down slow:** 5-minute window, −1 per step, 3-minute cooldown after any change.
- Clamp to `[min, max]`. If `current < min` or `> max` (user just edited the range) move there immediately.
- **Hold** when: no samples in the window, a deployment is running, a backup pause owns the service, or tasks from the last scale-up are still `pending` (the cluster is out of room: scaling further only queues more).
- Memory is a second vote: the larger `want` wins on the way up; down only when both agree.

Behaviour presets set only the target, so they're easy to explain:

| preset | CPU target | copy shown to the user |
|---|---|---|
| Responsive | 45 % | "Adds copies early. Fastest under spikes, uses more resources." |
| Balanced (default) | 60 % | "Good for most web apps." |
| Economical | 75 % | "Runs as few copies as possible. Can be slower during spikes." |

Table tests for every rule above, no I/O.

### The loop (worker)

`apps/worker/src/autoscale.ts`, run from `monitoring.ts` via `every("autoscale", 30_000, …)` under `withLock("ls:lock:autoscale")`:

1. Load enabled `service_autoscale` rows joined to running application services.
2. One query per service for window averages from `metric_container_raw` (reuse the `SERVICE_EXPR` expressions from `thresholds.ts`, averaged across containers instead of `max`).
3. `decideScale`; on a change, update `replicas`, `last_scaled_at`, `last_reason` and kick the reconcile queue.
4. Publish `service.scaled` (new event type, payload `{ from, to, reason, cpu, memory }`) and write an audit row with the system actor. Notification rules can then route it to Slack/email like any other event.

### Guard rails at enable time

`PUT` refuses (400 with a reason the UI shows as a check) when:

- the service has no CPU limit: "Pick a size first". The wizard offers the resource profiles inline;
- it has a named volume or a host bind mount: copies would either fight over one disk or each get their own. Shared/remote volumes can lift this later;
- it publishes a port in `host` mode (two copies can't bind the same port on one node).

Warnings, not blockers: no healthcheck ("new copies get traffic before they're ready"), a single node in the cluster ("all copies share one server's CPU").

### API (`apps/server/src/routes/`)

- `GET /services/:id/autoscale` → settings + current state + the checks above.
- `PUT /services/:id/autoscale` → `mutation("service.autoscale", …)`, `requirePermission("write", …)`, zod at the boundary.
- `POST /services/:id/autoscale/preview` → runs `decideScale` over the last 24 h of rollups and returns the replica curve it *would* have produced. Pure function over history, so it is cheap and honest.

MCP tools come from the OpenAPI as usual (`service_autoscale`, `get_services_by_id_autoscale`).

Manifest: `autoscale: { min, max, behavior }` on application services in `docs/MANIFEST.md` and `manifest-plan.ts`.

### UI (rule 8: guided wizard)

Service → Settings → **Scaling** replaces the bare "Replicas" input with a segmented control: **Fixed** | **Automatic**.

Fixed: today's number field.

Automatic opens a four-step wizard:

1. **Ready check.** The guard rails as a checklist with the fix inline (pick a size, add a healthcheck). Blockers disable Next.
2. **Range.** A dual-thumb slider "Between 1 and 4 copies", with a live cost line: "Up to 4 × Small = 2 CPU, 2 GB RAM". Default min 1 (or the current replicas), max 3.
3. **Behaviour.** Three cards (Responsive / Balanced / Economical), Balanced preselected. "Advanced" disclosure for custom CPU/memory targets.
4. **Summary + preview.** "With these settings, yesterday this service would have run between 1 and 3 copies" over a small chart of the preview curve on top of real CPU. If there is not enough history: "Not enough data yet, the preview appears after a day of traffic."

After enabling:

- Service header: `2 copies · auto 1–4` badge.
- Metrics tab: replica count as a step line overlaid on the CPU chart, so cause and effect are visible.
- Overview activity: "Scaled 2 → 3, CPU 78 % above target 60 %" from `last_reason` / events.

## Out of scope (named, not built)

- Scale to zero: needs Caddy to hold requests while a copy starts. Separate feature.
- Request-rate / latency signals from Caddy: the proxy doesn't export them per service yet.
- Compose services, databases, node autoscaling (adding servers).
- Scheduled scaling ("4 copies weekdays 9–18"): later, on top of the same `replicas` column.

## PRs

1. **AS-1 core + schema.** `service_autoscale` migration, contracts, `effectiveReplicas`, `decideScale` + table tests, reconciler and `compileInput` use `effectiveReplicas`. No behaviour change while no row exists.
2. **AS-2 worker loop.** `autoscale.ts` loop, `service.scaled` event, audit. Integration test on the dev Swarm with `ls-test-autoscale-*` objects: a CPU-burning image scales 1 → 2, then back after load stops.
3. **AS-3 API.** GET/PUT/preview, guard rails, manifest field. Route tests incl. 403 and each refusal.
4. **AS-4 UI.** Scaling section + wizard, header badge, replica overlay, activity entries. Mock data for screenshots.
5. **AS-5 docs.** `docs-site` page "Scale a service automatically" (WRITING.md style) with screenshots.

AS-1 → AS-2 → AS-3 → AS-4 in order; AS-5 after AS-4.

## Open questions

- Max replicas cap: fixed 20, or an org-level limit admins set?
- Should `service.scaled` notify by default, or only when the service hits `max` ("at the ceiling for 10 minutes")? The second is quieter and more useful.

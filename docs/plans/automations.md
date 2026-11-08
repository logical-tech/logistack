# Automations plan

Goal: a visual workflow editor (xyflow canvas, n8n-like) that automates anything LogiStack can do. A user wires a **trigger** to **steps** (LogiStack operations, control flow, code, HTTP, notifications, the AI Agent), publishes it, and watches each run light up on the same canvas.

Decisions below come from the planning interview of 2026-11-07.

## Decisions

| Area | Decision |
|---|---|
| Use cases in scope | Event reactions, scheduled operations, pipelines/promotions with approval, external integrations |
| Existing features | Notification rules and Schedules **stay as they are**. Automations are an extra tool, not a replacement |
| Identity | One **automation bot per org**; each automation declares its **own scopes** (projects, operations, `destructive`). Audit log shows `bot via <automation>` |
| Data between nodes | **Inline JavaScript expressions** `{{ trigger.payload.deploymentId }}`, evaluated in QuickJS |
| Code node | Yes, **QuickJS wasm** inside the worker: no network, no filesystem, CPU/memory/time limits. Same runtime as expressions |
| Control flow (v1) | If/Switch, Wait (delay, wait-for-event), Approval, Loop over items, Parallel + Merge, per-node retry with backoff, error output |
| Durability | **Durable steps**: every step persisted in Postgres, exact resume after worker crash or LogiStack update; every node idempotent by key |
| Actions | **Every OpenAPI operation** becomes a node automatically (same catalog as Agent tools); ~20 common ones get curated forms and icons |
| Integrations | Generic HTTP node (credentials from Secrets), existing notification channels as "Send message", connected providers (Git, DNS/Cloudflare, S3) as dedicated nodes, signed webhook triggers (Stripe, GitHub, generic HMAC) |
| Scope | Org-level; triggers and actions filter by project/environment/service |
| Versions | Draft / Published immutable versions; runs pin their version. Test run with fake or past real payloads. Export to the manifest (`logistack.yaml`) |
| Loops | **Causality chain** on events; stop with a visible error past depth 3 or when the same automation reappears |
| Concurrency | Per automation: `allow` / `queue` / `forbid` (skip) / `replace`, optional concurrency key (e.g. per service), optional debounce |
| Destructive ops | Allowed only if the automation's scopes include `destructive`; otherwise the editor requires an Approval node before them (publish is blocked) |
| Test run | Writes are **simulated by default** (plausible fake output), reads are real; per-node toggle to run for real |
| Run view | Live overlay on the canvas (running / ok / error), node inspector (input, output, logs, duration), re-run from a failed node, run list with filters |
| Templates | 8-10 curated at launch |
| Retention | Per-org setting, default 30 days; step output capped (256 KB, truncated beyond); secret values never stored in clear |
| Navigation | Top-level **Automations** item in the sidebar |
| Failure | New event `automation.failed` on the bus, so existing notification rules route it |
| Extra triggers | Manual with an input form (button, command palette, API/MCP), sub-workflow (call another automation with typed input/output), metric threshold (e.g. CPU > 80% for 5 min) |
| Agent node | **Like the chat**: all tools within the automation's scopes, destructive calls pause the run on an approval exactly like the chat |
| AI generation | Describe in words, the Agent draws the graph as a draft to review |
| Approvals | Node names who can approve (role or members), deadline and timeout action. In-app inbox with sidebar badge. Notifications carry a signed link to the approval page (login required) |
| Release | Three phases (below) |

## What already exists

- Event bus: `ls:events` Redis channel, `EventEnvelope` and 26 `eventTypes` (`packages/contracts/src/events.ts`), publishers in `apps/worker/src/bus.ts` and `apps/server/src/events.ts`.
- Cron: `apps/worker/src/schedules.ts`, `schedulers.ts`; concurrency enum `forbid | allow | replace` (`packages/contracts/src/enums.ts:188`).
- Operation catalog: `invokeTool` in `apps/server/src/mcp.ts`, used by the Agent (`apps/server/src/ai/agent.ts`) to call any OpenAPI route as an actor via `createApp(deps, { actor })`.
- Agent runs, approvals (`approval-requested`, `POST .../approvals`), live frames over `/ws`.
- Notification channels and rules, Secrets (envelope crypto, references), service accounts and grants, audit log, metric thresholds (`apps/worker/src/thresholds.ts`).
- `@xyflow/react` 12 already used by `network-map.tsx` and `schema-diagram.tsx`.
- Inbound webhooks (`apps/server/src/routes/webhooks.ts`) and SSRF guard (`apps/worker/src/ssrf.ts`).

## Design

### Data model (additive migrations, rule 10)

| table | purpose |
|---|---|
| `automation` | id, org, name, description, enabled, `published_version_id`, `draft` (graph JSON), scopes, concurrency mode/key/debounce, failure settings |
| `automation_version` | immutable published graph + scopes + compiled trigger index; `number`, `published_by`, `published_at` |
| `automation_trigger` | denormalized from the published version for fast matching: kind (`event`, `cron`, `webhook`, `manual`, `metric`, `subflow`), filter, next cron fire, webhook secret ref |
| `automation_run` | version, status (`queued`, `running`, `waiting`, `succeeded`, `failed`, `cancelled`), trigger payload, causality chain, concurrency key, test flag, started/finished |
| `automation_step` | run, node id, attempt, status, input, output (capped), error, idempotency key, started/finished, `resume_at` / `wait_for` |
| `automation_approval` | step, approvers (role/members), deadline, timeout action, decided_by/at, decision, signed token hash |

Graph JSON lives in a zod schema in `packages/contracts` (`AutomationGraph`: nodes with `type`, `params`, `position`; edges with `sourceHandle` for `true/false`, `case:n`, `error`, `item`, `done`). Parsed at the API boundary, trusted inside (rule 7).

The automation bot is a service account per org (`kind = automation`), created on first use. A run executes as `actor = bot`, narrowed to the automation's scopes; the audit entry carries `automationId` and `runId`.

### Engine (worker)

- New BullMQ queue `automation`. A job is "advance run R". The processor takes a per-run Redis lock, loads run + steps, computes the ready frontier from the graph, executes ready nodes, persists each step **before and after** execution, enqueues the next advance. Pure scheduling logic (`nextSteps(graph, steps) -> NodeId[]`) lives in `packages/core` with snapshot tests (rule 2 spirit).
- Idempotency: each step has key `runId:nodeId:iteration` (no attempt: a retry after a crash must reuse it). LogiStack operations receive it as an `Idempotency-Key` header so a crash between call and persist does not double-deploy. **No route honors this today** (verified 2026-11-07, see Risks), so phase 1 adds it once, in the server, not per route: every mutating route is already wrapped by `mutation()` (`apps/server/src/audit.ts:136`), which gains an idempotency middleware. Table `idempotency_key` (key, actor, route, request hash, status, response body, created_at; TTL 24 h): same key + same request returns the stored response, same key + different request is `409`, a key still in flight is `409 retry later`.
- Waits: `Wait` sets `resume_at` (delayed job); wait-for-event and approvals set `wait_for` and the run goes `waiting`. A worker restart rebuilds delayed jobs from rows with `resume_at` (the DB is the source of truth, Redis is a cache).
- Retry: per node `{ attempts, backoff }`; after the last failure the error edge runs if present, else the run fails and publishes `automation.failed`.
- Loop/parallel: `Loop` fans out one branch per item (iteration index in the step key, configurable max parallelism); `Merge` waits for all inbound branches.
- Limits (instance settings): max steps per run, max loop items, max run duration, QuickJS memory/time per evaluation.

### Triggers

- **Event**: a bus listener in the worker matches `automation_trigger` by event type + filter (project/env/service, payload expression). Events gain an optional `causedBy: { runId, automationId, depth }[]`; anything an automation does through `invokeTool` propagates it. Depth > 3 or a repeat automation in the chain: run is not started, a visible `automation.loop_blocked` entry appears.
- **Cron**: reuse the schedules scheduler math; timezone per trigger.
- **Webhook**: `POST /hooks/a/<triggerId>`; verifiers for Stripe, GitHub and generic HMAC (secret from Secrets). Body size cap, replay window for timestamped signatures.
- **Manual**: input form schema defined on the trigger node; exposed in UI, command palette, REST (`POST /automations/:id/runs`) and therefore MCP.
- **Metric**: piggyback on the `thresholds.ts` loop (same window averaging), fires once on crossing, re-arms on recovery.
- **Sub-workflow**: `Call automation` node starts a child run and waits; input/output schemas typed on the child's trigger.

Concurrency is checked when a trigger fires: compute the key, then apply `allow` / `queue` / `forbid` / `replace` (cancel the running one); debounce delays start and collapses repeats.

### Nodes

| group | nodes |
|---|---|
| Triggers | Event, Schedule, Webhook, Manual, Metric, Called by automation |
| LogiStack | every OpenAPI operation (generic form from the zod schema); curated: deploy, rollback, restart, start/stop, scale/autoscale, run backup, restore, exec, set env var, apply environment, duplicate environment, create/delete preview, issue certificate, DNS upsert, run schedule, query database, get service overview, get metrics, get logs |
| Flow | If, Switch, Wait, Wait for event, Approval, Loop, Parallel, Merge, Stop (success/fail), Call automation |
| Data | Set fields, Code (QuickJS) |
| Integrations | HTTP request, Send message (notification channel), Git (issue, PR comment, commit status), DNS, S3 |
| AI | Agent |

Operations are classified `read` / `write` / `destructive` from the same metadata the Agent uses for approvals. The classification drives scopes, the publish-time approval check and test-run simulation.

### Plugin tools as nodes (plugins phase 4)

Plugin tools (`contributes.tools`, docs/plans/plugins.md) are already API operations, so they need no engine of their own: they join the node catalog the same way every OpenAPI operation does. Written 2026-11-08, ready for when Automations ship.

- **Catalog.** The palette lists `GET /plugins/tools` (enabled installs of the org) under a "Plugins" group, one node per `(installId, name)`: title from the tool name, plugin name and icon as subtitle, description as help. The list is read when the editor opens and on publish; it is not cached in the graph.
- **Node.** `type: "plugin-tool"`, `params: { installId, tool, input }`. `input` is a form generated from the tool's `inputSchema` (JSON Schema, the same generic form as other operations), each field an expression field. Output schema is unknown: the node's output is `{ output: unknown }` and the editor offers no autocomplete below `output`.
- **Execution.** The executor calls `POST /plugins/{installId}/tools/{tool}`, or `/destructive` when the tool declares `destructive: true`, through `invokeTool` as the automation bot, with the step's idempotency key in `Idempotency-Key`. The `mutation()` middleware dedupes repeats at our edge; to cover a crash between the plugin's work and our response, the server also forwards the key to the plugin (`POST /v1/tools/{name}` body `{ input, caller, idempotencyKey }`, a one-line change in `runTool`), and the SDK docs ask plugins to treat repeats of one key as one call.
- **Classification.** A tool is `write`, or `destructive` when the manifest says so. The automation's scopes, the publish-time Approval check and test-run simulation treat it like any operation of that class: a destructive tool without the `destructive` scope needs an Approval node; a test run simulates it (output `{ output: null }`) unless the node runs for real.
- **Scopes.** The bot needs `write` on the organization (or `delete` for destructive tools), as for a human calling the route. What the plugin does next runs with the plugin's own token, as today.
- **Pinning and drift.** A published version stores `installId` and `tool`, not the schema. At run time a missing install, a disabled install or a removed tool fails the step with a clear error ("plugin Deploy alerts is disabled") on the error edge; an input that no longer validates against the current schema fails the same way (the route already returns `400 validation_failed`). The editor flags such nodes on open.
- **Timeouts.** The route waits up to 60 s for the plugin. Longer work belongs in the plugin: answer quickly with a job id and expose a second tool to poll it, used with a Wait node.
- **Triggers from plugins** are out of scope here: a plugin that wants to start automations emits a LogiStack event through the API (once custom event types exist) or calls the manual trigger `POST /automations/:id/runs` with its own token.

### Expressions and Code (QuickJS)

- `quickjs-emscripten` in the worker (one new dependency, no native code). A fresh context per evaluation; globals: `trigger`, `nodes.<id>.output`, `item`, `run`, `env` (non-secret automation variables). No `fetch`, no timers, no `require`.
- Secrets are references (`secret("name")`) resolved **after** evaluation by the node executor and never written into step input/output; outputs are scanned and redacted for known secret values before persisting.
- The editor gets types for autocomplete from the upstream nodes' output schemas (operation response zod → JSON Schema → Monaco/CodeMirror completions).

### Agent node

Reuses `apps/server/src/ai/agent.ts` running as the bot with the automation's scopes; tools are the same catalog. A destructive tool call creates an `automation_approval` and the run goes `waiting`. Optional output schema turns the final answer into structured JSON for downstream nodes. Budgets and ledger of the AI gateway apply.

AI generation: an Agent prompt with the node catalog and `AutomationGraph` schema returns a graph, validated by zod and opened as a draft. Never auto-published.

### Test run

`automation_run.test = true`, runs the draft. `write` and `destructive` operations return a simulated output built from the response schema unless the node's "run for real" toggle is on (real destructive calls in a test still need scopes or approval). Payload sources: example from the trigger schema, a past real event, or hand-written JSON.

### Manifest

`automations:` section in `logistack.yaml`, keyed by a stable slug; apply creates or updates the draft and publishes (a manifest apply is the GitOps "publish"). Secrets by reference only. Schema added to `get_manifest_schema_json`.

### UI

- Sidebar **Automations**: list (status, last run, trigger summary), Runs tab, Approvals inbox with badge, Templates gallery.
- Editor: xyflow canvas, node palette (search over the full operation catalog, curated first), right-hand inspector for params with expression fields, Draft / Publish with version diff, Test run panel. Creating an automation is a guided wizard (rule 8): trigger, scopes, concurrency, failure handling, summary, then the canvas.
- Run view: same canvas read-only with live status per node (WebSocket channel `automation-run:<id>`), node inspector, "Re-run from here" (new run that copies completed steps up to the node, then continues on the current draft or published version, user's choice).
- Light and dark, keyboard accessible (canvas: arrow keys move selection, Enter opens inspector, Delete removes). UI skills per `CLAUDE.md` before building.

### Templates (launch set)

1. Roll back automatically when a production deploy fails, then notify.
2. Stop staging environments at night, start them in the morning.
3. Promote staging to production after health checks and approval.
4. Renew and alert on expiring certificates.
5. Drain a node that goes down and notify on-call.
6. Restart a service stuck in a crash loop once, escalate if it repeats.
7. Clean up previews older than N days.
8. Nightly database backup with restore verification into a throwaway database.
9. Stripe webhook to redeploy or toggle env vars.
10. Agent: on `deployment.failed`, read logs, summarize the cause, open a GitHub issue.

## Phases

**Phase 1: engine and core editor.** Tables, contracts, engine with durable steps, idempotency keys on mutating routes, causality chain, concurrency, retry/error edge. Triggers: event, cron, manual. Nodes: all operations (generic + curated forms), If/Switch, Wait, Approval (inbox + signed links), Set, Send message. QuickJS expressions. Bot + per-automation scopes + destructive check. Draft/publish, test run with simulation, run view, re-run from node, retention, `automation.failed`. Sidebar item.

**Phase 2: integrations and power nodes.** Loop, Parallel/Merge, Wait for event, Code node, Call automation, webhook triggers with verifiers, metric trigger, HTTP node, Git/DNS/S3 nodes.

**Phase 3: AI and GitOps.** Agent node, generate from prompt, manifest `automations:`, templates gallery, docs-site pages and screenshots.

## Risks and open points

- **Idempotency of existing routes** (verified 2026-11-07): nothing in `apps/server` reads an `Idempotency-Key`. What a repeated call does today:

  | operation | repeated call | harm |
  |---|---|---|
  | `POST /services/{id}/deploy`, `/restart`, `/deployments/{id}/rollback` | inserts a second `deployment` row | low while both are queued: the worker runs the newest and supersedes older queued ones (`apps/worker/src/deploy.ts:77`). Real double rollout if the first already started |
  | `POST /backup-policies/{id}/run` | second `backup_run` + job | double backup: wasted storage and load |
  | `POST /schedules/{id}/run` | second `schedule_run`; `forbid` records it as skipped | depends on the schedule's concurrency |
  | `POST /env-vars`, service/stack/environment create | unique constraints (`env_var_key_unique`, `service_slug_unique`, …) reject the second call | the retry fails with `409` instead of returning the created row: the run fails although the work happened |
  | `POST /services/{id}/start` / `stop`, DNS upsert, project archive | set desired state | none, already idempotent |
  | `POST /services/{id}/exec`, database query/command | runs again | arbitrary; cannot be made idempotent |

  Hence the single `mutation()` middleware above. `exec` and database writes stay `destructive` and are retried only when the node opts in.
- **QuickJS cost**: a context per evaluation is safe but not free; measure and pool runtimes if a loop over 1,000 items is slow.
- **Multi-replica worker**: per-run Redis lock covers it; the Agent's single-replica shortcut (in-memory `running` set) must not leak into the Agent node.
- **Causality propagation** needs the actor context to carry `causedBy` into every event the reconciler later emits for that change (e.g. deploy started by a run, failed minutes later). Store it on the deployment row.
- **Signed approval links** are bearer-ish: single use, short TTL, login still required.

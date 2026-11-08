# Autoscaling AutoFix plan

Goal: when the autoscaling setup finds a problem it knows how to solve, the user solves it with one click. A failed check shows an **AutoFix** button on its right. The button opens a modal that says what is wrong, what will change (before → after), and what happens next (a redeploy). The user applies the fix or cancels.

Builds on `docs/plans/autoscaling.md` (AS-1..AS-5, shipped 2026-11-06).

## What already exists

- `autoscaleChecks()` in `packages/core/src/autoscale.ts:129` returns five checks: `cpu_limit`, `volumes`, `host_ports` (blockers) and `healthcheck`, `nodes` (warnings). Contract `AutoscaleCheck` in `packages/contracts/src/autoscale.ts`.
- `GET /services/:id/autoscale` returns them in `AutoscaleView.checks`. `PUT` refuses to enable while a blocker fails (`apps/server/src/routes/autoscale.ts`).
- The wizard's first step "Check the service" renders them with `Checks` (`apps/web/src/components/service/scaling.tsx:84`) and only says "fix the checks marked in red in the service settings first". The user has to leave the wizard, find the setting, save, deploy, come back.
- Resource profiles (`packages/core/src/resource-profiles.ts`, org list via `organization_resource_profiles`), `applyResourceProfile()`.
- `guardHostSettings()` / `checkPorts()` in `apps/server/src/host-settings.ts` validate published-port conflicts before a spec is written.
- Spec changes apply from the next deployment ("Applies from the next deployment." in the settings form). Swarm updates use `FailureAction: "rollback"` (`compile-service.ts:553`).
- Per-minute load history in `metric_container_1m` (already read by `loadHistory` in the autoscale route).
- `ConfirmDialog` (`apps/web/src/components/confirm-dialog.tsx`) with `destructive={false}`.

## Which problems get a fix

| check | AutoFix | what it does | when the fix is not offered |
|---|---|---|---|
| `cpu_limit` | yes (v1) | Applies a resource profile. | The org has no profiles. |
| `host_ports` | yes (v1) | Switches the host-mode published ports to `ingress`. | Another service already holds the port in ingress mode, or a host-mode port on any node (`checkPorts` refuses). |
| `healthcheck` | yes (v2) | Adds an HTTP healthcheck, after a live probe passed. | No domain/port to probe, the probe failed, or the image has no `wget`/`curl`. |
| `volumes` | no | Data can't be made interchangeable by a click. The message links to the docs page on stateful services. | — |
| `nodes` | no | Adding a server is its own wizard. The check shows an **Add a server** link button instead of AutoFix. | — |

### `cpu_limit`: pick the profile from real usage

Choose the profile in a pure function `suggestProfile(profiles, usage, current)`:

1. Start from the org's `defaultProfile` if set, else the smallest profile.
2. With at least an hour of history: take p95 CPU (cores) and p95 memory (MB) per container over 24 h. Move up to the smallest profile with `cpu ≥ p95 × 1.3` **and** `memoryMb ≥ p95 × 1.3`.
3. If the service already has a memory limit, keep it and set only `cpu` (never shrink memory a user chose; a lower memory limit means OOM kills).
4. If no profile is large enough, offer the largest and say so in the modal.

Modal copy: "Each copy gets 0.5 CPU and 512 MB (Small). Over the last day one copy peaked at 0.31 CPU and 380 MB." Without history: "No usage data yet, so this uses your default size."

### `host_ports`: ingress instead of host

Patch every port with `published` and `mode` `host` (or unset) to `mode: "ingress"`. Run the patched spec through `guardHostSettings()`; if it refuses, the check carries `fix: null` and a reason ("Port 25565 is already used by *minecraft-eu*").

Modal copy must say the side effect: "Port 8080 will answer on every server in the cluster, not only on *node-1*. Clients keep the same address. Check your firewall if you only opened it on one server."

### `healthcheck` (v2): probe before proposing

Note first: with no healthcheck the compiler already adds a TCP check on the first port (`compileHealthcheck`, fallback port). The `healthcheck` check ignores this and warns anyway. Fix the check: `ok` when a fallback TCP check exists, with the message "Copies get traffic once port 3000 accepts connections. An HTTP check is stricter." The warning then remains only for services without ports or domains.

The AutoFix for the remaining case (and an optional "stricter" upgrade) adds `{ type: "http", port, path: "/" }`. The compiled check needs `wget` or `curl` inside the image, so the server probes first: exec `wget -q -O /dev/null http://127.0.0.1:<port>/` (then `curl`) in one running task through the existing exec path, argv only. The fix is offered only if the probe returns success, and the modal shows the result: "We requested / on port 3000 inside a running copy: it answered in 12 ms." The probe runs when the user opens the modal, not on every `GET`.

## Design

### Contract (`packages/contracts/src/autoscale.ts`)

```ts
export const AutoscaleFix = z.object({
	id: z.enum(["apply_profile", "ingress_ports", "add_healthcheck"]),
	title: z.string(),            // "Give each copy a size"
	summary: z.string(),          // one sentence for the modal header
	changes: z.array(z.object({   // rendered as before → after rows
		label: z.string(),          // "CPU limit"
		before: z.string(),         // "None"
		after: z.string(),          // "0.5 CPU (Small)"
	})),
	notes: z.array(z.string()),   // side effects and evidence (usage, firewall)
	redeploy: z.boolean(),        // true for every v1 fix
});

AutoscaleCheck = AutoscaleCheck.extend({
	fix: AutoscaleFix.nullable(),   // null: no fix, or a fix that can't apply now
	fixUnavailable: z.string().nullable(), // why, when a known fix can't apply
	link: z.object({ label: z.string(), to: z.string() }).nullable(), // "Add a server"
});
```

Additive: old clients ignore the new fields.

### Pure logic (`packages/core/src/autoscale-fixes.ts`)

- `suggestProfile(profiles, usage, resources)` → `{ profile, resources } | undefined`.
- `fixFor(check, ctx)` → `AutoscaleFix | null`, and `applyFix(fixId, spec, ctx)` → the new `ApplicationSpec`. `ctx` carries profiles and usage. The same function builds the preview and the patch, so the modal can't promise something different from what gets applied.
- Table tests: each fix on a spec that needs it, on one that doesn't (no-op), memory never shrinks, no profile large enough, ports already ingress, mixed host/ingress ports.

`autoscaleChecks()` takes the extra `ctx` and attaches `fix` to failed checks.

### API (`apps/server/src/routes/autoscale.ts`)

- `GET /services/:id/autoscale`: checks now include `fix`. The route loads profiles and 24 h usage (one query on `metric_container_1m`, p95 via `percentile_cont`).
- `POST /services/:id/autoscale/fixes/{fixId}`: `mutation("service.autoscale_fix", …)`, `requirePermission("write", byParam("service"))`.
  1. In a transaction, `select … for update` the service row.
  2. Recompute checks on the current spec. **The server never takes the change from the client**: the client only names the fix.
  3. Check already `ok` → 200 with the current view and `deploymentId: null` (idempotent: a double click or two tabs do no harm).
  4. `applyFix` → `guardHostSettings` → update `service.spec`. The audit diff records spec before/after.
  5. Queue a deployment the same way the Deploy button does (same trigger values, `deployment.queued` event). The worker runs deployments of a service one after another, so a running deploy needs no 409: the queued one picks up the new spec. The route needs both `write` and `deploy`.
  6. Response: `{ view: AutoscaleView, deploymentId }`.
- `POST /services/:id/autoscale/fixes/add_healthcheck/probe` (v2): runs the probe, returns the fix or the reason it is not offered. Audited as `service.autoscale_probe`, since it runs a command in a container. Applying `add_healthcheck` runs the probe again on the server.

MCP tools come from the OpenAPI (`service_autoscale_fix`). Its description says that it redeploys.

### UI (`apps/web/src/components/service/scaling.tsx`)

In `Checks`, a failed check with `fix` gets a small **AutoFix** button on the right (`variant="outline"`, `size="sm"`, `Wand2` icon, aligned to the first line of the message). A check with `link` gets a link button instead. A check with `fixUnavailable` shows that reason in muted text under the message, with no button.

The button opens a modal built on `ConfirmDialog` (`destructive={false}`):

- **Title**: `fix.title`. **Description**: `fix.summary`.
- **What changes**: `changes` as a two-column list, before in muted strikethrough, after in normal weight, tabular numbers.
- **Notes**: `notes` as short lines (usage evidence, firewall warning).
- **What happens next**: "Saving starts a new deployment. Copies are replaced one at a time; if the new one fails its healthcheck, the previous version stays." (when `redeploy`).
- Buttons: **Cancel** · **Apply and redeploy**. Keyboard: Esc cancels, focus starts on Cancel (consequential action, not destructive).

After it succeeds:

- Invalidate the autoscale and service queries. The check turns green in place: the icon crossfades (`transitions-dev` icon swap) and the button fades out. No layout jump: the button slot keeps its width until the fade ends.
- Toast "Size applied. Deploying…" with a link to the deployment.
- In the wizard, the step's `ready()` re-reads the view, so **Next** unlocks without leaving the wizard.
- On a refusal: the modal stays open with the error inline above the buttons.

The PUT refusal path (blockers in the 400 body) renders the same `Checks` list, so AutoFix also appears there.

Mock data for screenshots: `apps/web/src/lib/api/mock/autoscale.ts` gets one service with a missing CPU limit and a host port.

## Out of scope (named, not built)

- Runtime problems after enabling: "at the maximum for 10 minutes" (fix: raise the maximum) and "new copies pending, cluster out of room" (fix: lower the maximum or add a server). These need the worker to record `at_max_since` / pending state. A good next step on the same `fix` field.
- Fixing `volumes`: moving data to shared storage is a migration, not a click.
- Undo button: the deployment history already allows a rollback. The modal mentions it.
- Fixes outside autoscaling. The `fix` shape is generic enough to reuse later for other readiness checks.

## PRs

1. **FX-1 core + contracts.** `AutoscaleFix`, new check fields, `suggestProfile`, `fixFor`/`applyFix` for `apply_profile` and `ingress_ports`, table tests. `GET` returns fixes.
2. **FX-2 API.** `POST …/fixes/{fixId}` with lock, idempotency, `guardHostSettings`, deploy, audit, 409. Route tests: 403, no-op when already ok, port conflict.
3. **FX-3 UI.** AutoFix button, modal, in-place check transition, wizard unlock, mock data, screenshots.
4. **FX-4 healthcheck.** Correct the `healthcheck` check for the TCP fallback; probe endpoint; `add_healthcheck` fix.
5. **FX-5 docs.** Section "Fix setup problems in one click" on `docs-site/content/docs/deploy/autoscaling.mdx`.

FX-1 → FX-2 → FX-3 in order. FX-4 after FX-2. FX-5 after FX-3.

## Open questions

- Should AutoFix also be allowed for users with only `write` on the service, or only admins? (Proposal: `write`, as for any settings change. Only host-level changes need an admin, and `guardHostSettings` already enforces that.)
- Should AutoFix redeploy straight away, or save and leave the deploy to the user (with a "Deploy now" checkbox ticked by default)? Proposal: redeploy straight away. The check reads the saved spec, so without a deploy the wizard would show green while the running copies still have no limit.

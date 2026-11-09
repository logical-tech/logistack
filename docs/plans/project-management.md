# Project management ("Work")

Status: plan, nothing built (2026-11-08). Code name **Work**: tables `work_*`, routes `/api/work/*`, core in `packages/core/src/work/`, web in `apps/web/src/components/work/`. Nav label "Tasks" for ops users, "Projects" as the landing of the project-manager shell.

## Why

Teams that ship on LogiStack track their work somewhere else (ClickUp, Linear, spreadsheets). Project managers keep asking developers "is the client's site up?", and to answer that on their own they would have to read a dashboard full of deployments, replicas and logs that is not meant for them.

Work adds lists, tasks, subtasks, checklists, comments, attachments, custom fields and table / board / timeline / calendar views to the **projects that already exist**. A **Project manager** role sees tasks and a plain health signal for each project, and nothing about deployments.

## Goals

- A PM can run a client project end to end inside LogiStack: plan it on a timeline, track it on a board, assign people, discuss in comments with screenshots, and see whether the client's services are up.
- Developers see the same tasks next to the services they deploy, and their commits and PRs link to tasks automatically.
- Nothing about deployments, images, logs, env vars, nodes or domains config reaches a work-only actor, through any route.
- Migrating from ClickUp takes one wizard.

## Non-goals

Listed with reasons in "Not doing" at the end: docs/wiki, chat, whiteboards, goals/OKRs, sprints/points as first-class objects, real-time co-editing, per-list statuses, cross-project dependencies, invoicing.

---

## 1. Decisions

1. **No second hierarchy.** A Work project is the existing `project` row: Folder → Project → List → Task → Subtask (one level). A project with no services is valid (design work, client onboarding). The PM shell shows projects with no environments as "No services". The ops shell already lists them.
2. **Permissions are new actions in the existing grant model**, not a parallel ACL. Grants on organization/folder/project scopes apply unchanged. Grants on environment or service scopes don't give Work access: Work lives at project level, so `ancestry()` already ignores them for a project resource.
3. **Work-only actors get their own shell**, picked from what they can do, never from the role's name (custom roles work too).
4. **Health is a pure function** with one six-word vocabulary: `operational | degraded | down | maintenance | paused | unknown`.
5. **Attachments go through a storage driver**: `db` (bytea, default, covered by the Postgres backup) or `s3` (an existing `s3_destination`).
6. **The editor is Tiptap** (MIT core packages only, no Pro extensions), stored as ProseMirror JSON plus a derived plain-text copy for search, notifications and emails. **Drag and drop uses `@dnd-kit`** (MIT). Timeline and calendar are built here with CSS grid and `@tanstack/react-virtual`. No Gantt library: the capable ones are GPL or commercial.
7. **Ordering uses fractional index strings** (`position text collate "C"`), so a drag writes one row. Our own helper, no dependency.
8. **Every operation is REST + OpenAPI**, so MCP tools, the CLI and the AI Agent get Work with no extra code, gated by the same actions.
9. **Work data is not in the manifest/gitops.** It is collaborative state, not desired infrastructure state. Platform backups cover it because it lives in Postgres.
10. **Migrations only add** (rule 10). The one change to existing objects is new values in `permissionActions` and in the built-in role map, both additive.

---

## 2. Permissions and roles

### 2.1 New actions (`packages/contracts/src/enums.ts`)

| Action | Allows |
|---|---|
| `read:work` | See lists, tasks, subtasks, checklists, comments, attachments, shared views, tags, fields, activity. See the project's simplified health. See assignable members (name, avatar). |
| `comment:work` | Comment and reply, react, attach files to comments, tick checklist items assigned to them. (For guests; `work` includes it.) |
| `work` | Everything in `comment:work`, plus create/edit/move/archive tasks, assign, set fields, upload attachments, create personal views, track time on their own entries, manage watchers, create share links for lists they can read (phase 4, if the project allows it). |
| `work:admin` | Lists (create, rename, archive, delete), statuses, custom fields, tags, shared views, templates, project Work settings (key, hidden services, working days, repositories, closing status), delete any task/comment, edit anyone's time entries, run imports into the project. |

`work` implies `comment:work` and `read:work` inside `allows()` (a three-line implication table in `packages/core/src/permissions.ts`), so custom roles can list just `work`. Test: a custom role `["work"]` can read and comment.

### 2.2 Built-in roles (`builtinActions`)

| Role | Before | After | UI name |
|---|---|---|---|
| owner | all | all (includes the new actions) | Owner |
| admin | all | all | Admin |
| developer | read, deploy, write | + `read:work`, `work` | Developer |
| viewer | read | + `read:work`, `comment:work` | Viewer |
| **manager** (new) | — | `read:work`, `work`, `work:admin` | Project manager |
| **guest** (new, phase 4) | — | `read:work`, `comment:work` | Guest |

`builtinRoleNames` and the `BuiltinRole` type gain `manager` and `guest`. The Members page role picker describes them: *"Project manager — manages tasks, lists and fields; sees whether services are up. No access to deployments, logs or settings."* *"Guest — reads tasks and comments on one project. For clients."* The guest role can only be granted on a project scope; the API refuses it on organization or folder scopes with `bad_request`.

### 2.3 Why the manager can't see ops data

`manager` has no `read`. Every existing route checks `read` (or something stronger) on its resource, so it already answers 403/404. Work routes check only Work actions and return dedicated DTOs (section 6) that never embed service rows. A test walks every registered non-Work route (section 13.2) so a new route that forgets its check fails CI.

### 2.4 Assignable people

Assignable people on project P are org members whose grants give `work` on P. Mentionable people are those with `read:work` on P. Both come from `GET /api/work/projects/:id/people`, which reuses the effective-access helper the Members page already uses to resolve grants through folders. Guests are mentionable but not assignable unless the project setting `guestsAssignable` is on.

### 2.5 API keys and service accounts

Keys with built-in roles inherit the new actions. Keys with custom roles keep their explicit lists. The automation bot (from `docs/plans/automations.md`) gets `work` only if its scopes include it.

---

## 3. Shells and navigation

`GET /api/me` gains `surfaces: ("ops" | "work")[]`:
- `ops` when the actor holds `read` on at least one scope,
- `work` when it holds `read:work` on at least one scope (computed from grants once per request, cached on the actor).

| Surfaces | Shell |
|---|---|
| `ops` + `work` | Normal shell. Sidebar gains **Tasks** (My tasks, Inbox, then projects with open-task counts). Every project page gains a **Tasks** tab next to Services/Environments. |
| `work` only | **Work shell**: sidebar = My tasks, Inbox (unread badge), Projects (each with its health dot), Time (phase 4), Account. Header: org switcher, search (⌘K over tasks only), theme toggle, avatar. No Home summary, Network, Domains, Storage, Monitoring, Settings, AI or Agent. Members appear read-only and only as people on their projects. |
| `ops` only | Unchanged (custom roles without Work actions). |
| none | Existing "no access" page. |

The router guards Work routes with `surfaces.includes("work")` and ops routes with `ops`. A work-only user opening an ops URL gets redirected to `/work`, never a 403 page that names the resource.

The command palette (cmdk, already installed) gets Work commands: "New task" (`c`), "Go to task KEY-n", "My tasks" (`g m`), "Inbox" (`g i`), "Search tasks".

---

## 4. Data model (`packages/db/src/schema/work.ts`)

Conventions: `id("<prefix>")` and `...timestamps` as in the other schema files, FKs to `project`/`user` with the cascades listed, all text ids. One migration per phase, additive.

### 4.1 Project-level

**`work_project`**: created lazily the first time anyone opens Work on a project (`insert … on conflict do nothing`).

| Column | Type | Notes |
|---|---|---|
| projectId | text PK → project (cascade) | |
| key | text not null | 2–10 chars `^[A-Z][A-Z0-9]{1,9}$`, unique per org (`unique(organizationId, key)`, organizationId denormalised). Default: initials of the project name, deduplicated (`SHOP`, `SHOP2`). Renaming keeps old keys as aliases (`work_key_alias`). |
| organizationId | text not null | denormalised for the unique key |
| nextNumber | integer default 1 | allocated with `update … set next_number = next_number + 1 returning next_number - 1` in the task-insert transaction |
| defaultListId | text null | where quick-add and imports land |
| hiddenServiceIds | text[] default '{}' | services hidden from Work health |
| workingDays | smallint default 31 | bitmask Mon=1…Sun=64; default Mon–Fri. Used by duration counting and dependant shifting |
| closingStatusId | text null | status set by "Fixes KEY-n"; null = first `done` status |
| repos | jsonb default '[]' | `{providerId, repo}[]` linked for the git integration besides the repos of the project's own services |
| guestsAssignable | boolean default false | |
| guestsCanCreate | boolean default false | phase 4, section 12.8 |
| allowShareLinks | boolean default false | phase 4 |
| timeTracking | boolean default true | phase 4 |
| timeLockedBefore | date null | phase 4: time entries before this date are read-only |

**`work_key_alias`**: `(organizationId, key)` PK → projectId. Written when a key changes or a task moves projects, so old `SHOP-42` links still resolve.

**`work_task_alias`**: `(projectId, number)` PK → taskId. Written when a task moves to another project.

**`work_status`**

| Column | Type | Notes |
|---|---|---|
| id | `wst_` | |
| projectId | → project cascade | |
| name | text | unique per project, case-insensitive |
| color | text | token name from the palette (`gray`, `blue`, `amber`, `green`, `red`, `violet`, `pink`, `teal`), never a raw hex: themes stay coherent in dark mode |
| category | enum `work_status_category` (`backlog`, `active`, `done`, `cancelled`) | |
| position | text (fractional) | |
| wipLimit | integer null | board column turns amber above it (phase 2) |

Seeded on `work_project` creation: Backlog (backlog), To do (active), In progress (active), Review (active), Done (done), Cancelled (cancelled). Core guards: at least one `backlog` and one `done` must remain. Deleting a status requires a target status for its tasks (`DELETE …?moveTo=wst_x`, done in one transaction).

**`work_list`**

| Column | Type | Notes |
|---|---|---|
| id | `wls_` | |
| projectId | → project cascade | |
| name | text | unique per project among non-archived |
| description | jsonb null | rich text |
| color | text null | palette token |
| icon | text null | from the existing icon set |
| position | text | |
| archivedAt | tstz null | archived lists are hidden from views, their tasks stay searchable and readable |

**`work_tag`**: `wtg_`, projectId, name (unique per project), color.

### 4.2 Tasks

**`work_task`**

| Column | Type | Notes |
|---|---|---|
| id | `tsk_` | |
| projectId | → project cascade | denormalised from the list for fast filters |
| listId | → work_list cascade | |
| parentId | → work_task cascade, null | subtasks; core rejects a parent that has a parent (one level) |
| number | integer | `unique(projectId, number)` |
| title | text | 1–500 chars |
| description | jsonb null | ProseMirror doc, ≤ 200 KB serialised |
| descriptionText | text null | derived on write, for search and previews |
| statusId | → work_status restrict | |
| priority | enum (`urgent`, `high`, `normal`, `low`, `none`) default `none` | |
| startDate | date null | |
| dueDate | date null | check `start_date <= due_date` |
| dueTime | time null | only with dueDate; shown in the org timezone |
| isMilestone | boolean default false | diamond on the timeline; forces startDate = dueDate |
| estimateMinutes | integer null | |
| position | text | order within its list (table "manual" sort and board columns) |
| recurrence | jsonb null | `RecurrenceRule` (phase 4) |
| recurrenceSeriesId | text null | shared by all occurrences of a recurring task |
| source | jsonb null | `{kind: "clickup"\|"csv"\|"template", externalId?, url?}` |
| createdBy | → user set null | |
| completedAt | tstz null | set/cleared by `applyStatusChange` in core |
| archivedAt | tstz null | |
| search | tsvector generated always as `setweight(to_tsvector('simple', title), 'A') \|\| setweight(to_tsvector('simple', coalesce(description_text,'')), 'B')` stored | `simple` config: the content is multilingual |
| timestamps | | `updatedAt` is the optimistic-concurrency token for PATCH |

Indexes: GIN(search); `(list_id, status_id, position)`; `(project_id, due_date) where archived_at is null`; `(parent_id)`; `(recurrence_series_id, due_date)` unique where not null (idempotent recurrence).

**`work_task_assignee`**: (taskId, userId) PK, `assignedBy`, `assignedAt`. Index (userId) for My tasks.

**`work_task_watcher`**: (taskId, userId) PK, `reason` (`creator`, `assignee`, `mention`, `comment`, `manual`). A user who unwatches gets `muted = true` instead of a deleted row, so auto-watch doesn't re-add them.

**`work_task_tag`**: (taskId, tagId) PK.

**`work_checklist_item`**: `wci_`, taskId cascade, text (≤ 500), done boolean, doneBy, doneAt, assigneeId null, position. Lighter than subtasks: no status, no dates, no comments. "Convert to subtask" action.

**`work_dependency`**: (taskId, blockedById) PK, `lagDays integer default 0`, createdBy. Finish-to-start only. Same project only (check through a trigger-free core validation in the route, since a CHECK can't join). Core rejects cycles.

### 4.3 Fields

**`work_field`**

| Column | Type | Notes |
|---|---|---|
| id | `wfd_` | |
| projectId | → project cascade | |
| listId | → work_list cascade, null | null = all lists of the project |
| name | text | unique per (project, list) case-insensitive |
| kind | enum `work_field_kind` | see table below |
| config | jsonb | per kind, zod `WorkFieldConfig` discriminated union |
| required | boolean default false | enforced on create and on moving to a `done` status |
| description | text null | tooltip in the UI |
| position | text | |

| Kind | config | value (jsonb) | Filters | Sort |
|---|---|---|---|---|
| text | `{maxLength?}` | string ≤ 2000 | contains, is, empty | alpha |
| long_text | — | string ≤ 20 000 (plain, markdown rendered read-only) | contains, empty | — |
| number | `{decimals 0–6, min?, max?, unit?}` | number | =, ≠, <, >, between, empty | numeric |
| currency | `{currency ISO 4217, decimals}` | number (minor units avoided: decimal stored as string to keep precision, `"1234.50"`) | as number | numeric |
| percent | `{decimals}` | number 0–100 | as number | numeric |
| date | `{withTime boolean}` | ISO date or datetime | before/after/between/relative/empty | chronological |
| checkbox | — | boolean | is true/false | false < true |
| select | `{options: {id, label, color}[] ≤ 200}` | option id | is, is any of, is none of, empty | option order |
| multi_select | same | option id[] | has any/all/none of, empty | first option order |
| user | `{multiple boolean}` | user id or id[] | is/any of/me/empty | name |
| url | — | string, http(s) only | contains, empty | alpha |
| email | — | string (z.email) | contains, empty | alpha |
| phone | — | string E.164-ish, free | contains, empty | alpha |
| rating | `{max 3–10, icon "star"\|"flame"\|"heart"}` | integer 0–max | =, ≥, ≤ | numeric |

**`work_field_value`**: (taskId, fieldId) PK, value jsonb, updatedBy, updatedAt. Null/empty values are deleted rather than stored. Deleting a select option doesn't rewrite values: readers drop unknown ids (`parseFieldValue` returns the cleaned value) and the next write stores the clean one.

### 4.4 Collaboration

**`work_comment`**: `wcm_`, taskId cascade, authorId → user set null (shown as "Former member"), parentId → work_comment cascade (one level), body jsonb (≤ 50 KB), bodyText, editedAt, deletedAt (soft: body cleared, row kept so threads keep their shape), resolvedAt/resolvedBy (a PM can resolve a question thread), search tsvector on bodyText.

**`work_reaction`**: (commentId, userId, emoji) PK. Emoji limited to a fixed set of 8 (👍 👎 🎉 ❤️ 😄 😕 👀 🚀) so there's no emoji picker in v1.

**`work_activity`**: `wac_`, taskId cascade, actorId set null, kind enum (`created`, `status`, `assignee_added`, `assignee_removed`, `dates`, `priority`, `list_moved`, `project_moved`, `field`, `tag_added`, `tag_removed`, `dependency_added`, `dependency_removed`, `attachment_added`, `attachment_removed`, `archived`, `restored`, `checklist`, `git_linked`, `git_closed`, `imported`, `recurred`), data jsonb (before/after, typed per kind in contracts), createdAt. Edits by the same actor on the same field within 2 minutes collapse into one entry (update instead of insert), so typing in a field doesn't flood the timeline. The audit log gets only deletes (task, list, field, status) and admin settings changes, through the existing `mutation()` wrapper.

**`work_attachment`**

| Column | Type | Notes |
|---|---|---|
| id | `wat_` | |
| projectId | → project cascade | for quota and permission checks without joins |
| taskId | → work_task cascade, null | |
| commentId | → work_comment cascade, null | check: exactly one of taskId/commentId, or both (comment on task) |
| inlineIn | enum `description\|comment\|none` | images pasted into rich text are inline; they don't appear in the gallery twice |
| uploaderId | → user set null | |
| name | text | sanitised file name, ≤ 255 |
| contentType | text | sniffed, not trusted from the client |
| size | bigint | |
| sha256 | text | |
| driver | enum `db\|s3` | |
| objectKey | text | `db`: sha256; `s3`: `work/<orgId>/<sha256>` |
| width, height | integer null | images |
| thumbKey | text null | WebP 480 px wide |
| deletedAt | tstz null | 30-day soft delete; GC removes blobs later |

**`work_blob`**: sha256 PK, bytes bytea, size, refCount. `db` driver only. Postgres TOAST compresses poorly for images, which is why the quota and the S3 driver exist.

### 4.5 Views

**`work_view`**: `wvw_`, projectId cascade, listId null (null = whole project), ownerId → user cascade null (null = shared), name, kind enum (`table`, `board`, `timeline`, `calendar`), config jsonb (`WorkViewConfig`), position, isDefault (one per project+list for shared views).

`WorkViewConfig` (zod, `packages/contracts/src/work.ts`):

```ts
{
  filter: FilterNode | null,            // section 7
  sort: { by: SortKey, dir: "asc" | "desc" }[],   // ≤ 3
  groupBy: GroupKey | null,             // status | priority | assignee | list | tag | dueBucket | field:<id>
  subGroupBy: GroupKey | null,          // board swimlanes
  columns: { key: ColumnKey, width?: number, hidden?: boolean }[],  // table
  cardFields: ColumnKey[],              // board cards, ≤ 6
  showSubtasks: "nested" | "flat" | "hidden",
  showClosed: boolean,                  // done + cancelled
  timeline: { zoom: "day" | "week" | "month" | "quarter", rowsBy: "list" | "assignee" | "none", showDependencies: boolean, showWeekends: boolean },
  calendar: { mode: "month" | "week", dateField: "due" | "span" | `field:${string}` },
  collapsedGroups: string[],
}
```

Every project gets four shared views on creation: **List** (table grouped by status), **Board** (board by status), **Timeline**, **Calendar**. Admins can delete or rename them.

### 4.6 Notifications

**`work_notification`**: `wnt_`, userId cascade, organizationId, taskId cascade, commentId null, actorId null, kind enum (`assigned`, `unassigned`, `mentioned`, `commented`, `replied`, `status_changed`, `due_soon`, `overdue`, `checklist_assigned`, `timer_running_long`), data jsonb, readAt, emailedAt, createdAt. Index (userId, readAt, createdAt desc). Kept 90 days, deleted by the maintenance tick.

**`work_user_prefs`**: (userId, organizationId) PK, `email` enum (`off`, `instant`, `daily`), `emailKinds` text[] (default assigned, mentioned, due_soon, overdue), `dailyHour` smallint default 8, timezone text null (falls back to org timezone), `icalTokenHash` text null, `capacityHoursPerWeek` smallint default 32 (set by a `work:admin`, used by Workload in 12.11).

### 4.7 Phase 4 tables

Detailed in their sections: `work_template` (12.1), `work_time_entry` (12.3), `work_git_link` (12.4), `work_import`, `work_import_map` (12.5), `work_share` (12.7), `invitation_grant` (12.8).

### 4.8 Deletion and archiving rules

- **Project deleted**: cascades to everything Work. The delete dialog adds "12 open tasks, 3 lists and 41 attachments will be deleted" (count from `GET /api/work/projects/:id/summary`).
- **Project archived**: Work becomes read-only (routes return `conflict` "project archived"), still visible to the PM with an "Archived" pill.
- **User removed from the org**: assignee/watcher rows deleted, comments and activity keep `authorId` null → "Former member". Their running timer is stopped at removal time.
- **List deleted**: allowed only when empty, or with `?moveTo=wls_x`, or `?deleteTasks=true` (admin, typed confirmation in the UI).
- **Task deleted**: hard delete, admin or the creator within 15 minutes; otherwise archive. Subtasks go with it. Attachments are soft-deleted and GC'd.

---

## 5. Pure core (`packages/core/src/work/`)

Everything with a rule in it lives here, has no I/O, and is tested with `bun test`.

| Module | Exports | Tests cover |
|---|---|---|
| `health.ts` | `serviceHealth(input) → Health`, `projectHealth(Health[]) → Health`, `healthSince(transitions)` | every row of the table in section 8, precedence, paused ignored, empty project → `unknown` |
| `rank.ts` | `rankBetween(a?, b?) → string`, `rankN(a?, b?, n) → string[]`, `needsRebalance(key)`, `rebalance(count) → string[]` | between null/null, before first, after last, many inserts at the same spot stay short, lexical order under `collate "C"` |
| `fields.ts` | `parseFieldValue(field, raw)`, `formatFieldValue(field, value, locale)`, `compareFieldValues(field)`, `fieldFilterOps(kind)` | each kind, unknown option dropped, currency precision, rating bounds |
| `filter.ts` | `FilterNode` type, `validateFilter(node, fields)`, `resolveRelativeDates(node, now, tz)`, `matchesTask(node, task)` (used by realtime to decide whether a changed task enters/leaves a cached view client-side) | relative ranges across DST, "me", nested and/or, unknown field rejected |
| `deps.ts` | `wouldCycle(edges, from, to)`, `topoOrder(edges)`, `shiftDependants(tasks, edges, movedId, deltaDays, workingDays) → {id, startDate, dueDate}[]`, `blockedState(task, edges, statuses)` | cycles, diamond graphs, lag, weekends skipped, dependants already late not moved earlier |
| `dates.ts` | `addWorkingDays`, `workingDaysBetween`, `dueBucket(due, now, tz) → "overdue"\|"today"\|"tomorrow"\|"this_week"\|"next_week"\|"later"\|"none"` | bitmasks, year boundaries |
| `status.ts` | `applyStatusChange(task, from, to, now) → {completedAt}`, `canDeleteStatus(statuses, id)`, `requiredFieldsMissing(task, fields, toStatus)` | done ↔ active toggles completedAt, last done protected |
| `mentions.ts` | `extractMentions(doc) → userId[]`, `newMentions(oldDoc, newDoc)`, `extractTaskRefs(text, keys) → {key, number}[]` | nested nodes, duplicates, refs in code blocks ignored |
| `richtext.ts` | `sanitizeDoc(doc) → doc` (node/mark allow-list, link protocols http/https/mailto only, image src only `/api/work/attachments/<id>`), `docToText(doc)`, `docToEmailHtml(doc)` | script/iframe stripped, javascript: links stripped, size limit |
| `timeline.ts` | `scaleFor(zoom) → {pxPerDay, tick}`, `dateToX`, `xToDate` (snapped), `visibleRange`, `barGeometry(task)` | zoom round-trips, snapping, milestones |
| `recurrence.ts` (phase 4) | `RecurrenceRule` type, `nextOccurrence(rule, prev) → {startDate, dueDate} \| null`, `describeRule(rule, locale)` | month-end (31st → 28/29/30), leap years, `after n`, `until`, weekday sets |
| `template.ts` (phase 4) | `instantiateTemplate(payload, anchor, fieldMap, userMap) → TaskDraft[]` | relative dates, missing fields dropped with warnings, nested subtasks |
| `git-refs.ts` (phase 4) | `parseWorkRefs(message, keys) → {key, number, closes: boolean}[]` | `Fixes SHOP-12`, `closes #`-style ignored, `SHOP-12, SHOP-13`, keys not in org ignored, case rules |
| `clickup-map.ts` (phase 4) | `mapClickUpStatus`, `mapClickUpField(field) → {kind, config} \| {skip, reason}`, `mapClickUpTask(task, maps) → TaskDraft` | each ClickUp field type, priority mapping, timestamps in ms → dates in workspace tz |
| `time.ts` (phase 4) | `rollupTime(entries, groupBy, range, tz)`, `formatDuration` | entries crossing midnight split by day, running timer counted to now |

---

## 6. Health

### 6.1 Inputs

For each service in the project's **default environment** that is not in `hiddenServiceIds`:
- `service.desiredState`, `service.maintenance` (existing `ServiceMaintenance`),
- `service_status`: `observed`, `replicasRunning`, `replicasDesired`, `crashLoop`, plus the timestamp of the last change,
- uptime `monitor` rows with `serviceId` = this service: confirmed status, active maintenance window,
- firing `service_threshold` alerts.

Preview environments never count. Other non-default environments (staging) can be enabled per project later with `work_project.healthEnvironmentIds`. Not in v1.

### 6.2 Rules (`serviceHealth`, first match wins)

| # | Result | When |
|---|---|---|
| 1 | `paused` | desired state stopped |
| 2 | `maintenance` | service maintenance on, or a maintenance window covers any linked monitor |
| 3 | `down` | observed `failed`, or observed `stopped` while desired running, or `replicasDesired > 0 && replicasRunning = 0`, or any linked monitor confirmed `down` |
| 4 | `degraded` | observed `starting` for more than 5 minutes or `unhealthy`, `0 < replicasRunning < replicasDesired`, crash loop firing, a monitor `pending`, a threshold firing |
| 5 | `operational` | observed `running` with all replicas, every monitor up or no monitors |
| 6 | `unknown` | no status row yet |

A rolling deploy briefly has replicas below desired. Rule 4 ignores that while a deployment of this service is `started` and less than 10 minutes old: the PM never sees a deploy, and also never sees a false "degraded" because of one. The 10-minute guard reads deployment rows server-side; nothing about them leaves the server.

`projectHealth` = worst of the service results with precedence `down > degraded > maintenance > operational > unknown`, ignoring `paused`. A project whose services are all paused shows `paused` ("Off").

### 6.3 What the PM sees

`GET /api/work/projects/:id/health` (needs `read:work`) returns exactly:

```ts
{
  health: Health,
  since: string | null,              // when the project entered this state
  services: {
    id: string,                      // needed for stable keys; not usable on ops routes without read
    name: string,
    icon: ServiceIcon | null,
    health: Health,
    since: string | null,
    uptime30d: number | null,        // percent, only when a monitor exists
    days: { date: string, health: Health }[] | null,   // 30 bars, from monitor_daily
    url: string | null,              // primary public https domain, if any
  }[],
}
```

Nothing else: no image, commit, deployment, replicas, node, ports, logs, env, domain config. The route test asserts the exact key set (`Object.keys` deep compare), so adding a field needs a deliberate test change.

`health` and `since` also appear on `GET /api/work/projects` (list) for the dots.

### 6.4 UI

- Projects grid: a dot plus label ("Operational", "Degraded since 14:02", "Down for 12 min", "Maintenance", "Off").
- Project overview: a "Services" card listing each service with its pill, the 30-day bar when a monitor exists, and an "Open ↗" link to its URL. Copy for each state, written for non-technical readers: *Degraded: "Working, but slower or partly unavailable. The team has been notified."* (the "notified" part only when a notification rule covers it; otherwise no claim).
- Health changes push over the WebSocket (`service.status_changed` and `monitor.*` already exist; the hub re-projects them into a Work health message for Work subscribers).

---

## 7. Filter language

```ts
type FilterNode =
  | { and: FilterNode[] } | { or: FilterNode[] }
  | { key: FilterKey, op: FilterOp, value?: unknown };

type FilterKey = "status" | "statusCategory" | "assignee" | "priority" | "list" | "tag"
  | "startDate" | "dueDate" | "createdAt" | "updatedAt" | "completedAt"
  | "createdBy" | "text" | "parent" | "isMilestone" | "blocked" | `field:${string}`;

type FilterOp = "is" | "is_not" | "any_of" | "none_of" | "all_of" | "empty" | "not_empty"
  | "contains" | "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "between"
  | "before" | "after" | "on" | "relative";
```

- `value` for `assignee`/`createdBy`/user fields accepts `"me"`.
- Relative date values: `today`, `yesterday`, `tomorrow`, `this_week`, `last_week`, `next_week`, `this_month`, `next_7_days`, `last_7_days`, `next_30_days`, `overdue`, `no_date`. Resolved with the viewer's timezone.
- The UI allows two levels (a top-level and/or of conditions and condition groups), the API up to four. Max 30 conditions.
- `validateFilter` (core) checks that keys, ops and values fit the field kind (`fieldFilterOps`). The server compiles a validated node into Drizzle SQL (`apps/server/src/work/filter-sql.ts`). Field conditions become `exists (select 1 from work_field_value v where v.task_id = t.id and v.field_id = $1 and <jsonb predicate>)`. Free text uses `search @@ websearch_to_tsquery('simple', $q)`, plus a prefix match on title for typeahead.

URL encoding: views store filters in config. Ad-hoc filters live in the URL search params as compact JSON (TanStack Router search schema), so a filtered view is shareable.

---

## 8. API (`apps/server/src/routes/work/`)

All routes under `/api/work`, contracts in `packages/contracts/src/work.ts`, registered with OpenAPI metadata (operation ids `work_*`, so MCP tools are named `work_task_create`, etc.). Each route resolves the project `Resource` (with folder ancestry, via `locate`) and checks one action. Mutations go through `mutation()` so they get audit (where listed) and, once automations land, idempotency keys. Errors use the existing `Failure` codes.

### 8.1 Projects and settings

| Method & path | Action | Notes |
|---|---|---|
| GET `/projects` | read:work (per row) | `{id, name, folderPath, key, health, since, counts: {open, overdue, mine, doneThisWeek}, archived}`; folder tree order |
| GET `/projects/:id` | read:work | settings visible to all readers (key, workingDays, timeTracking, allowShareLinks) |
| PATCH `/projects/:id/settings` | work:admin | key (unique, aliased on change), hiddenServiceIds (must belong to the project), workingDays, closingStatusId, repos, guestsAssignable, allowShareLinks, timeTracking. Audited. |
| GET `/projects/:id/health` | read:work | section 6.3 |
| GET `/projects/:id/summary` | read:work | counts per status/category, per assignee, overdue, completed per week (last 12), for overview and reports |
| GET `/projects/:id/people` | read:work | `{userId, name, avatar, assignable, guest}` |
| GET `/projects/:id/services` | work:admin | service names only, for the hidden-services picker |

### 8.2 Structure

| Method & path | Action |
|---|---|
| GET/POST `/projects/:id/statuses`, PATCH/DELETE `/statuses/:id` (`?moveTo`), PATCH `/projects/:id/statuses/order` | read:work / work:admin |
| GET/POST `/projects/:id/lists`, PATCH/DELETE `/lists/:id` (`?moveTo`/`?deleteTasks`), POST `/lists/:id/archive`, `/restore`, PATCH `/projects/:id/lists/order` | read:work / work:admin |
| GET/POST `/projects/:id/fields`, PATCH/DELETE `/fields/:id`, PATCH `/projects/:id/fields/order` | read:work / work:admin |
| GET/POST `/projects/:id/tags`, PATCH/DELETE `/tags/:id` | read:work / work:admin (creating a tag inline from the task sheet needs only `work`) |
| GET/POST `/projects/:id/views`, PATCH/DELETE `/views/:id`, PATCH `/projects/:id/views/order` | shared: work:admin; personal: work (own only) |

Changing a field's kind is refused (`conflict`); the UI offers "duplicate as new kind" instead. Changing select options is allowed; removing one shows how many tasks use it first.

### 8.3 Tasks

| Method & path | Action | Notes |
|---|---|---|
| GET `/tasks` | read:work | query: `projectId` (required unless `assignee=me`), `listId`, `viewId` (applies its filter/sort), `filter` (JSON FilterNode, ANDed with the view), `sort`, `groupBy` + `group` (one group's page, for board columns), `parentId` / `topLevel`, `include` (`fields,assignees,tags,counts`), `cursor`, `limit ≤ 200`. Keyset pagination on (sort keys, id). Returns `{items, nextCursor, total?}` (total only when cheap: without free text) |
| GET `/tasks/by-key/:key` | read:work | `SHOP-42`, resolves aliases, returns 301-style `{taskId}` for the router |
| POST `/tasks` | work | `{listId, title, parentId?, statusId?, assignees?, priority?, startDate?, dueDate?, dueTime?, description?, fields?, tags?, position? \| after?/before?}`; number allocated in the same transaction |
| GET `/tasks/:id` | read:work | full task: fields, assignees, watchers, tags, checklist, subtasks summary, dependencies (both directions with blocked state), attachments, counts, git links (filtered, 12.4) |
| PATCH `/tasks/:id` | work | partial; header `If-Unmodified-Since: <updatedAt>` or body `expectedUpdatedAt`; mismatch → `409 conflict` with the current task. Title/description/status/priority/dates/estimate/milestone/recurrence |
| POST `/tasks/:id/move` | work | `{listId?, statusId?, before?, after?}`: one call for any drag. Group-by moves on the board (priority, assignee, select field, due bucket) go through PATCH with the corresponding field |
| POST `/tasks/:id/move-project` | work on both projects | `{projectId, listId, statusMap?, fieldMap?}` → new number, alias written, unmappable fields reported back in `dropped[]`; dry-run with `?dryRun=true` |
| POST `/tasks/:id/duplicate` | work | options: subtasks, checklist, fields, assignees, attachments (re-referenced blobs, no copy) |
| POST `/tasks/:id/archive`, `/restore` | work | |
| DELETE `/tasks/:id` | work:admin, or creator within 15 min | audited |
| POST `/tasks/bulk` | work (each task checked) | `{taskIds ≤ 500, set: {statusId?, listId?, priority?, addAssignees?, removeAssignees?, addTags?, removeTags?, startDate?, dueDate?, shiftDays?, fields?}, archive?, delete?}`; one transaction; returns per-task errors |
| PUT/DELETE `/tasks/:id/assignees/:userId` | work | assignable check |
| PUT/DELETE `/tasks/:id/watchers/:userId` | read:work (self) / work (others) | |
| PUT/DELETE `/tasks/:id/tags/:tagId` | work | |
| PUT/DELETE `/tasks/:id/fields/:fieldId` | work | value parsed by `parseFieldValue` |
| POST/DELETE `/tasks/:id/dependencies` (`{blockedById, lagDays}`) | work | cycle → `conflict` naming the loop |
| POST `/tasks/:id/shift-preview` | read:work | `{deltaDays}` → dependants that would move (for the timeline prompt) |
| GET/POST `/tasks/:id/checklist`, PATCH/DELETE `/checklist/:id`, POST `/checklist/:id/convert` | read:work / work (comment:work may tick items assigned to them) | |
| GET `/tasks/:id/activity` | read:work | merged activity + comments, cursor paginated, newest last |

### 8.4 Comments and attachments

| Method & path | Action | Notes |
|---|---|---|
| GET/POST `/tasks/:id/comments` | read:work / comment:work | body sanitised, mentions diffed, watchers updated |
| PATCH/DELETE `/comments/:id` | author (comment:work) / work:admin | edits keep `editedAt`; delete is soft |
| POST `/comments/:id/resolve`, `/unresolve` | work | |
| PUT/DELETE `/comments/:id/reactions/:emoji` | comment:work | |
| POST `/attachments` | work (task) / comment:work (comment) | multipart: `file`, `taskId?`, `commentId?`, `inline?` (section 10) |
| GET `/attachments/:id` | read:work | `?thumb=1` for the thumbnail |
| DELETE `/attachments/:id` | uploader or work:admin | soft delete |

### 8.5 Me

| Method & path | Notes |
|---|---|
| GET `/me/tasks` | tasks assigned to me across projects I can read, grouped by `dueBucket`; `?include=watching` adds watched ones |
| GET `/me/inbox` | cursor paginated notifications with task title/key/project; `?unread=1` |
| POST `/me/inbox/read` | `{ids}` or `{all: true}` |
| GET/PUT `/me/prefs` | email mode, kinds, daily hour, timezone |
| POST `/me/ical-token` | rotate; returns the URL once (phase 3) |

### 8.6 Search

`GET /work/search?q=&projectId?` returns up to 20 tasks. Ranking: exact key match (`SHOP-42`, or `42` inside a project), then title prefix, then `ts_rank` over task text and comment text. Used by ⌘K, the mention/task-reference picker in the editor, and the dependency picker.

---

## 9. Realtime

- Every Work mutation publishes on the existing events Redis channel: `{type: "work", organizationId, projectId, taskIds?, entity: "task"|"list"|"status"|"field"|"view"|"comment"|"tag"|"project", op: "upsert"|"delete", actorId}`. Publishing happens after commit, from the same helper that writes activity.
- The WebSocket hub (`apps/server/src/ws.ts`) forwards Work messages to sockets whose actor can `read:work` on that project. The check is cached per socket and project, and invalidated on `ACCESS_CHANNEL` messages, which already fire on grant changes.
- Web: one `useWorkSubscription(projectId)` hook. `task` upserts refetch the task and patch it into cached lists, using `matchesTask` (core) to decide whether it enters or leaves each cached view. Anything structural (`status`, `field`, `list`) invalidates the project's queries. The actor's own echoes are skipped (`actorId === me` and a matching mutation in flight).
- Optimistic updates for drag, inline edits, checkbox ticks and reactions, rolled back with a toast on error. On `409 conflict` the task sheet shows "Sara changed this task. Your edit: … Reload / Overwrite."
- Presence, typing indicators and live cursors are out of scope.

---

## 10. Attachments

### 10.1 Upload pipeline (`apps/server/src/work/attachments.ts`)

1. Stream the multipart body with a hard cap (default 25 MB, instance setting `workAttachmentMaxMb`, max 100). Over the cap → `413`.
2. Hash (sha256) while streaming to a temp file in the container's tmp dir.
3. Sniff the content type from magic bytes (small in-house table: png, jpeg, gif, webp, avif, heic, pdf, zip, docx/xlsx/pptx (zip with markers), mp4, mov, webm, mp3, wav, txt/csv/md/json by UTF-8 check). Unknown → `application/octet-stream`. **SVG is stored as `image/svg+xml` but never served inline or thumbnailed.**
4. Images: decode, strip EXIF (privacy: GPS), rotate by orientation, record width/height, make a 480 px WebP thumbnail. Library: `sharp` (prebuilt binaries for linux-x64/arm64 musl/glibc, Apache-2.0). If `sharp` can't load on the platform, thumbnails are skipped and the original is shown scaled. HEIC → thumbnail only if libvips supports it, otherwise a generic icon.
5. Quota check: sum of `size` of live attachments in the org vs `workAttachmentQuotaGb` (org setting, default 2 GB when the driver is `db`, unlimited for `s3`). Over quota → `409 quota_exceeded` with numbers.
6. Store through the driver (dedup by sha256 within the org), insert the `work_attachment` row, write activity, publish realtime.

### 10.2 Drivers (`apps/server/src/work/blob-store.ts`)

```ts
interface BlobStore {
  put(key: string, file: BunFile, contentType: string): Promise<void>;
  get(key: string, range?: {start: number, end?: number}): Promise<{body: ReadableStream, size: number}>;
  delete(key: string): Promise<void>;
}
```

- `db`: `work_blob` insert `on conflict (sha256) do update set ref_count = ref_count + 1`. Reads stream the bytea (Postgres sends it in one piece; the 25 MB cap keeps memory bounded).
- `s3`: org setting `workAttachmentDestinationId` → existing `s3_destination`, through Bun's S3 client (as backups do; see the backup-destinations memory about Bun S3 buffering: use multipart for > 5 MB). Range requests are passed through.
- Switching driver: "Move attachments to S3" job (worker queue `work`, job `migrate-blobs`): copies each blob, flips `driver`/`objectKey`, then decrements the `db` refCount. Resumable, idempotent per attachment. Progress over the WebSocket.

### 10.3 Serving

`GET /api/work/attachments/:id`:
- permission check on the attachment's project,
- `Content-Type` = stored sniffed type, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox`,
- `Content-Disposition: inline` only for raster images, PDF, audio/video. Everything else (including SVG, HTML, text) is `attachment; filename*=UTF-8''…`,
- `Cache-Control: private, max-age=3600`, ETag = sha256, Range support for media.

### 10.4 Garbage collection

The maintenance tick (existing `maintenance` queue, new scheduler `work-gc` daily): hard-delete attachments soft-deleted more than 30 days ago, decrement or delete blobs, and delete S3 objects with no live reference in the org.

---

## 11. Rich text

- Tiptap with StarterKit (paragraph, headings h2–h3, bold, italic, strike, code, code block, blockquote, bullet/ordered list, hard break, horizontal rule), Link, Task list (inline checkboxes in descriptions, separate from the checklist), Image (only our attachment URLs), Mention (users), a custom **TaskRef** node (`SHOP-42` chips with live title and status), Placeholder, Typography. No tables, embeds or colours in v1.
- Paste or drop an image: upload with `inline=description|comment`, insert an image node with a temporary blob URL, swap it for the attachment URL on success, and remove it with a toast on failure.
- Markdown shortcuts work (`#`, `-`, `[]`, `` ` ``, `>`). Pasting markdown text converts it.
- Server: `sanitizeDoc` on every write (allow-list), `docToText` for search and notifications. Read-only rendering uses the same Tiptap schema with `editable: false` (no second renderer). Emails use `docToEmailHtml` (core, string building, escaped).
- Typing `SHOP-42` in plain text autolinks to a TaskRef on save (`extractTaskRefs`), restricted to keys of projects the author can read.
- The description autosaves 800 ms after typing stops, with "Saved" feedback (Torph label swap, per the UI skills). On conflict it falls back to section 9.

---

## 12. Extras (phase 4, each shippable on its own)

### 12.1 Templates

**What**: save a task (with subtasks, checklist, fields, tags, assignees, description, attachments), a whole list, or a whole project's Work setup (statuses, fields, tags, views, lists with their tasks) as a template, and create new things from it.

**Table `work_template`**: `wtp_`, organizationId, projectId null (null = org-wide, needs org-level `work:admin`), kind enum (`task`, `list`, `project`), name, description, payload jsonb (`TemplatePayload`, zod), createdBy, timestamps, usageCount.

**`TemplatePayload`**:
- `statuses?`, `fields?`, `tags?`, `views?` (project templates), with template-local ids,
- `lists?: {name, color, icon, tasks: TaskTemplate[]}[]`,
- `tasks?: TaskTemplate[]`, where `TaskTemplate = {title, description, priority, startOffset?, dueOffset?, isMilestone, estimateMinutes, statusRef, tagRefs, fieldValues: {fieldRef, value}[], assigneeRefs: ("creator" | {userId} | {placeholder: string})[], checklist: {text, assigneeRef?}[], subtasks: TaskTemplate[], attachmentShas: string[], dependsOn: localTaskIndex[]}`.
- Dates are stored as offsets in working days from an anchor (the earliest start of the source, or project start).

**Flows**:
- *Save as template*: task sheet ⋯ menu / list ⋯ menu / project Work settings. Wizard: name & scope (this project / organization) → what to include (checkboxes: subtasks, checklist, field values, assignees as placeholders or fixed people, attachments, descriptions) → summary.
- *New from template*: "+ New" menu → "From template". Wizard: pick template (search, preview tree) → target (list or project) → anchor date (start on / finish by: back-scheduling uses `addWorkingDays` negative) → map placeholders to people → field mapping when the target project lacks fields (create them, if `work:admin`, or drop: listed) → summary with counts → create in one transaction.
- Project creation wizard (ops and Work shells) gains an optional step "Start from a Work template".

**Core**: `instantiateTemplate`. **Tests**: offsets with working days, back-scheduling, placeholder mapping, missing fields, dependencies preserved.

**Built-in templates** (seeded per instance, read-only, duplicable): "Website launch" (discovery → design → build → content → QA → launch milestone), "Client onboarding", "Bug triage". Written in plain English with no LogiStack jargon.

### 12.2 Recurring tasks

**What**: a task repeats on a rule. When an occurrence is completed (or on a schedule), the next one is created.

**`RecurrenceRule`** (zod, stored in `work_task.recurrence`):

```ts
{
  freq: "daily" | "weekly" | "monthly" | "yearly",
  interval: number,                 // 1–365
  byWeekday?: (0|1|2|3|4|5|6)[],    // weekly
  monthly?: { kind: "dayOfMonth", day: 1..31 | -1 } | { kind: "nthWeekday", n: 1..4 | -1, weekday: 0..6 },
  mode: "on_complete" | "on_schedule",
  createDaysBefore?: number,        // on_schedule: create N days before the due date (default 0 = on the due date's morning)
  ends: { kind: "never" } | { kind: "on", date: string } | { kind: "after", count: number },
  copy: { subtasks: boolean, checklist: boolean, fields: boolean, assignees: boolean, description: boolean },
  skipWeekends?: boolean,           // move to the next working day
}
```

**Behaviour**:
- Every occurrence is a full task sharing `recurrenceSeriesId`. The rule lives on the latest occurrence only, and moves forward when the next one is created.
- `on_complete`: inside the status-change transaction that sets `completedAt`, compute `nextOccurrence(rule, prevDates)` and insert the next task (same list, first `active` status, checklist unticked). Its dates are shifted from the previous **scheduled** dates, not from completion time, so a late completion doesn't drift the series. Reopening the completed task doesn't delete the next one.
- `on_schedule`: the worker tick `work-recurrence` (hourly, `maintenance` queue) finds series whose next occurrence's creation time has passed and inserts it. The idempotency guard is the unique index `(recurrence_series_id, due_date)`: `insert … on conflict do nothing`, safe with several workers.
- Ending by `after count` stores `remaining` in the rule.
- Editing the rule on any occurrence applies to future ones. "Stop repeating" clears it.

**UI**: in the task sheet's date picker, a "Repeat" row → popover with presets (Every day, Every weekday, Every week on <day>, Every month on the <n>th, Custom…) and the full form. A ↻ icon on cards/rows; the tooltip shows `describeRule`. Activity entry `recurred` links the previous occurrence.

**Tests**: `nextOccurrence` edge cases (core); the route test completes a task twice concurrently and asserts exactly one next occurrence.

### 12.3 Time tracking

**What**: start/stop a timer on a task or add entries by hand. See tracked vs estimated time. Get reports by project, person, task or day, with CSV export. Billable flag for agency reporting. No rates or invoices.

**Table `work_time_entry`**: `wte_`, organizationId, projectId cascade, taskId → work_task cascade, userId → user cascade, startedAt tstz, endedAt tstz null (running), durationSec integer null (set on stop or for manual entries), note text ≤ 500, billable boolean default true, source enum (`timer`, `manual`, `import`), timestamps. Partial unique index `(user_id) where ended_at is null`: one running timer per user, enforced by Postgres. Index (projectId, startedAt), (userId, startedAt).

**Routes**:
- POST `/tasks/:id/timer/start` (work; stops any running timer first in the same transaction and returns both),
- POST `/me/timer/stop`, GET `/me/timer`,
- GET/POST `/tasks/:id/time`, PATCH/DELETE `/time/:id` (own entries with `work`, others' with `work:admin`; entries older than the project's lock date (`work_project.timeLockedBefore`, optional) are read-only),
- GET `/time/report?projectId?&userId?&from&to&groupBy=project|user|task|day|week&billable?` → rows + totals; `format=csv` streams CSV.

**Rules**: a running timer longer than 12 hours sends the user an in-app notification "Still working on SHOP-42?". It is never auto-stopped, because that would silently lose time. Entries can't overlap for the same user (checked in core `rollupTime`'s sibling `overlaps`; the API rejects with the clashing entry).

**UI**:
- Task sheet: "Time" row: ▶ button, the running clock (tabular numbers), total tracked vs estimate as a thin bar, "Add time" (duration parser: `1h30`, `90m`, `1.5h`, date, note, billable).
- Global: a running-timer pill in the header (both shells) with the task key and a stop button. Keyboard `t` toggles the timer on the open task.
- **Time** page (Work shell sidebar, Tasks section for ops): week grid per person (rows = tasks, columns = days, editable cells), and a report tab with filters, a group-by switch, totals and CSV export.
- Project setting `timeTracking` hides all of this when off.

**Tests**: concurrent start → one running timer; overlap rejection; report grouping across timezones and midnight; CSV escaping.

### 12.4 Git integration (developers' side)

**What**: commits, branches and pull requests that mention `SHOP-42` link to the task. "Fixes SHOP-42" closes it when merged to the default branch. Developers see the links. PMs only see that work is linked and its state, never commit or deploy details.

**Which repos**: the repos of the project's services (git sources already stored on services) plus `work_project.repos`. A push or PR from a repo matches the projects that list it.

**Parser changes** (additive): today the GitHub/Gitea push payload keeps only `head_commit.message`. Extend the zod schemas in `packages/providers/src/git/github-style.ts`, `gitlab.ts` (and the others) to read every commit's `id`, `message`, `url`, `author.name` (GitHub sends up to 20 commits per push; beyond that we use what we get). Read the PR body and `merged` flag too. `PushEvent` gains `commits?: {sha, message, url?, author}[]` and `PullRequestEvent.pr` gains `body?`, `url`, `merged?`, `state`. Deploy code ignores the new fields.

**Flow** (`apps/server/src/work/git-links.ts`, called from `routes/webhooks.ts` after verification, independent of deploy handling and never changing its response or status code):
1. Find projects in the provider's org whose repos include `event.repo` and that have a `work_project`.
2. `parseWorkRefs` over each commit message, the PR title, the PR body and the head branch name (`feature/shop-42-login` → SHOP-42, case-insensitive for branches only). Keys must belong to those projects (aliases resolved).
3. Upsert **`work_git_link`**: `wgl_`, taskId cascade, providerId, repo, kind enum (`commit`, `branch`, `pull_request`), ref (sha, branch name, PR number), title, url, state enum (`open`, `merged`, `closed`, `pushed`), author (provider login/name, not a LogiStack user), createdAt, updatedAt; unique (taskId, providerId, repo, kind, ref).
4. Closing: a ref with `closes = true` (`fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved` followed by the key) closes the task when the commit lands on the repo's default branch (push to default) or the PR is merged into it. "Closes" means: set `closingStatusId` (or the first `done` status) only if the task isn't already `done`/`cancelled`. Activity `git_closed` with `{repo, ref, author}`. Watchers are notified (`status_changed`).
5. Realtime publish.

**Visibility**: `GET /tasks/:id` returns `git.links` (full: titles, urls, authors) only if the actor also holds `read` on the project. Otherwise it returns `git.summary = {pullRequests: {open, merged}, commits: n}` and the sheet shows "Development: 1 change in review · 2 merged". No titles, links or commit text, since commit messages can contain deploy talk.

**Developer helpers**: a "Copy branch name" button (`shop-42-short-title-slug`) and "Copy commit message" (`SHOP-42: <title>`) in the sheet, for actors with `read`. Ops users see a "Released" line too: when a succeeded deployment of a service in this project contains a linked commit (matched by sha on `deployment.commitSha`), the sheet shows "In production since 14:20" with a link to the deployment. Hidden from work-only actors.

**Tests**: parser fixtures per provider (with the new fields), ref parsing, idempotent upsert on webhook redelivery, close only on default branch, visibility split by `read`.

### 12.5 Import from ClickUp

**What**: a guided wizard that brings ClickUp spaces/folders/lists, tasks, subtasks, checklists, statuses, custom fields, tags, assignees, comments, attachments, dependencies and time entries into LogiStack projects. Re-running it updates instead of duplicating.

**Tables**:
- **`work_import`**: `wim_`, organizationId, kind enum (`clickup`, `csv`), createdBy, status enum (`draft`, `ready`, `running`, `succeeded`, `failed`, `cancelled`), configEncrypted (token + mapping, encrypted with the existing envelope crypto from `packages/core/src/crypto.ts`; the token is wiped from config once the run ends), plan jsonb (dry-run result), progress jsonb (`{phase, done, total}` per entity), report jsonb (counts, warnings, skipped with reasons), startedAt, finishedAt.
- **`work_import_map`**: (importId-independent) `organizationId, source, externalType, externalId` PK → `localId`, `localType`, `updatedAt`. Keyed by source rather than import, so a second import of the same workspace updates the same rows.

**Wizard** (`apps/web/src/components/work/import/clickup-wizard.tsx`, rule 8):
1. **Connect**: paste a personal API token (`pk_…`, link to ClickUp's settings page). "Test connection" calls `GET /api/v2/user` and `GET /api/v2/team` (workspaces) server-side.
2. **Choose**: tree of workspace → spaces → folders → lists (`/team/{id}/space`, `/space/{id}/folder`, `/space/{id}/list` for folderless lists, `/folder/{id}/list`), with checkboxes and task counts. For each selected space or folder, pick the target: "New project" (name prefilled, folder picker) or an existing project where the user has `work:admin`. ClickUp lists become Work lists.
3. **Statuses**: ClickUp statuses are per list (or inherited). Show the union per target project with an automatic mapping: ClickUp type `open` → our `backlog`, `custom` → `active` with the same name (new status created), `done` → `done`, `closed` → `done` (or `cancelled` when the name matches /cancel|won.?t/i). Colours are mapped to the nearest palette token. Editable dropdowns.
4. **Fields**: each ClickUp custom field with the proposed kind:

   | ClickUp type | Work kind | Notes |
   |---|---|---|
   | text, short_text | text / long_text | |
   | number | number | |
   | currency | currency | currency code from the type config |
   | drop_down | select | options with colours |
   | labels | multi_select | |
   | date | date | `withTime` from the value's time part |
   | checkbox | checkbox | |
   | url, email, phone | url, email, phone | |
   | emoji (rating) | rating | `count` → max |
   | users, people | user | `multiple` |
   | progress (manual) | percent | automatic progress: skipped |
   | formula, rollup, tasks, relationship, location, files, button, signature, voting | — | skipped, or "import as text snapshot" (option) |

   Toggle per field: import / skip / map onto an existing field of the same kind.
5. **People**: ClickUp members (`/list/{id}/member`, team members) matched to org members by email. Unmatched ones: leave unassigned with "Originally assigned to Jane (jane@x.com)" appended to the description, or invite them (creates invitations; nobody gets emailed unless instance mail exists).
6. **Options**: include closed tasks (default on), comments (on), attachments (on; per-file cap and total estimate shown; counts against quota), time entries (on if time tracking is enabled), archived lists (off), keep ClickUp task URLs in `source` (on).
7. **Dry run**: the worker fetches everything without writing and stores `plan`: counts per entity and per target project, warnings (fields skipped, users unmatched, attachments over the cap, total attachment size vs quota). Shown as a summary.
8. **Import**: queue job `work-import` (worker queue `work`). Live progress bar per phase over the WebSocket; cancellable. On success the report lists what was created/updated/skipped, with links.

**Worker details** (`apps/worker/src/work-import/clickup.ts`):
- HTTP through the providers' `Http` client with SSRF pinning, `Authorization: <token>`.
- Rate limit: token bucket at 90 req/min (ClickUp allows 100/min on most plans), honouring `X-RateLimit-Remaining`/`X-RateLimit-Reset` and retrying 429 with the reset time.
- Tasks: `GET /list/{id}/task?page=n&subtasks=true&include_closed=true&include_markdown_description=true` (100 per page), then `GET /task/{id}?include_subtasks=true` only when checklists or dependencies are missing from the list payload.
- Order: statuses/fields/tags → lists → tasks (parents before subtasks) → checklists → dependencies (`dependencies[]` with `type` 1 = waiting on → our `blockedById`; links (`linked_tasks`) become a "Related" line in the description, since we have no related-links concept) → comments (`GET /task/{id}/comment`, threaded replies via `/comment/{id}/reply`), with ClickUp's comment format converted to ProseMirror (text, bold/italic/code, links, mentions mapped to users, unknown blocks as plain text) → attachments (download from the task's `attachments[].url`, through `resolvePublic`, cap per file, then the normal upload pipeline) → time entries (`GET /team/{id}/time_entries?start_date&end_date&assignee=all&list_id=…`).
- Markdown descriptions convert to ProseMirror (a small markdown → PM converter in core: headings, lists, emphasis, code, links, images become attachments when hosted by ClickUp).
- Priority: ClickUp 1 urgent, 2 high, 3 normal, 4 low, null none. Dates: ms timestamps → dates in the workspace timezone (`/team` gives it). `start_date`/`due_date` flags `*_time` → `dueTime` when present.
- Idempotency: before creating any entity, look up `work_import_map`. Found → update the local row (only fields that came from ClickUp, so local edits to other fields survive). Each batch commits its rows and map entries in one transaction, so a crash resumes cleanly.
- Activity entry `imported` on every task. Creator = the ClickUp creator if matched, else the importing user.

**Not imported**: docs, whiteboards, chat, goals, automations, views (we create our default four), dashboards, task types (became a select field "Type" if used), sprints (a select field "Sprint" if the Sprints ClickApp is on, from the list names).

**Tests**: mapping units in core (`clickup-map.ts`); a worker test against a recorded fixture server (Bun.serve replaying JSON captured from the ClickUp API docs' examples, with no real account), covering pagination, 429 handling, rerun-updates-not-duplicates, and attachment cap.

### 12.6 CSV import and export

- **Export**: every table view has "Export CSV" (visible columns, current filters and sort, subtasks per `showSubtasks`). Server-side `GET /tasks?…&format=csv` streams rows. Values use `formatFieldValue` with the viewer's locale for dates; multi-values are joined with `; `. Phase 2.
- **Import** (phase 4): wizard: upload CSV (≤ 10 MB, delimiter and encoding auto-detected, editable) → map columns to title / description (plain → paragraph) / status (map values) / assignee (by email or name) / priority / dates (format picker with preview) / tags / custom fields (or "create field" when `work:admin`) / parent (by title or external id column) → preview the first 20 rows with errors highlighted → import into a chosen list. Runs as a `work-import` job (`kind = csv`), same report and progress UI as ClickUp.

### 12.7 Read-only share links

**What**: a link that shows one list or one view to someone without an account (a client), read-only. Off by default per project (`allowShareLinks`).

**Table `work_share`**: `wsh_`, projectId cascade, listId null, viewId null (one of the two), tokenHash (sha256 of a 32-byte random token; the token is shown once), createdBy, name (internal label), showComments boolean (default false), showAssignees boolean (default true), fieldIds text[] (fields allowed on the page), passwordHash null (argon2id via `Bun.password`), expiresAt null, revokedAt null, lastViewedAt, viewCount.

**Rendering**: like the public status pages, server-rendered HTML with no client JS, at `/share/<token>` on the dashboard host. Table layout grouped by status, plus a static board variant if the view is a board. Task detail pages at `/share/<token>/t/<number>` show the description (sanitised, images through `/share/<token>/a/<attachmentId>` with the same serving headers), checklist progress, allowed fields, and comments only if `showComments`. `noindex`, `Referrer-Policy: no-referrer`, rate-limited per IP. With a password: a form, then a signed cookie scoped to the share path for 12 hours.

**Management**: list ⋯ → "Share link…" wizard (what to show → password/expiry → summary → copy link). Settings → Work → Share links lists all links with views and last access, plus revoke. Creating one needs `work` on the project and `allowShareLinks`. Audited.

### 12.8 Guests

**What**: invite a client by email to **one project** as a guest. They can read and comment, but can't see other projects, the member list or anything ops.

**Invitation scope**: `invitation` has only a role today. Add **`invitation_grant`**: invitationId → invitation cascade, role, scopeKind, scopeId. On acceptance the existing accept flow creates `role_grant` rows from it, in addition to (or instead of) the org-level role. Guests join the org with better-auth member role `member` and no org-level grant. Additive and generic: it also allows "invite a developer to one project".

**Guest experience**: the Work shell, showing only their projects. People pickers show only people on those projects. Mentions work. Notifications and emails work like for members. They can't create tasks unless the project turns on `guestsCanCreate` (a guest-created task lands in the default list's backlog status with a "From guest" tag).

**UI**: project ⋯ → "Invite guest" wizard: email → project (prefilled) → permissions (comment only / can create tasks) → summary → copy invite link (and email it if instance mail is configured). The Members page shows guests in their own section with their project.

### 12.9 Automations integration

When `docs/plans/automations.md` ships:
- Triggers: every `task.*` event (section 14) with filters on project, list, status, assignee, field values.
- Nodes: "Create task", "Update task", "Add comment", "Find tasks" (filter builder reusing `FilterNode`), "Assign", "Move", "Start/stop timer" isn't offered (time belongs to people).
- Ready-made templates: "When a service goes down, open an urgent task in its project and assign the on-call developer"; "When a task moves to Review, assign the project's reviewer"; "Every Monday, post this week's due tasks to Slack".

Until then, no separate rules engine: Work doesn't grow its own mini-automations.

### 12.10 AI assist

All Work routes are MCP tools, so the Agent can already "create tasks for this incident" or "summarise what's overdue in Shop". On top of that, the task sheet gains three buttons, visible when the actor has `ai` and budget:
- **Summarise thread**: comments → 5 bullet summary, posted as a draft comment the user can edit and send.
- **Break into subtasks**: title + description → proposed subtasks with estimates in a review list (tick/untick/edit), then created in bulk.
- **Write description**: title + list context → a draft description inserted into the editor.

They use the in-process AI gateway with the org's budget, model from AI settings. Prompts live in `packages/core/src/work/ai-prompts.ts`, and nothing is sent without a click.

### 12.11 Reports and workload

- **Project overview** (phase 1 has the basics) grows a **Progress** card: done/total by status category, completed per week (last 12 weeks, bar chart), overdue count, and a burn-up of scope vs done over the last 8 weeks. Charts use the existing `charts/` components and the dataviz rules.
- **Workload** (Work shell → Projects → Workload, and ops → Tasks → Workload): rows = people, columns = weeks (next 6), cells = sum of `estimateMinutes` of open tasks spread over their working days between start and due (tasks without start use due only). Over-capacity cells (> `work_user_prefs.capacityHoursPerWeek`, default 32 h) are highlighted. Clicking a cell lists those tasks. Read-only, no drag in v1.
- Data from `GET /projects/:id/summary` and `GET /work/workload?from&weeks&projectIds?`, computed in SQL plus core `dates.ts`.

### 12.12 Calendar feed

`/ical/<token>.ics` (token per user, `work_user_prefs.icalTokenHash`, rotate in Account → Notifications): an iCalendar feed of tasks assigned to the user with due dates (all-day events, or timed when `dueTime` is set), summary `SHOP-42 Title`, URL to the task, refreshed on each fetch. Rate-limited, read-only, no other data. Phase 3.

---

## 13. Web (`apps/web`)

### 13.1 Routes

| Route | Shell | Content |
|---|---|---|
| `_app/work/index.tsx` | both | My tasks (Work shell landing) |
| `_app/work/inbox.tsx` | both | Inbox |
| `_app/work/projects/index.tsx` | Work | project grid with health |
| `_app/work/projects/$projectId/index.tsx` | Work | overview: health card, progress, lists, recent activity |
| `_app/work/projects/$projectId/v/$viewId.tsx` | Work | view host; search params `list`, `task`, `filter`, `q` |
| `_app/projects/$projectId/tasks/…` | ops | the same overview and view host, embedded as a project tab (shared components, two thin route files) |
| `_app/work/time.tsx` | both | Time (phase 4) |
| `_app/work/workload.tsx` | both | Workload (phase 4) |
| `_app/work/import/…` | both (needs work:admin somewhere) | import wizards (phase 4) |
| Project settings → Work tab | ops (+ Work shell project ⋯ → Settings for work:admin) | key, statuses, fields, tags, hidden services, working days, repos, closing status, share links, guests, time tracking |
| Account → Notifications | both | email mode, kinds, daily hour, iCal link |

`?task=tsk_…` opens the task sheet over any page. `/work/t/SHOP-42` resolves by key and redirects (works for aliases).

### 13.2 Components (`apps/web/src/components/work/`)

**ViewHost**: view tabs (sliding tabs component exists: `sliding-tabs.tsx`), "+ View" (wizard: kind → name → shared/personal → starting filter → done), filter bar (chips, "+ Filter" popover with the field list, operator and value per kind, groups), sort menu (≤ 3), group menu, column chooser (table) or card fields (board), "Show closed" toggle, subtasks mode, search box (debounced `text` filter), "Save view" when ad-hoc changes differ from the saved config ("Save / Save as new / Reset"), and the export menu.

**TableView**:
- TanStack Table + `@tanstack/react-virtual` rows. Groups as collapsible section headers with counts and a "+ Add task" row per group.
- Columns: key, title (with subtask count and expand caret when nested), status, assignees, priority, start, due, tags, list, estimate, tracked time, created, updated, and every custom field. Resizable, reorderable by drag, pinned title column.
- Inline editing per kind: click or Enter to edit, Esc cancels, Tab moves to the next cell. Editors are shared with the task sheet (`FieldEditor`).
- Multi-select with checkboxes, shift-click ranges, `x` toggles. A bulk bar slides up (transitions skill): status, assignee, priority, dates (set / shift by n days), tags, list, archive, delete.
- Keyboard: ↑/↓ rows, ←/→ cells, Enter open, `e` edit cell, `c` new task in the current group, `⌘↑/⌘↓` move a task (manual sort only).
- Empty state: "No tasks match these filters", plus "Clear filters".

**BoardView**:
- Columns from `groupBy`: status (default), priority, assignee (a task with two assignees appears in both columns; dropping it in another assignee's column replaces that assignee), list, tag, select field, due bucket (dropping sets the date: Today, Tomorrow, Next week…). Columns that would need ambiguous writes (multi-select, tag) are view-only for drag, and the cursor shows it.
- dnd-kit with pointer and keyboard sensors (space to lift, arrows to move, space to drop, Esc to cancel), with live-region announcements ("Moved SHOP-42 to In progress, position 3 of 7").
- Cards: key, title, cover image (first image attachment, optional per view), assignee avatars, due date (red when overdue), priority flag, chosen card fields, subtask/checklist progress, comment count, blocked icon.
- Column header: name, colour dot, count, collapse, WIP limit (status columns, `work_status.wipLimit` optional, header turns amber over it), "+" quick add.
- Swimlanes (`subGroupBy`, phase 3): horizontal bands by assignee/priority/list/select.
- Long columns lazy-load 50 cards at a time.

**TimelineView** (waterfall, phase 3):
- Layout: a left pane (resizable, 280 px default) with the task tree (rows by list, by assignee, or flat; subtasks indented, collapsible) and a right pane with the time grid. Both share one virtualised scroller vertically; the grid scrolls horizontally with sticky month/week/day headers.
- Zoom: day (40 px/day), week (16 px/day), month (5 px/day), quarter (2 px/day). Ctrl/⌘+scroll zooms around the pointer. "Today" button.
- Bars: from start to due; status colour; done bars muted; milestones as diamonds; tasks with only a due date show as a short bar ending on the due date (1 working day, dashed start); progress fill from subtasks/checklist; label inside or to the right when narrow; assignee avatars at the end.
- Interactions: drag the bar to move both dates (snaps to days; at week/month zoom snaps to days too, with a date tooltip while dragging); drag the edges to resize; drag the connector dot at a bar's end onto another bar to create a dependency; click an arrow to select it, then Delete removes it. Keyboard: a focused bar moves with ←/→ (1 day), shift+←/→ resizes the end, `⌘D` opens the dependency picker.
- Dependants: when a move pushes a task's due date past a dependant's start minus lag, a non-blocking popover offers "Also move 3 dependent tasks" with a preview from `/shift-preview`. Applied as one bulk call. Arrows of violated dependencies turn red.
- Weekends shaded per `workingDays`; non-working days are skipped by working-day maths but still drawn.
- **Unscheduled tray**: a collapsible strip listing tasks without dates; drag one onto the grid to set start = drop day and due = start + estimate (in working days, default 1).
- Rendering: bars are absolutely positioned divs from `barGeometry`. Dependency arrows are one SVG layer per visible window, with orthogonal paths and rounded corners. Only visible rows and the visible date range ± one screen are rendered.

**CalendarView** (phase 3): month grid (6 weeks) and week view (columns per day, timed tasks placed by `dueTime`, all-day row on top). `dateField`: due only, span start→due (multi-day bars wrap across weeks), or a custom date field. Drag to reschedule (moves both dates for spans, preserving duration); drag a span's ends to resize. A "+N more" popover for busy days. An unscheduled sidebar, as on the timeline. Keyboard: arrows move the focused day, Enter opens the day's list, `n` creates a task due that day.

**TaskSheet**: a side sheet (≈ 720 px, full screen on mobile) with:
- Header: breadcrumb (project / list / parent), key with copy link, watch toggle, ⋯ menu (duplicate, move to list/project, convert to subtask/parent, save as template, archive, delete, copy branch name for `read` holders), close.
- Title (inline, autosize).
- Properties grid: status (pill dropdown, `s`), assignees (`a`), dates (range picker with due time and the Repeat row, `d`), priority (`p`), tags, list, estimate, tracked time (phase 4), milestone toggle, then custom fields (hide empty fields behind "Show N empty fields").
- Description editor (section 11).
- Subtasks: a compact table (status, title, assignee, due) with quick add (Enter adds the next) and drag reorder.
- Checklist: items with an assignee avatar and drag reorder; "Convert to subtask".
- Dependencies: "Blocked by" and "Blocking" lists, with the blocked state and an add picker (search).
- Attachments: grid of thumbnails and file chips, drop zone covering the sheet, lightbox with ←/→ and download.
- Development (phase 4): links or the summary (12.4).
- Activity: merged timeline of comments and activity entries, filter "Comments only / All", newest at the bottom. A composer at the bottom with mentions, task refs, attachments and `⌘Enter` to send. Comment ⋯ menu: edit, delete, copy link, resolve thread. Reactions bar. Replies are indented one level.
- All edits autosave with per-field optimistic updates; a subtle "Saving… / Saved" Torph label in the header.

**Other components**: `FieldEditor` and `FieldDisplay` per kind; `FieldWizard` (kind with an example preview → name & description → options or config → scope (whole project / one list) → required? → summary); `StatusEditor` (drag order, colour tokens, category, WIP limit, delete with move-to); `PeoplePicker`; `DateRangePicker` with natural input ("next fri", "in 2 weeks", parsed by a small core helper `parseHumanDate`); `HealthPill`, `ServiceHealthList`, `UptimeBars` (reuse the uptime components where possible); `InboxList` (grouped Today/Earlier, mark read on open, "Mark all read", filter by kind); `MyTasks` (buckets with counts, inline status/due editing, keyboard nav, "Show watching" toggle).

### 13.3 Keyboard shortcuts (shown with `?`)

| Key | Action |
|---|---|
| `c` | new task (in context) |
| `/` | focus search |
| `⌘K` | command palette |
| `g m` / `g i` / `g p` / `g t` | My tasks / Inbox / Projects / Time |
| `1`–`4` | switch to the view in that tab position |
| `j` / `k` | next / previous task (lists, inbox) |
| `Enter` / `Esc` | open / close task |
| `s` `a` `d` `p` `l` | status / assignee / dates / priority / labels (tags) on the focused or open task |
| `x` | select |
| `t` | start/stop timer on the open task |
| `⌘Enter` | send comment |
| `⌘.` | copy task link |

Shortcuts are disabled inside text inputs, and listed in the palette.

### 13.4 Design, accessibility, quality bar

- Load the UI skills from CLAUDE.md before UI work. Same quiet look as the rest of the dashboard: neutral surfaces, palette tokens for statuses, no gradients, light and dark.
- Status colours are tokens defined in both themes with ≥ 3:1 contrast against the surface for the dot and ≥ 4.5:1 for text pills.
- Motion: board drops spring briefly; the sheet slides in at 200 ms; the bulk bar slides up; everything respects `prefers-reduced-motion`.
- Accessibility: every drag has a keyboard alternative (board sensors, timeline arrows, "Move to…" menu on rows and cards); landmarks per pane; the table uses grid roles with roving tabindex; the timeline offers a "List equivalent" button that opens the same rows as a table.
- Mobile: the Work shell is usable on a phone (My tasks, Inbox, task sheet full screen, board with horizontal column snap). The timeline is read-only below 768 px.
- Performance budgets: board with 1 000 tasks and table with 10 000 tasks scroll at 60 fps on a mid laptop; the task sheet opens in < 150 ms from cache.

### 13.5 Mock and screenshots

`apps/web` mock data gains a Work fixture: org "Acme Studio", projects "Shop" (healthy, 2 services), "Blog relaunch" (degraded), "Brand book" (no services), about 120 tasks across lists with fields, comments, images, dependencies and dates spread over 3 months, plus users with avatars. `bun run screenshots` captures: projects grid, board, table, timeline, task sheet, My tasks, health card, PM shell. Used by `docs-site/`.

---

## 14. Events, notifications, email

### 14.1 Events (`eventTypes`)

New: `task.created`, `task.assigned`, `task.status_changed`, `task.completed`, `task.commented`, `task.due_soon`, `task.overdue`. Resource `task:<id>`, payload `{projectId, taskKey, title, actorId, statusName?, assigneeIds?, url}`. They reach existing notification rules (Slack/Discord/email channels per org), so a team can route "tasks completed in Shop" to a channel. Rule scopes on a project already match because the payload carries `projectId`.

### 14.2 Personal notifications

| Kind | Who gets it |
|---|---|
| assigned / unassigned | the assignee (not when assigning yourself) |
| mentioned | each newly mentioned user with `read:work` |
| commented | watchers except the author |
| replied | the parent comment's author and thread participants |
| status_changed | watchers except the actor; only for moves into `done`/`cancelled` or out of them, plus any change on tasks you created (keeps noise down) |
| due_soon | assignees, 24 h before due (or on the morning of the due date for date-only tasks, at `dailyHour`) |
| overdue | assignees, once, the morning after the due date |
| checklist_assigned | the item's assignee |

Bundling: several notifications for the same task and user within 5 minutes collapse into one inbox row ("Sara changed 3 things on SHOP-42").

Scheduler: `work-due` tick hourly on the `maintenance` queue. It finds tasks crossing the due-soon/overdue thresholds in each user's timezone, and inserts notifications with a unique key `(userId, taskId, kind, dueDate)` so each fires once.

### 14.3 Email

LogiStack has no instance mailer today: invitations don't send email, and notification channels are org-level. Add an **Instance mail** setting (instance settings, admin only), reusing `emailConfig` from `packages/providers/src/notify/channels/email.ts` without `to` (SMTP or Resend), with a "Send test email" button. It is a wizard: transport → credentials → from address → test → summary. It also unlocks invitation emails, which today are copied by hand.

When configured:
- `instant`: an email shortly after each notification. A 2-minute delay lets bundling and read-in-app cancel it (`emailedAt` / `readAt` checked at send time). Job on the `work` queue, delayed.
- `daily`: one digest at `dailyHour` in the user's timezone: due today, overdue, assigned since yesterday, mentions. Skipped when empty.
- Content: plain text + simple HTML from `docToEmailHtml`, a link to the task, and an unsubscribe-from-this-kind link (signed token → toggles `emailKinds`). Rendering lives in core with snapshot tests.

Without instance mail, the email options in Account → Notifications are disabled with the hint "Ask an admin to set up instance email".

---

## 15. Activity and audit

- `work_activity` is the user-facing history (section 4.4). It is never written for reads, and never stores rich-text bodies: only before/after for scalar values, and "description edited" without the text.
- The audit log gets: list/status/field/tag/task deletes, Work settings changes, share link create/revoke, import runs, guest invites, attachment driver migrations. It uses the existing `mutation()` wrapper with `resource = work_*:<id>`.

---

## 16. Limits

| Thing | Limit | Where |
|---|---|---|
| Lists per project | 200 | API |
| Statuses per project | 30 | API |
| Fields per project | 100 (incl. list-scoped) | API |
| Select options per field | 200 | zod |
| Tasks per project | none enforced; tested to 50 000 | perf tests |
| Subtasks per task | 200 | API |
| Checklist items per task | 200 | API |
| Assignees per task | 20 | API |
| Attachments per task | 100 | API |
| Attachment size | 25 MB default, instance max 100 MB | instance setting |
| Description / comment | 200 KB / 50 KB serialised | zod |
| Views per project | 50 shared + 20 personal per user | API |
| Bulk operation | 500 tasks | zod |
| Search results | 20 | API |

---

## 17. Testing

### 17.1 Core (`bun test packages/core`)

Every module in section 5 with table-driven tests, including DST and leap-year cases in `dates.ts`, `recurrence.ts` and `filter.ts`. Snapshot tests for `docToEmailHtml` and `sanitizeDoc`.

### 17.2 Server (`bun test apps/server`)

- **Leak test** (`work-isolation.test.ts`): build a `manager` actor with a project grant, enumerate every route from the Hono router (method + path; fill params with ids of real fixture rows in the same project), skip `/api/work/*`, `/api/me`, auth and public routes, and call each. Assert 403/404, never 2xx. A second pass with a `guest` actor. The test fails with the list of offending routes.
- Health DTO exact-keys test; health rules end-to-end with seeded `service_status`/monitor rows.
- Permissions matrix per Work route: owner, admin, developer, viewer, manager, guest, custom `["work"]`, folder-scoped grant, environment-scoped grant (no Work access).
- Task number allocation under concurrency (50 parallel creates → numbers 1..50, no gaps or duplicates).
- Fractional reorder under concurrent moves (no duplicate positions in a list; the rebalance path is exercised).
- Optimistic concurrency: stale `expectedUpdatedAt` → 409 with the current task.
- Filter SQL: each `FilterKey` × op against a fixture project, compared with `matchesTask` over the same data (the two implementations must agree; a property-style test with random filters, seeded).
- Attachments: magic-byte sniffing, SVG served as download with CSP, EXIF stripped, quota exceeded, dedup refCount, GC.
- Realtime: a mutation publishes one message; the socket of an actor without access receives nothing.
- Recurrence: double completion → one next occurrence; `on_schedule` tick idempotent across two workers.
- Git links (phase 4): provider fixtures, redelivery idempotency, close only on the default branch, visibility by `read`.
- Import (phase 4): the replay server test (12.5).

### 17.3 Web

Component tests for `FieldEditor` kinds, `parseHumanDate`, the filter builder; Playwright-style flows through the existing screenshot harness on the mock: create task, drag on board with the keyboard, resize on timeline, comment with mention, PM shell navigation with no ops links.

### 17.4 Performance

A seed script `bun run work:seed --tasks 50000` for local profiling. Targets: `GET /tasks` p95 < 120 ms for a 200-row page with fields on 50k tasks; board column page < 80 ms; search < 100 ms.

---

## 18. Docs site

New section "Tasks" in `docs-site/` (style in `docs-site/WRITING.md`, screenshots from the mock):
- Overview (what Work is, who sees what),
- Project manager and guest roles (with the permission table),
- Lists, statuses and custom fields,
- Views: table, board, timeline, calendar, and saving views,
- Task details: subtasks, checklists, dependencies, attachments, comments and mentions,
- Service health for project managers (the six states explained),
- Notifications and email (with the instance mail setup),
- Templates, recurring tasks, time tracking, share links, guests (phase 4 pages, as they ship),
- Connect commits and pull requests,
- Import from ClickUp, import/export CSV,
- API and MCP examples (`work_task_create`).

---

## 19. Phases

Each phase merges on its own, behind no flag (rule 9: no licence gating; also no feature flags unless needed for a staged rollout).

### Phase 1: foundation (a PM can run a project)

Deliverables:
- Schema migration: `work_project`, `work_key_alias`, `work_task_alias`, `work_status`, `work_list`, `work_task`, `work_task_assignee`, `work_task_watcher`, `work_comment`, `work_activity`, `work_attachment`, `work_blob`, `work_view`, `work_notification`.
- Actions `read:work`, `comment:work`, `work`, `work:admin`; built-in role changes; `manager` role; implication rule; Members UI copy.
- `/api/me` `surfaces`; Work shell; ops sidebar "Tasks"; project "Tasks" tab.
- Statuses (seeded, editable), lists, tasks CRUD with number/keys, assignees, watchers, priority, dates, estimate, description editor with inline images, comments (flat), attachments (`db` driver, thumbnails, quota), activity timeline.
- Table view (group by status, filters on status/assignee/priority/due/text, sort, inline edit of built-in columns); default shared views (List only in this phase); task sheet; My tasks; Inbox for assigned + commented.
- Health endpoint, projects grid, project overview with the services card; hidden services setting.
- Realtime; core modules `health`, `rank`, `status`, `richtext`, `mentions` (extraction only), `filter` (subset), `dates`.
- REST/OpenAPI/MCP coverage; leak test; docs pages Overview + roles + health.

Done when: a manager granted on a folder can create lists and tasks with screenshots, assign developers, comment, and see service health, while the leak test passes and a developer sees the same tasks in the project's Tasks tab.

### Phase 2: daily use, ClickUp-level

Deliverables:
- Board view (all group-bys, keyboard drag, quick add, WIP limits), saved views shared + personal, view wizard, column chooser, card fields, "Save view" diffing.
- Custom fields (all 14 kinds) with `work_field`, `work_field_value`, the field wizard, table columns, board cards, filters and sorts on fields.
- Subtasks, checklists (`work_checklist_item`), tags (`work_tag`, `work_task_tag`), comment replies and resolve, reactions, mentions with notifications, watchers UI, full Inbox kinds (except due).
- Bulk edit, ⌘K search by key/title, keyboard shortcuts and help sheet, CSV export, duplicate task, move task to another project (aliases).
- Docs: lists/statuses/fields, views, task details.

Done when: an existing ClickUp user can do their daily routine (board stand-up, triage in table, custom fields like "Client", "Budget") without going back.

### Phase 3: planning and notifications

Deliverables:
- Timeline (waterfall): dependencies (`work_dependency` with lag), drag/resize, connectors, unscheduled tray, dependant shifting with preview, working days setting, milestones.
- Calendar view (month/week, spans, drag), board swimlanes.
- Events `task.*` into notification rules; due-soon/overdue tick; notification bundling.
- Instance mail setting (also used for invitations) and personal email (instant/daily), Account → Notifications, iCal feed.
- `s3` attachment driver, migration job, blob GC.
- Docs: timeline, calendar, notifications & email.

Done when: a PM plans a 3-month launch on the timeline with dependencies, moves a phase and the dependants follow, and assignees get due reminders by email.

### Phase 4: extras

Each item is independent and ships in its own PR, in this suggested order (value for an agency first):
1. **Time tracking** (12.3): timer, entries, Time page, reports, CSV.
2. **Templates** (12.1) with the three built-ins, and the project-creation step.
3. **Recurring tasks** (12.2).
4. **Git integration** (12.4): parser extensions, links, closing keywords, release line for ops.
5. **ClickUp import** (12.5), then **CSV import** (12.6).
6. **Guests** (12.8) with `invitation_grant`, then **share links** (12.7).
7. **Reports and workload** (12.11).
8. **AI assist** (12.10).
9. **Automations integration** (12.9), once automations phase 1 has landed.

Done when: each item's tests in section 17 pass and its docs page is published.

---

## 20. Not doing (and why)

- **Spaces/workspaces above folders, list folders**: folders (two levels) already group projects; a third container adds navigation without new power.
- **Per-list statuses**: statuses are per project. If clients need it, `work_status.listId null` can be added later, additively.
- **Docs/wiki, chat, whiteboards, goals/OKRs**: separate products; descriptions + comments cover the task-level need.
- **Sprints and story points as first-class objects**: a select field "Sprint" plus a saved board view covers it. Revisit if a team asks for velocity charts.
- **Real-time co-editing**: last-write-wins with conflict detection (section 9). Co-editing needs Yjs plus a sync server, out of proportion for task descriptions.
- **Cross-project dependencies and tasks in several lists**: they complicate permissions (a task visible through two projects) and the timeline. Not worth it now.
- **Critical path highlighting**: `topoOrder` makes it cheap to add later; not requested.
- **Invoicing and hourly rates**: time tracking exports CSV with a billable flag; billing stays in the accounting tool.
- **Email-in (reply to a notification to comment)**: needs inbound mail handling. Later, if instance mail proves popular.
- **Mobile apps**: the Work shell is responsive. No native app.

## 21. Risks

| Risk | Mitigation |
|---|---|
| Ops data leaks to managers/guests | no `read` in the roles; dedicated DTOs; exact-keys health test; router-walking leak test (17.2) |
| Attachment XSS or malware distribution | sniffed types, SVG/HTML never inline, CSP + sandbox on responses, `nosniff`, no public URLs except share links with the same headers |
| DB bloat with the `db` driver | per-file cap, org quota with usage shown in Settings, S3 driver + migration job in phase 3 |
| Timeline complexity and bugs | all maths in `timeline.ts`, `deps.ts`, `dates.ts` with tests; React only renders geometry |
| Built-in role change surprises (developers/viewers gain Work access) | intended; changelog entry; custom roles unaffected |
| Notification noise | bundling, conservative defaults (status changes only into/out of done), per-kind toggles |
| ClickUp API changes or rate limits | mapping isolated in core with fixtures; replay-server tests; resumable idempotent import |
| Webhook handler gets slower for deploys | git-link work runs after the deploy response is decided, in a `queueMicrotask`/background job, never blocking or failing the webhook |
| Search performance on large orgs | `simple` tsvector with GIN; title prefix index; 20-result cap; perf seed |

## 22. Open questions (with the default the plan assumes)

1. **UI naming**: "Tasks" in the ops sidebar, "Projects" as the Work-shell landing, role "Project manager". OK?
2. **Viewer**: the plan gives viewers `comment:work` (they can comment, not edit). Alternative: read-only.
3. **Instance mail**: the plan adds an instance-level mail setting (14.3), also used for invitations. Alternative: pick an org email channel as sender.
4. **Guests**: the plan includes guests (12.8) in phase 4 with project-scoped invitations. Should they move to phase 2 if clients are a priority?
5. **Health scope**: only the default environment counts. Should staging show too, as a separate row?
6. **Time tracking defaults**: on for every project, billable by default. For an agency, OK?

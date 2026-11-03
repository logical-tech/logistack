# Database explorer plan

LogiStack users today open a separate client to query, browse, dump or restore a managed database. This program adds a Database tab to every database service. It has a schema tree, an editable data grid, a SQL editor with typed results, and on-demand dump and restore. It is our own code, because Drizzle Studio and Drizzle Gateway are proprietary. The rule the program enforces is that every database operation goes through a typed adapter with bound parameters, a permission check and an audit entry. The PRs are DBX-1, DBX-2, DBX-3, DBX-4, DBX-5, DBX-6, DBX-7, DBX-8, in that order.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `skills/poteto-mode/playbooks/autopilot-stack.md` from the installed plugin. The operator merges. Every PR stops at stack-ready, and the operator lands the stack bottom-up.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] On the operator's go, write this exact text into the standing orders and restate it in your todolist. "Plan docs/plans/db-explorer.md. PRs DBX-1, DBX-2, DBX-3, DBX-4, DBX-5, DBX-6, DBX-7, DBX-8 in order. Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. The operator merges. Done when every PR is stack-ready with a clean verdict."
- [ ] Read these from the installed plugin at program start. Re-read them at every tick.
  - [ ] `skills/poteto-mode/playbooks/autopilot-stack.md`
  - [ ] `skills/swarm/SKILL.md`
  - [ ] `run` (bundled with Claude Code; the repo has no `.claude/skills/verify`)
  - [ ] `skills/poteto-mode/playbooks/opening-a-pr.md`
  - [ ] `skills/how/SKILL.md`
  - [ ] `skills/interrogate/SKILL.md`
- [ ] Arm the hourly audit tick as a real `/loop` in dynamic mode, which schedules its own wake-up rather than blocking on a sleep. Never leave the cadence to memory.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from the installed plugin and the standing objective. Audit the operation against both and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names.
- [ ] Follow this dependency graph. Start dependent work only after its parent merges, or base it on the parent branch when the execution playbook stacks.
  - [ ] DBX-1 is first and branches from `main`.
  - [ ] DBX-2 after DBX-1. DBX-3 after DBX-2. DBX-4 after DBX-3.
  - [ ] DBX-5 after DBX-3, independent of DBX-4.
  - [ ] DBX-6, DBX-7 and DBX-8 after DBX-4, independent of each other.
- [ ] Hold the file boundaries. DBX-6 touches only `packages/providers/src/db/mysql.ts` plus the shared files it lists. DBX-7 only the Mongo files. DBX-8 only the Redis files. Shared edits to `database.tsx` and `databases.test.ts` rebase in stack order.
- [ ] Hold the review gate. DBX-3, DBX-4, DBX-5, DBX-6, DBX-7 and DBX-8 change an interaction. They wait for the operator's review in chat with screenshots and a video before merge.

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`; if `command -v origin` succeeds and Origin can resolve the repository, use `origin pr` for every PR operation. Record any fallback to `gh`. Never require `gt`. Use the `logical-tech` account over the `github-logical` SSH host only.
- [ ] Open the PR ready, never draft, per **Opening a PR**. Use the run's built-in PR tool when it has one, else `origin pr create --status open --base <base-branch>` or `gh pr create --base <base-branch>` according to the resolved forge. A stack child targets its parent branch.
- [ ] Run the repo's lint and typecheck once before the PR-facing push. Push with hooks on. The commands are `bun run typecheck` and `bunx biome check`.
- [ ] Run `/deslop` before each commit and `/no-comments` before review. Commits use `info@logicaltech.it` and carry no AI attribution line.
- [ ] Triage every review-bot and security-reviewer comment per `../references/bugbot-triage.md`.
- [ ] Before the code-ready report and babysit, and again after merge prep, record the base and head SHAs prepared by the topology owner under the execution playbook.

### Verdict and merge, for every PR

- [ ] At the code-ready head SHA and at each later push that changes the patch, run the swarm per `skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the PR body. The root audits the receipts in the merge-ready report before the verdict.
- [ ] Clean only when every lane is `PASS`. Findings go back to the owner, including a defect that a lane filed as a note. A new head gets a fresh swarm and a fresh verdict, except for results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] A clean verdict appends the PR to the one linear stack on `main`. No owner merges. The operator lands bottom-up, and the patch-id rule in `playbooks/shipping.md` decides which verdicts survive a rebase.

### Boot recipe, for every live lane

Each live lane runs in its own worktree at the PR head. Drive through the skill path or exact commands recorded in this boot recipe.

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] Run `bun install`, `cp .env.example .env`, `bun run dev:infra`, then `bun run dev` in `apps/server`, `apps/worker` and `apps/web`. Wait until the web dev server answers on its port and `/api/health` returns 200. Lane test databases are Swarm services named `ls-test-dbx-<lane>-*` with label `logistack.test=dbx`, removed by that exact prefix only.
- [ ] Deliver input only through the `run` skill's browser driver and `curl` against the api. Read-only diagnostics are `docker service inspect`, `docker service logs` and the audit log page.
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report.

## Reach database services from the api over a shared ls-db network (DBX-1)

**Depends on.** None.

**Files.**

- [ ] Edit `install/stack.yml`.
- [ ] Edit `docker-compose.dev.yml`.
- [ ] Edit `packages/core/src/compile-service.ts`.
- [ ] Edit `packages/core/test/compile-service.test.ts` and its snapshots.
- [ ] Edit `apps/worker/src/env.ts`.
- [ ] Create `packages/providers/src/db/index.ts`.
- [ ] Create `packages/providers/src/db/postgres.ts`.
- [ ] Create `apps/server/src/database.ts`.
- [ ] Create `apps/server/src/routes/databases.ts`.
- [ ] Edit `apps/server/src/app.ts`.
- [ ] Edit `apps/server/src/env.ts`.
- [ ] Create `apps/server/test/databases.test.ts`.

**Build.**

- [ ] Declare an attachable overlay `ls-db` in `install/stack.yml` and put the api and worker on it, next to `ls-storage`.
- [ ] In `compileService`, attach every `kind: database` service to the network named by `LS_DB_NETWORK`, with no alias. Apps never join it. The worker skips the network when it does not exist, as on dev machines and in test harnesses.
- [ ] Add the `postgres` dependency to `packages/providers` and define `DatabaseClient` in `packages/providers/src/db/index.ts` with `introspect()` and `close()`. Later PRs add `rows()`, `mutate()` and `query()` when they need them. Implement the Postgres adapter in `postgres.ts` on postgres.js, because it returns column names and types for empty and duplicate-named results.
- [ ] Add `openDatabase(c, id)` in `apps/server/src/database.ts`, modeled on `openStorage`. It loads the row, rejects non-database kinds, decrypts the engine env keys listed in `compile-service.ts:83-130`, dials `ls-svc-<shortid>` on the engine default port through `deps.databaseEndpoint ?? default`, and caches one pool per service, keyed by a hash of the credentials. The pool closes idle connections after five minutes on its own.
- [ ] Add `GET /databases/{id}/schema` (permission `read`) returning schemas, tables, views, columns, primary keys and approximate row counts. An unreachable service returns 409 with `details.reason` `unreachable` and the hint that a redeploy attaches the network.

**You see.**

- [ ] `docker service inspect ls-svc-<id>` on a redeployed database lists `ls-db` among its networks.
- [ ] `curl /api/databases/<id>/schema` returns the `public` schema with its tables and columns.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/core/test/compile-service.test.ts` gains a case asserting a database spec joins `ls-db` and an application spec does not. Run `bun test packages/core`.
- [ ] `apps/server/test/databases.test.ts` starts `ls-test-dbx-<uuid8>-target` (postgres:18-alpine, label `logistack.test=dbx`), points `databaseEndpoint` at it, and asserts the schema payload for a seeded table, the 409 on an unreachable host, and the 403 for a member without `read`. Run `bun test apps/server/test/databases.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `curl /api/databases/<id>/schema` against a seeded Postgres service at trunk and head. Trunk lacks the feature, so record that and gate the schema response plus a 200 status. Save `regression.png`. Pass when trunk shows no Database tab and head reaches the end state with no console error.
- [ ] Lane 2. Deploy a fresh Postgres service and inspect its Swarm networks. Save `networks.png`. Pass when `ls-db` is listed and the environment network is still listed.
- [ ] Lane 3. Deploy an application service and inspect its networks. Save `app-networks.png`. Pass when `ls-db` is absent.
- [ ] Lane 4. Call the schema route for an existing database that has not been redeployed. Save `unreachable.png`. Pass when the response is 409 `database_unreachable` with the redeploy hint.
- [ ] Lane 5. Redeploy that database, then call the schema route again. Save `after-redeploy.png`. Pass when the response is 200 with its tables.
- [ ] Lane 6. Call the schema route as a member with no role on the project. Save `forbidden.png`. Pass when the response is 403.
- [ ] Lane 7. Call the schema route with a storage service id. Save `wrong-kind.png`. Pass when the response is 404 or 400 and never dials anything.
- [ ] Lane 8. Rotate POSTGRES_PASSWORD in the env tab, redeploy, call the schema route. Save `rotated.png`. Pass when the response is 200, proving the pool cache key follows the credentials.
- [ ] Lane 9. Call the schema route through the MCP endpoint as a tool. Save `mcp.png`. Pass when the tool is listed and returns the same payload.
- [ ] Lane 10. Leave the api idle for six minutes, then call again. Save `idle.png`. Pass when the pool reopens and the response is 200.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Schema route latency on a database with 200 tables. Trunk lacks the route, so the diff-added work is the introspection query and the end state is the JSON response.
- [ ] Probe. `hey -n 50 -c 5 /api/databases/<id>/schema` at head, after one warm-up call. At trunk record that the route returns 404.
- [ ] Baseline. Record the trunk value first. trunk returns 404 for the route, so the budget below is absolute.
- [ ] Rule. p95 under 250 ms warm and under 1 s cold. A p95 above either fails.

**Review gate.** None. DBX-1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Page, sort, filter and edit table rows through the api (DBX-2)

**Depends on.** DBX-1.

**Files.**

- [ ] Edit `packages/providers/src/db/index.ts`.
- [ ] Edit `packages/providers/src/db/postgres.ts`.
- [ ] Edit `apps/server/src/routes/databases.ts`.
- [ ] Create `packages/contracts/src/database.ts`.
- [ ] Edit `packages/contracts/src/index.ts`.
- [ ] Edit `apps/server/test/databases.test.ts`.

**Build.**

- [ ] Define the zod contracts in `packages/contracts/src/database.ts`. They are `TableRef`, `RowsQuery` (limit up to 500, keyset cursor or offset, sort list, filter list of column, operator and value), `RowPatch` keyed by the primary key, and the `Cell` value encoding (JSON-safe, bigint and bytea as tagged strings).
- [ ] Add `GET /databases/{id}/tables/{schema}/{table}/rows` (permission `read`). Identifiers are quoted through postgres.js `sql(name)`, never interpolated. Every value is a bound parameter.
- [ ] Add `POST /databases/{id}/tables/{schema}/{table}/rows` with insert, update and delete operations wrapped in `mutation("database.rows_write")` (permission `write`). Updates and deletes require a primary key and run in one transaction that fails when the affected row count differs from the request.
- [ ] Tables and views without a primary key return `editable: false` in the schema payload, and the write route rejects them with 400.

**You see.**

- [ ] Reading 100 rows sorted by a column returns a `nextCursor` and stable ordering across pages.
- [ ] An update whose primary key no longer exists returns 409 and changes nothing.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `apps/server/test/databases.test.ts` gains cases for paging across three pages, a filter with a quote and a semicolon in the value, a table named `select`, an insert, an update, a delete, the 409 on a stale key and the 400 on a table without a primary key. Run `bun test apps/server/test/databases.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run a read of the first page of a seeded `orders` table at trunk and head. Trunk lacks the feature, so record that and gate rows sorted by `id` with a cursor. Save `regression.png`. Pass when trunk shows no Database tab and head reaches the end state with no console error.
- [ ] Lane 2. Page through a 10 000 row table with the cursor until the end. Save `paging.png`. Pass when every id appears exactly once.
- [ ] Lane 3. Filter `name contains O'Brien; drop table x`. Save `injection.png`. Pass when the filter matches literally and table `x` still exists.
- [ ] Lane 4. Sort by two columns, one descending. Save `sort.png`. Pass when the order matches `psql` with the same ORDER BY.
- [ ] Lane 5. Update one cell and read it back. Save `update.png`. Pass when the new value is returned and the audit log has `database.rows_write`.
- [ ] Lane 6. Delete a row twice in a row. Save `stale-delete.png`. Pass when the second call returns 409.
- [ ] Lane 7. Write to a view. Save `view-write.png`. Pass when the response is 400 and the view's base table is unchanged.
- [ ] Lane 8. Write as a member with only `read`. Save `write-forbidden.png`. Pass when the response is 403.
- [ ] Lane 9. Read a table with `bytea`, `jsonb`, `numeric(30,10)` and `bigint` columns. Save `types.png`. Pass when values round-trip without precision loss.
- [ ] Lane 10. Insert a row through the MCP tool. Save `mcp-insert.png`. Pass when the row exists and the audit row names the API key actor.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time to the first page of 100 rows on a 1 000 000 row table, sorted by the primary key. Trunk lacks the route.
- [ ] Probe. `hey -n 50 -c 5` on the rows route at head, after one warm-up call. At trunk record the 404.
- [ ] Baseline. Record the trunk value first. trunk returns 404 for the route, so the budget below is absolute.
- [ ] Rule. p95 under 150 ms. A p95 above 150 ms fails, and so does any sequential scan in `EXPLAIN` for the keyset query.

**Review gate.** None. DBX-2 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Browse and edit tables from a Database tab (DBX-3)

**Depends on.** DBX-2.

**Files.**

- [ ] Edit `apps/web/src/routes/_app/projects/$projectId/services/$serviceId/route.tsx`.
- [ ] Create `apps/web/src/routes/_app/projects/$projectId/services/$serviceId/database.tsx`.
- [ ] Create `apps/web/src/components/database/schema-tree.tsx`.
- [ ] Create `apps/web/src/components/database/data-grid.tsx`.
- [ ] Create `apps/web/src/components/database/cell-editor.tsx`.
- [ ] Create `apps/web/src/lib/api/database.ts`.
- [ ] Create `apps/web/src/lib/api/mock/database.ts`.

**Build.**

- [ ] Add a `database` entry to `TABS`, shown only for `kind: database`. The route keeps schema, table, sort and filter in zod-validated search params, as the Storage tab does.
- [ ] `schema-tree.tsx` lists schemas and tables with row-count hints, keyboard navigation and a filter box.
- [ ] `data-grid.tsx` renders rows with TanStack Table and `@tanstack/react-virtual`, loads pages through `useInfiniteQuery`, and shows column type badges, null cells and a sticky primary key column.
- [ ] Edits are staged locally. A bar shows the pending count with Discard and Save, and Save sends one write request. Cells of read-only tables are not editable and say why.
- [ ] `lib/api/database.ts` follows the `StorageApi` shape with an `isMock` switch and a mock world in `mock/database.ts`.
- [ ] Before writing the UI, load the skills CLAUDE.md lists for UI work.

**You see.**

- [ ] The Database tab opens on the first table and shows its rows within a second.
- [ ] Editing two cells and pressing Save shows a toast and the grid reflects the saved values.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `apps/web/src/components/database/data-grid.test.tsx` covers staging, discarding and the read-only cell state against the mock api. Run `bun test apps/web`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run opening a Postgres service and its Database tab at trunk and head. Trunk lacks the feature, so record that and gate the tab listing tables and rendering the first page. Save `regression.png`. Pass when trunk shows no Database tab and head reaches the end state with no console error.
- [ ] Lane 2. Open a 1 000 000 row table and scroll fast to row 5 000. Save `scroll.png`. Pass when rows load progressively with no blank viewport longer than 500 ms.
- [ ] Lane 3. Edit two cells, then Discard. Save `discard.png`. Pass when the grid shows the original values and no request was sent.
- [ ] Lane 4. Edit two cells, then Save. Save `save.png`. Pass when a toast confirms and reloading the page shows the new values.
- [ ] Lane 5. Open a view. Save `view.png`. Pass when cells are not editable and a hint says the view has no primary key.
- [ ] Lane 6. Navigate the schema tree with only the keyboard and open a table. Save `keyboard.png`. Pass when focus is visible at every step and Enter opens the table.
- [ ] Lane 7. Sort by a column header and add a filter. Save `sort-filter.png`. Pass when the URL carries both and a reload restores them.
- [ ] Lane 8. Open the tab in dark theme. Save `dark.png`. Pass when contrast of type badges and null cells meets WCAG AA.
- [ ] Lane 9. Open the tab at 375 px wide. Save `mobile.png`. Pass when the tree collapses into a sheet and the grid scrolls horizontally without page overflow.
- [ ] Lane 10. Open the tab on a database that has not been redeployed. Save `unreachable.png`. Pass when an empty state explains the redeploy and offers the Redeploy action.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from clicking the Database tab to the first painted row on a 1 000 000 row table. Trunk lacks the tab, so the end state is the first painted row.
- [ ] Probe. Chrome performance trace through the driver skill, five runs at head, warm cache. At trunk record that the tab is absent.
- [ ] Baseline. Record the trunk value first. trunk has no Database tab, so the budget below is absolute.
- [ ] Rule. median under 800 ms and no long task above 200 ms during scroll. Either one exceeded fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1 to 4 screenshots into `docs/media/dbx-3-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `docs/media/dbx-3-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Run SQL from an editor with typed results (DBX-4)

**Depends on.** DBX-3.

**Files.**

- [ ] Edit `apps/web/package.json` to add `@codemirror/lang-sql`.
- [ ] Create `apps/web/src/components/database/sql-editor.tsx`.
- [ ] Create `apps/web/src/components/database/result-table.tsx`.
- [ ] Edit `apps/web/src/routes/_app/projects/$projectId/services/$serviceId/database.tsx`.
- [ ] Edit `apps/server/src/routes/databases.ts`.
- [ ] Edit `packages/providers/src/db/postgres.ts`.
- [ ] Edit `apps/server/test/databases.test.ts`.

**Build.**

- [ ] Add `POST /databases/{id}/query` returning, per statement, the column list with names and types, up to 1 000 rows, a `truncated` flag, the command tag, the affected count and the duration.
- [ ] A `readOnly: true` request needs `read` and runs inside `BEGIN READ ONLY`. A write request needs `write` and goes through `mutation("database.query")`, which stores the statement text in the audit diff.
- [ ] Every query runs with `statement_timeout` of 30 s and can be cancelled with `DELETE /databases/{id}/query/{runId}`, which calls `pg_cancel_backend`.
- [ ] The editor reuses the CodeMirror setup of `ScriptEditor` with `lang-sql` and completion from the schema payload. Cmd+Enter runs the statement under the cursor and Shift+Cmd+Enter runs all. A Read only toggle defaults on.
- [ ] Results render in `result-table.tsx` with a tab per statement, CSV and JSON copy, and the error position highlighted in the editor.

**You see.**

- [ ] `select 1 as a, 'x' as a where false` shows two `a` columns with types `int4` and `text` and zero rows.
- [ ] `update` with Read only on fails with `cannot execute UPDATE in a read-only transaction`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `apps/server/test/databases.test.ts` gains cases for empty and duplicate-named results, the read-only rejection, the 1 000 row truncation, the 30 s timeout with `pg_sleep(31)` and cancellation. Run `bun test apps/server/test/databases.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run running `select * from orders limit 10` in the editor at trunk and head. Trunk lacks the feature, so record that and gate the result table with ten rows and typed headers. Save `regression.png`. Pass when trunk shows no Database tab and head reaches the end state with no console error.
- [ ] Lane 2. Run `select 1 as a, 'x' as a where false`. Save `empty-dup.png`. Pass when two headers named `a` show with zero rows.
- [ ] Lane 3. With Read only on, run an `update`. Save `readonly.png`. Pass when the error shows and the row is unchanged.
- [ ] Lane 4. Turn Read only off as a member with only `read`. Save `toggle-forbidden.png`. Pass when the toggle is disabled with a reason.
- [ ] Lane 5. Run `select pg_sleep(60)` and press Cancel. Save `cancel.png`. Pass when the query stops within two seconds and the editor is usable.
- [ ] Lane 6. Run three statements with Shift+Cmd+Enter. Save `multi.png`. Pass when three result tabs show with their command tags.
- [ ] Lane 7. Run a query with a syntax error. Save `syntax.png`. Pass when the error position is underlined in the editor.
- [ ] Lane 8. Run `select generate_series(1, 50000)`. Save `truncated.png`. Pass when 1 000 rows show with a truncated notice.
- [ ] Lane 9. Type `sel` then a table prefix. Save `complete.png`. Pass when completion offers keywords and the table names.
- [ ] Lane 10. Run a write and open the audit log. Save `audit.png`. Pass when the entry is `database.query` with the statement text.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Round trip of `select 1` from Cmd+Enter to the painted result. Trunk lacks the editor.
- [ ] Probe. Twenty runs through the driver skill at head with timestamps from the network panel. At trunk record that the editor is absent.
- [ ] Baseline. Record the trunk value first. trunk has no SQL editor, so the budget below is absolute.
- [ ] Rule. median under 120 ms on the dev machine. A median above 120 ms fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1 to 4 screenshots into `docs/media/dbx-4-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `docs/media/dbx-4-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Dump and restore a database on demand (DBX-5)

**Depends on.** DBX-3.

**Files.**

- [ ] Create `packages/core/src/db-scripts.ts` by moving `dumpScript` and `restoreScript` out of `apps/worker/src/backup-scripts.ts`.
- [ ] Edit `apps/worker/src/backup-scripts.ts` and `apps/worker/src/backups.ts` to import them.
- [ ] Edit `apps/server/src/routes/databases.ts`.
- [ ] Create `apps/web/src/components/database/dump-restore.tsx`.
- [ ] Edit `apps/server/test/databases.test.ts`.

**Build.**

- [ ] Move the dump and restore scripts into `packages/core` so the worker and the api share one source. The worker keeps its behavior.
- [ ] Add `GET /databases/{id}/dump` (permission `read:secrets`) that locates the task like `locateTask`, runs `dumpScript` through `deps.nodes.exec`, and streams stdout as an attachment named `<slug>-<timestamp>.<ext>`.
- [ ] Add `POST /databases/{id}/restore` (permission `admin`, through `mutation("database.restore")`) that pipes the request body into `restoreScript` over exec stdin. The MCP layer then requires `confirm: true` because the verb is restore.
- [ ] The UI offers Download dump and Restore from file. Restore opens a confirm dialog that asks for the service name and states that existing data is replaced.

**You see.**

- [ ] Download dump on a 1 GB database starts the download within two seconds and never buffers in the api.
- [ ] Restore of that file into a fresh service reproduces the row counts.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `apps/worker/test/backups.integration.test.ts` still passes after the move. Run `bun test apps/worker/test/backups.integration.test.ts`.
- [ ] `apps/server/test/databases.test.ts` gains a dump then restore round trip against the exec fake used by the backups tests. Run `bun test apps/server/test/databases.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run Download dump on the seeded Postgres service at trunk and head. Trunk lacks the feature, so record that and gate a downloaded file that `pg_restore -l` lists. Save `regression.png`. Pass when trunk shows no Database tab and head reaches the end state with no console error.
- [ ] Lane 2. Restore that dump into a second empty Postgres service. Save `restore.png`. Pass when row counts match the source.
- [ ] Lane 3. Cancel the Restore dialog without typing the name. Save `restore-cancel.png`. Pass when no request is sent.
- [ ] Lane 4. Download dump as a member without `read:secrets`. Save `dump-forbidden.png`. Pass when the button is hidden and the route returns 403.
- [ ] Lane 5. Restore a truncated file. Save `restore-corrupt.png`. Pass when an error shows with the tool's stderr and the service stays up.
- [ ] Lane 6. Download a 1 GB dump while watching api memory. Save `memory.png`. Pass when api RSS grows by less than 64 MB.
- [ ] Lane 7. Run a scheduled backup after the move. Save `backup.png`. Pass when the run succeeds and its file restores.
- [ ] Lane 8. Call restore through MCP without `confirm`. Save `mcp-confirm.png`. Pass when the tool refuses.
- [ ] Lane 9. Dump a Redis service. Save `redis.png`. Pass when the dump downloads an RDB file and Restore is hidden with a reason.
- [ ] Lane 10. Open the audit log after a restore. Save `audit.png`. Pass when the entry is `database.restore` with the file size.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Dump throughput and api memory for a 1 GB Postgres database. Trunk has dumps only through scheduled backups, so compare the dump step duration of a backup run at trunk with the download at head.
- [ ] Probe. At trunk, run a manual backup and read the dump step duration. At head, time `curl -o /dev/null` on the dump route. Interleave three runs each.
- [ ] Baseline. Record the trunk value first. Record the trunk dump step median first.
- [ ] Rule. head median within 1.3 times trunk and api RSS growth under 64 MB. Either one exceeded fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1 to 4 screenshots into `docs/media/dbx-5-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `docs/media/dbx-5-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Support MySQL and MariaDB in the explorer (DBX-6)

**Depends on.** DBX-4.

**Files.**

- [ ] Edit `packages/providers/package.json` to add `mysql2`.
- [ ] Create `packages/providers/src/db/mysql.ts`.
- [ ] Edit `packages/providers/src/db/index.ts`.
- [ ] Edit `apps/server/src/database.ts`.
- [ ] Edit `apps/server/test/databases.test.ts`.

**Build.**

- [ ] Implement `DbAdapter` for MySQL and MariaDB on `mysql2`, which returns field metadata for empty results. Bun's SQL client returns no column metadata, as the prototype showed.
- [ ] Read-only queries run in `START TRANSACTION READ ONLY`. The timeout uses `max_execution_time` on MySQL and `max_statement_time` on MariaDB. Cancel uses `KILL QUERY`.
- [ ] Identifiers quote with backticks through `mysql2`'s `escapeId`.

**You see.**

- [ ] A MySQL 8.4 service opens in the Database tab with its schemas as top-level nodes.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `apps/server/test/databases.test.ts` runs the shared adapter cases against `ls-test-dbx-<uuid8>-mysql` (mysql:8.4) and `-mariadb` (mariadb:11). Run `bun test apps/server/test/databases.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run opening the Database tab of a MySQL 8.4 service at trunk and head. Trunk lacks the feature, so record that and gate the schema tree and the first page of a table. Save `regression.png`. Pass when trunk shows no Database tab and head reaches the end state with no console error.
- [ ] Lane 2. Repeat on MariaDB 11. Save `mariadb.png`. Pass when the same end state.
- [ ] Lane 3. Edit and save a cell on MySQL. Save `mysql-edit.png`. Pass when the value persists.
- [ ] Lane 4. Run `select 1 as a where false` on MySQL. Save `mysql-empty.png`. Pass when the header shows with zero rows.
- [ ] Lane 5. Run an update with Read only on. Save `mysql-readonly.png`. Pass when the error shows and nothing changes.
- [ ] Lane 6. Run `select sleep(60)` and Cancel. Save `mysql-cancel.png`. Pass when the query stops within two seconds.
- [ ] Lane 7. Filter with a backtick and a quote in the value. Save `mysql-injection.png`. Pass when the filter matches literally.
- [ ] Lane 8. Read `decimal(30,10)`, `json`, `blob`, `datetime(6)` columns. Save `mysql-types.png`. Pass when values round-trip.
- [ ] Lane 9. Dump and restore a MariaDB service. Save `mariadb-dump.png`. Pass when row counts match.
- [ ] Lane 10. Open a table without a primary key. Save `mysql-readonly-table.png`. Pass when cells are not editable with the reason.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time to the first page of 100 rows on a 1 000 000 row MySQL table. Trunk lacks the route.
- [ ] Probe. `hey -n 50 -c 5` on the rows route at head. At trunk record the 404.
- [ ] Baseline. Record the trunk value first. trunk returns 404, so the budget below is absolute.
- [ ] Rule. p95 under 150 ms. A p95 above it fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1 to 4 screenshots into `docs/media/dbx-6-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `docs/media/dbx-6-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Browse Mongo collections as JSON documents (DBX-7)

**Depends on.** DBX-4.

**Files.**

- [ ] Edit `packages/providers/package.json` to add `mongodb`.
- [ ] Create `packages/providers/src/db/mongo.ts`.
- [ ] Create `apps/web/src/components/database/document-list.tsx`.
- [ ] Edit `apps/web/src/routes/_app/projects/$projectId/services/$serviceId/database.tsx`.
- [ ] Edit `apps/server/test/databases.test.ts`.

**Build.**

- [ ] Implement the Mongo adapter. `introspect()` lists databases and collections with estimated counts and sampled fields. `rows()` pages by `_id`. `mutate()` replaces or deletes one document by `_id`. `query()` accepts a filter and projection as Extended JSON, not shell code.
- [ ] `document-list.tsx` shows documents as collapsible JSON with an edit mode that validates Extended JSON before saving.

**You see.**

- [ ] A Mongo service opens with its databases and collections and pages through documents.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `apps/server/test/databases.test.ts` runs the adapter cases against `ls-test-dbx-<uuid8>-mongo` (mongo:8). Run `bun test apps/server/test/databases.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run opening the Database tab of a Mongo service at trunk and head. Trunk lacks the feature, so record that and gate the collection list and the first page of documents. Save `regression.png`. Pass when trunk shows no Database tab and head reaches the end state with no console error.
- [ ] Lane 2. Page through 10 000 documents. Save `mongo-paging.png`. Pass when every `_id` appears once.
- [ ] Lane 3. Edit a document with an `ObjectId` and a `Date` field. Save `mongo-edit.png`. Pass when types survive the round trip.
- [ ] Lane 4. Save invalid JSON. Save `mongo-invalid.png`. Pass when an inline error shows and nothing is sent.
- [ ] Lane 5. Run a filter `{"$where": "sleep(1)"}`. Save `mongo-where.png`. Pass when the api rejects `$where` with 400.
- [ ] Lane 6. Delete a document twice. Save `mongo-stale.png`. Pass when the second call returns 409.
- [ ] Lane 7. Edit as a member with only `read`. Save `mongo-forbidden.png`. Pass when edit controls are hidden and the route returns 403.
- [ ] Lane 8. Dump and restore the service. Save `mongo-dump.png`. Pass when document counts match.
- [ ] Lane 9. Open at 375 px wide. Save `mongo-mobile.png`. Pass when documents wrap with no page overflow.
- [ ] Lane 10. Open in dark theme. Save `mongo-dark.png`. Pass when JSON syntax colors meet WCAG AA.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time to the first page of 50 documents in a 1 000 000 document collection. Trunk lacks the route.
- [ ] Probe. `hey -n 50 -c 5` on the rows route at head. At trunk record the 404.
- [ ] Baseline. Record the trunk value first. trunk returns 404, so the budget below is absolute.
- [ ] Rule. p95 under 200 ms. A p95 above it fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1 to 4 screenshots into `docs/media/dbx-7-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `docs/media/dbx-7-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Browse Redis keys by pattern and type (DBX-8)

**Depends on.** DBX-4.

**Files.**

- [ ] Create `packages/providers/src/db/redis.ts`.
- [ ] Create `apps/web/src/components/database/key-browser.tsx`.
- [ ] Edit `apps/web/src/routes/_app/projects/$projectId/services/$serviceId/database.tsx`.
- [ ] Edit `apps/server/test/databases.test.ts`.

**Build.**

- [ ] Implement the Redis adapter on Bun's `RedisClient`. `introspect()` returns the logical databases with key counts. `rows()` walks `SCAN` with a `MATCH` pattern, never `KEYS`. Each key carries type, TTL and memory usage.
- [ ] Values render per type, covering string, hash, list, set, sorted set and stream, each paged with its own scan command. Edits cover set string, hash field set and delete, TTL change and key delete.
- [ ] `query()` accepts one command as an argv array from an allowlist. `FLUSHALL`, `FLUSHDB`, `CONFIG`, `DEBUG`, `SHUTDOWN` and `MONITOR` are rejected.

**You see.**

- [ ] A Redis service opens with a key list filtered by `session:*`, and each key shows its type and TTL.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `apps/server/test/databases.test.ts` runs the adapter cases against `ls-test-dbx-<uuid8>-redis` (redis:7-alpine), including the command denylist. Run `bun test apps/server/test/databases.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run opening the Database tab of a Redis service at trunk and head. Trunk lacks the feature, so record that and gate the key list with types and TTLs. Save `regression.png`. Pass when trunk shows no Database tab and head reaches the end state with no console error.
- [ ] Lane 2. Filter by `user:*` on 1 000 000 keys. Save `redis-scan.png`. Pass when results stream in pages and Redis `SLOWLOG` shows no `KEYS` call.
- [ ] Lane 3. Open a hash with 10 000 fields. Save `redis-hash.png`. Pass when fields page through `HSCAN`.
- [ ] Lane 4. Change a key TTL. Save `redis-ttl.png`. Pass when `TTL` reports the new value.
- [ ] Lane 5. Run `FLUSHALL` from the command box. Save `redis-flush.png`. Pass when the api rejects it with 400 and keys remain.
- [ ] Lane 6. Open a stream. Save `redis-stream.png`. Pass when entries show with ids and fields.
- [ ] Lane 7. Delete a key as a member with only `read`. Save `redis-forbidden.png`. Pass when the route returns 403.
- [ ] Lane 8. Download a dump. Save `redis-dump.png`. Pass when an RDB file downloads.
- [ ] Lane 9. Switch logical database to 3. Save `redis-db.png`. Pass when only keys of db 3 show.
- [ ] Lane 10. Open in dark theme at 375 px. Save `redis-mobile.png`. Pass when no overflow and AA contrast.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time to the first 100 keys for `MATCH user:*` on 1 000 000 keys. Trunk lacks the route.
- [ ] Probe. `hey -n 30 -c 3` on the rows route at head. At trunk record the 404.
- [ ] Baseline. Record the trunk value first. trunk returns 404, so the budget below is absolute.
- [ ] Rule. p95 under 300 ms and Redis CPU under 50 percent during the probe. Either one exceeded fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1 to 4 screenshots into `docs/media/dbx-8-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `docs/media/dbx-8-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

The question was which Postgres and MySQL client returns column metadata for arbitrary SQL. The prototype ran on 2026-11-03 against throwaway containers `ls-test-dbx-pg` (postgres:18-alpine) and `ls-test-dbx-my` (mysql:8.4), both removed afterwards. It ran from the scratchpad, so it left no branch or SHA.

- postgres.js 3.4.9 returned `columns` with name and type OID for `select 1 as a, 'x' as a, now() as t where 1=0`. It kept both duplicate `a` columns and the header of an empty result. This decided the Postgres adapter.
- Bun 1.4 `SQL` on Postgres returned row objects only. Empty results had no header and duplicate names collapsed into one key.
- Bun 1.4 `SQL` on MySQL 8.4 failed with the RSA public key retrieval error until `allowPublicKeyRetrieval: true`, then returned row objects with no column metadata. This decided `mysql2` for DBX-6.

Unproven so far. Mongo and Redis adapters were not prototyped. The restart cost of attaching `ls-db` to an existing database was not measured. The 1 000 000 row grid budgets are estimates until DBX-2 and DBX-3 measure them.

## Appendix B. Alternatives rejected

- Embedding Drizzle Gateway or Drizzle Studio. Both are proprietary. Gateway is licensed per database through Drizzle's licensing server.
- Embedding CloudBeaver, pgweb or Adminer as a sidecar. The UI would not match LogiStack, permissions and audit would sit outside our model, and each install would run another container.
- Proxying every query through `deps.nodes.exec` running `psql` inside the task. Credentials would stay in the container, but results would arrive as text, so typed columns, cancellation and paging would need a parser per engine and a process per query.
- Attaching the api to each environment network. A Swarm service network change restarts the api, and the api would sit on networks that also carry user apps.
- Bun's built-in `SQL` client. It drops column metadata, as Appendix A shows.

## Appendix C. Risks

- DBX-1. Adding `ls-db` to a database spec changes the spec, so the reconciler restarts that database. The owner applies the network only on the next deploy the user triggers, and the tab says a redeploy is needed. Existing databases never restart on their own.
- DBX-1. Databases of every org share `ls-db`, so one database container could reach another. The owner checks that engines require passwords (the compiler already enforces the env keys) and records it. A per-org network is a follow-up if this is not acceptable.
- DBX-2 and DBX-4. SQL injection through identifiers or filters. The owner quotes identifiers through the driver and binds every value, and lane 3 of DBX-2 tests it.
- DBX-4. A long or heavy query from the editor can load a production database. The 30 s timeout, the 1 000 row cap, Read only by default and cancel bound it.
- DBX-4. The query route is exposed as an MCP tool. Read-only runs need `read`, writes need `write` and are audited with the statement text.
- DBX-5. A restore replaces data. It needs `admin`, a typed confirmation in the UI and `confirm: true` over MCP.
- DBX-5. Dumps stream through the api. Lane 6 bounds api memory.
- DBX-8. Redis commands can be destructive. The command box takes argv from an allowlist only.

## Appendix D. Links and reading list

- `docs/PIANO.md` for the platform rules, and `CLAUDE.md` for the non-negotiables and the UI skills.
- `apps/server/src/storage.ts` and `apps/server/src/routes/storage.ts` as the pattern for `openDatabase` and the routes.
- `apps/worker/src/backups.ts` and `apps/worker/src/backup-scripts.ts` for exec streaming and the dump scripts.
- `apps/web/src/components/storage/object-browser.tsx` and `apps/web/src/components/backups/script-editor.tsx` for the UI patterns.
- DBX-1 and DBX-4 get `skills/how/SKILL.md` before code and `skills/interrogate/SKILL.md` before the PR opens, because they set the network boundary and the query surface.
- Each owner keeps a `decisions.tsv` trail per `skills/show-me-your-work/SKILL.md`.

# LogiStack

Self-hosted PaaS (Dokploy/Coolify alternative). Full design and rationale: `docs/PIANO.md` (Italian). Code, identifiers and comments in English; UI copy in English.

Private repo `logical-tech/logistack` (SSH host `github-logical`). Never copy code from Dokploy or Coolify; ideas only.

## Layout

- `apps/server` Hono API (REST + OpenAPI + WebSocket + MCP), serves `apps/web/dist`.
- `apps/worker` BullMQ processors, reconciler, scheduler.
- `apps/agent` per-node agent (Swarm global service), dials the server over WebSocket.
- `apps/web` Vite + React 19 + TanStack Router/Query/Table + shadcn/ui + Tailwind v4.
- `packages/db` Drizzle schema + migrations (Postgres). `packages/contracts` zod schemas shared by API, web, agent. `packages/core` pure domain logic (state machines, permissions, spec compilers). `packages/docker` typed Docker Engine API client. `packages/proxy` Caddy JSON compiler + admin client. `packages/providers` DNS / git / notification / S3 adapters.

## Rules (non-negotiable)

1. **Desired state lives in Postgres; a reconciler converges Docker and Caddy to it.** Every operation is idempotent.
2. **Compilers are pure.** `compileService(row) -> Docker ServiceSpec`, `compileProxy(domains) -> Caddy JSON`. No I/O inside; snapshot-test them.
3. **No shell strings.** Docker via Engine API over the Unix socket. External tools via `Bun.spawn([...argv])`, never `sh -c`. Secrets go through env or stdin, never argv.
4. **Every Docker object we create carries labels** `logistack.managed=true`, `logistack.resource=<uuid>`, `logistack.kind=<kind>`, `logistack.org=<orgId>`. Cleanup only ever touches objects with `logistack.managed=true`.
5. **Docker names derive from IDs** (`ls-svc-<shortid>`), never from user-entered names.
6. **Immutable image tags** `<registry>/<org>/<service>:<deploymentId>`; never `:latest`.
7. Parse external input at boundaries with zod; trust internal types.
8. Every setup flow in the UI is a **guided wizard** (steps, validation, test connection, summary).
9. No feature gated behind a license.
10. **Migrations only add.** The previous release runs on the new schema during an update and after a rollback; split drops and renames across two releases (`CONTRIBUTING.md`, "Database migrations").

## Local dev

- `bun install`, `cp .env.example .env`, `bun run dev:infra` (Postgres on 5433, Redis on 6380).
- The dev machine runs OrbStack with an active single-node Swarm. Tests that touch Docker create objects named `ls-test-<area>-*` (area = your package or app, e.g. `ls-test-proxy-`) with label `logistack.test=<area>`, and clean up **only by their own exact prefix**. A filter like `label=logistack.test` or `name=ls-test-` alone matches other suites and is forbidden in cleanup code. Never touch other containers, services, networks or volumes.

## Known facts from spikes

- sslip.io, nip.io and traefik.me are NOT on the Public Suffix List: all their users share one Let's Encrypt budget (50 certs/week). Generated domains are a fallback; the setup wizard recommends a per-server wildcard with DNS-01 (`docs/spikes/proxy.md`).

## Tooling

- Bun 1.4, TypeScript strict, Biome (tabs, double quotes). `bun test` for tests. `bun run typecheck`.
- Commits: conventional style (`feat(server): ...`), identity `info@logicaltech.it`. Never add `Co-Authored-By` or any AI attribution line to commits or PRs.

## UI work

Before any UI work load these skills and follow them: `impeccable:impeccable`, `apple-design`, `design-taste-frontend`, `transitions-dev`, `make-interfaces-feel-better`. Target feel: premium, quiet, ordered, in the style of Vercel and better-auth dashboards. Light and dark themes. Keyboard accessible.

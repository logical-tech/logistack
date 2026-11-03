# Contributing

## Set up a dev machine

You need Bun 1.4 and Docker. Tests that touch Docker expect an active single-node Swarm (`docker swarm init`).

```sh
bun install
cp .env.example .env
bun run dev:infra
bun packages/db/src/migrate.ts
```

`dev:infra` starts Postgres on port 5433 and Redis on port 6380. Then run each process in its own terminal, from the repository root so Bun loads `.env`:

```sh
bun --watch apps/server/src/index.ts
bun --watch apps/worker/src/index.ts
bun run --filter @logistack/web dev
```

The API listens on `http://localhost:3000`. The dashboard runs on `http://localhost:5173` and proxies `/api` to the API.

## Check your change

```sh
bun run check
```

`check` runs `typecheck`, `biome check .`, and `bun test`. Integration tests start their own `ls-test-*` Postgres and Redis containers, and skip when `docker info` fails. The `packages/db` tests run only when `TEST_DATABASE_URL` is set.

## Rules for code

`CLAUDE.md` lists the rules every change follows. The ones reviewers check first:

- Desired state lives in Postgres, and the reconciler converges Docker and Caddy to it. Every operation is idempotent.
- Compilers are pure and have snapshot tests.
- Never build shell strings. Call Docker through the Engine API and other tools with `Bun.spawn([...argv])`. Pass secrets through env or stdin.
- Parse external input with zod at the boundary.
- Do not copy code from Dokploy or Coolify.

A test that creates Docker objects names them `ls-test-<area>-*`, where `<area>` is your package or app, and labels them `logistack.test=<area>`. Cleanup removes objects by that exact prefix only. A filter on `label=logistack.test` or `name=ls-test-` alone matches other suites, so cleanup code must not use it.

## Commits

Use conventional commits, scoped by package or app: `feat(server): ...`, `fix(worker): ...`, `docs: ...`. Keep each commit to one change.

## Report a security problem

Follow `SECURITY.md`. Do not open a public issue.

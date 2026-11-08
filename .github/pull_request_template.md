<!-- Security fixes go through a private advisory (SECURITY.md), not a public pull request. -->

## What and why

<!-- What this changes, and the problem it solves. Link the issue: "Fixes #123". -->

## How you checked it

<!-- The tests you added or ran, and what you tried by hand. Screenshots for UI changes, light and dark. -->

## Checklist

- [ ] `bun run check` passes (typecheck, Biome, tests).
- [ ] No shell strings: Docker through the Engine API, other tools with `Bun.spawn([...argv])`, secrets through env or stdin.
- [ ] Docker objects carry the `logistack.*` labels, and their names come from IDs.
- [ ] Migrations only add (`CONTRIBUTING.md`, "Database migrations").
- [ ] No feature is gated behind a license, a key or a sponsorship.
- [ ] User-facing changes are documented in `docs-site/` (`docs-site/WRITING.md`).
- [ ] Commits follow conventional style, scoped by package or app.

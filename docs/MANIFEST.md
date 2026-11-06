# Project manifests

A manifest is the desired state of one project or one environment as a YAML or JSON file. Export it, keep it in git, and apply it from CI or an agent. The schema lives in `packages/contracts/src/manifest.ts`; a running server serves it as JSON Schema at `/api/manifest/schema.json`, and every YAML export starts with a `yaml-language-server` modeline that points editors at it.

## Format

`version` is `1`. `kind` is `project` (with `project`, project-scope `variables` and `environments`) or `environment` (with one `environment`). An environment holds `variables`, git `stacks` and `services`; a service holds its `spec`, `variables`, `mounts`, `domains` and `backups`.

- **Secrets.** A secret variable is exported as `{ key, secret: true }` with no `value`. On apply, a secret without a value keeps the stored one. A new secret without a value is a warning, not an error: set it after applying, or put the value into the file in CI before applying.
- **Organization resources.** Git providers, S3 destinations, DNS providers and certificates are referenced by name (`gitProvider`, `destination`, `dnsProvider`, `certificate`). A name that matches nothing, or more than one resource, is a 400 listing every such name.
- **Identity.** Environments and services match by slug, variables by key, domains by hostname and path prefix, backups by target, volume, destination and cron, stacks by name.

## Export

`GET /api/projects/{id}/manifest` and `GET /api/environments/{id}/manifest`, with `?format=yaml` for YAML. The project page has an Export action, and each environment's menu has one too.

Not exported: secret values, generated domains, basic auth and domain access rules (they hold password hashes), node pins, adopted volumes. Stacks from a pasted compose file or a template are exported as their services, because the compose file can hold credentials. Git stacks are exported by repository, and their services carry `stack: <name>`.

## Apply

`POST /api/projects/{id}/apply` takes a project manifest. `POST /api/environments/{id}/apply` takes an environment manifest. The body is `{ manifest, prune?, dryRun? }`, where `manifest` is an object or YAML or JSON text. The response lists the `changes` (create, update or delete per resource, never a value), `warnings`, and `backupKeys`: the age key of each encrypted backup policy apply created. The server shows each key once.

- `dryRun: true` returns the plan and writes nothing.
- Apply converges phase by phase: project, environments, variables, stacks, services, domains, backups. Each phase reads the state again. Applying the same manifest twice changes nothing.
- Apply deletes nothing unless `prune: true`. With prune it deletes environments, variables, stacks, services, domains and backups that the manifest does not list.
- Apply calls the same routes a person uses, as the caller. Their permission checks and audit entries apply: creating a stack needs `deploy`, and prune needs `delete`. Apply does not deploy anything. A changed service shows a pending diff until it is deployed, except stacks and config files, which roll out the way their own routes do.
- Apply cannot change these, and reports a warning instead: the volume mounts of an existing service, the git source of an existing stack, and turning backup encryption off.

From CI, with an API key:

```sh
curl -fsS -X POST "$LOGISTACK_URL/api/environments/$ENV_ID/apply" \
  -H "x-api-key: $LOGISTACK_API_KEY" -H 'content-type: application/json' \
  --data "$(jq -Rs '{manifest: ., dryRun: false}' production.logistack.yaml)"
```

Over MCP the same routes are the `project_apply` and `environment_apply` tools.

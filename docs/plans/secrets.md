# Secrets and variables plan

Goal: LogiStack manages secrets the way a dedicated secrets manager would (versioned, audited, scoped, referenced), without leaving the dashboard. A person defines a secret once at the right level and every service below that level can pick it. Nothing reaches a container unless a service references it.

Decisions taken with the user (2026-11-06):

- Scope chain follows the real hierarchy: **organization → folder → subfolder → project → environment → service**. The most specific definition of a key wins.
- **Available + reference.** A secret is visible to every descendant scope, but is injected only into services that reference it. Least privilege: a service never receives a secret it does not use.
- Organization secrets are always available to every project in the organization.
- In a service's Environment tab every variable is either a **reference to a secret** or **typed text**. Typed text marked secret creates a service-scope secret on save, so every secret value lives in one place and is referenced from there.
- Plain (non-secret) variables stay. The page becomes **Secrets & variables**.

## What already exists

- `env_var` table (`packages/db/src/schema/hierarchy.ts:169`): `scope` (organization | project | environment | service), polymorphic `scope_id`, `key`, `value_encrypted`, `is_secret`, `is_build_time`. Every value is encrypted, secret or not.
- `packages/core/src/crypto.ts`: AES-256-GCM, random 96-bit IV, format `v1:<iv>:<ct+tag>`, one instance master key (`LOGISTACK_MASTER_KEY`, a Docker secret file in `install/stack.yml`).
- `resolveEnv` (`packages/core/src/env.ts`) merges scopes, later wins. The worker loads all four scopes for a service and auto-injects all of them (`apps/worker/src/load.ts:164`).
- `read:secrets` permission: values of `is_secret` rows are masked unless the actor holds it (`apps/server/src/routes/env-vars.ts`, `manifest.ts:200`).
- Build-time secrets already go through BuildKit `--secret` (`apps/worker/src/build.ts:261`), never build-args.
- Audit log redacts secret-looking keys (`apps/server/src/audit.ts:13`).
- Web: Settings > Variables (org), project Shared variables (project + environments), service Environment tab, all on `env-editor.tsx`.

## Gaps in today's crypto

These are the reasons for a new format, not just a new table.

1. **No AAD.** A ciphertext is not bound to its row. Someone with write access to Postgres can copy secret A's ciphertext into secret B's row (or into a service they control) and GCM accepts it. Fix: authenticate the row identity as AAD.
2. **One key for everything.** The master key encrypts env vars, mounts, preview settings, provider credentials, AI keys. A leak of any one decrypt path is a leak of all. No per-organization isolation.
3. **No rotation.** `v1` has no key id, so the master key cannot be rotated without a full offline re-encryption.
4. **No version history.** Overwriting a secret loses the old value; there is no rollback and no "who changed it".
5. **Reveal is not audited.** Reading a secret value is a `GET` and leaves no trace.

## Threat model

In scope:

- Postgres dump or backup leak (DB without master key): must yield nothing.
- DB write access without the master key: must not be able to move or swap ciphertexts to exfiltrate through a service it controls.
- A member without `read:secrets`: can reference secrets it may write, cannot read values through API, MCP, manifest export, audit diffs, deploy logs or the UI.
- Master key compromise: must be rotatable online, and the blast radius limited to rewrapping.

Out of scope (stated in docs): root on a manager node or access to the Docker socket. Env vars are in the Swarm service spec, readable by `docker service inspect`; whoever has the socket owns the host. Swarm stores its Raft log encrypted at rest. An optional "mount as file" mode (Swarm secret at `/run/secrets/<KEY>`) is listed under later work for apps that support `*_FILE`.

## Crypto design (envelope encryption)

```
LOGISTACK_MASTER_KEY (KEK, Docker secret, never in Postgres)
  └─ HKDF-SHA256(info="logistack/secrets/kek/v<n>") → wrapping key
       └─ wraps per-organization data keys (DEK), 32 random bytes, versioned
            └─ AES-256-GCM per value, fresh 96-bit IV, AAD binds the row
```

- **Purpose-separated KEK.** Derive the secrets wrapping key with HKDF from the master key, so the secrets subsystem never uses the raw master key that `v1` blobs use elsewhere. Other subsystems migrate later, same helper.
- **Per-organization DEK keyring.** New table `secret_key`: `organization_id`, `version`, `wrapped_key` (`v2` AES-GCM of the DEK under the KEK, AAD = `orgId|version`), `kek_version`, `status` (active | retired), `created_at`. One active version per org (partial unique index).
- **Value format** `v2:<dekVersion>:<iv b64>:<ct+tag b64>`. AAD = `secret_version:<orgId>:<secretId>:<versionNumber>`. A ciphertext copied to any other row, org or version fails to decrypt.
- **Nonces.** Random 96-bit IVs; the per-DEK message budget (2^32) is far above any realistic org, and DEK rotation resets it.
- **DEK cache.** Unwrapped DEKs are kept in process memory only, `CryptoKey` non-extractable, small LRU with TTL. Plaintext values are never cached.
- **Rotation.** DEK rotation (per org, button in Settings and API): create version n+1, new writes use it, re-encrypt that org's `secret_version` rows, mark n retired. Idempotent: rows already on n+1 are skipped. (KEK rotation: see "As built".)
- **Pure functions in `packages/core/src/crypto.ts`**: `deriveKek`, `wrapKey`, `unwrapKey`, `sealValue(dek, aad, plaintext)`, `openValue(dek, aad, payload)`. `v1` encrypt/decrypt stay as they are for the rest of the app. Tests: round trip, AAD mismatch throws, swapped row throws, wrong DEK version throws, tampered byte throws, KEK rewrap keeps values readable.

Not doing now: external KMS (Vault Transit, AWS KMS). The KEK sits behind one function (`loadKek`), so a KMS provider can replace it later without touching stored values.

## Data model (additive migration, rule 10)

```
secret                      one logical secret at one scope
  id (sec_), organization_id FK cascade
  scope  secret_scope enum: organization | folder | project | environment | service
  scope_id, key, description
  current_version int
  created_by, updated_by, timestamps
  unique (scope, scope_id, key)

secret_version              append-only history
  id (sev_), secret_id FK cascade, version int
  value_encrypted (v2), dek_version
  created_by, created_at
  unique (secret_id, version)

secret_key                  per-org DEK keyring (see above)

env_var                     + secret_id nullable FK → secret, ON DELETE RESTRICT
                            + scope enum gains 'folder'
```

- An `env_var` row is now one of: a plain value (`secret_id` null, `is_secret` false), or a **reference** (`secret_id` set). `key` on the env_var is the name injected into the container, so a service can map `DB_PASSWORD` to an org secret called `PROD_PG_PASSWORD`.
- `ON DELETE RESTRICT`: a referenced secret cannot be deleted; the API answers 409 with the list of services that use it.
- A reference must point to a secret whose scope is an ancestor of (or equal to) the referencing scope. Checked in the API and again in the worker at resolve time (a project moved to another folder can orphan a folder secret: the deploy fails with a clear message, the UI shows the broken reference).
- Folder scope: depth ≤ 2, so the chain is at most org → folder → subfolder → project → environment → service.

## Resolution (pure, `packages/core/src/env.ts`)

`resolveServiceEnv({ chain, plainVars, references, secrets })`:

1. `chain` = ordered scope ids for the service, built once from the hierarchy.
2. Plain variables keep today's cascade (they are config, not secrets, and the user relies on shared plain vars).
3. For each reference, take the secret by id; check its scope is in `chain`; inject `env_var.key = value of current version`.
4. Secret lookup by key (for the picker and for `${{ secrets.KEY }}` later) picks the most specific scope in the chain that defines it.

Snapshot tests cover: override order, folder nesting, reference to a non-ancestor rejected, orphan after a project move.

The worker records which `secret_version` ids a deployment used (`deployment.secret_versions jsonb`, additive). This makes rollbacks reproducible and drives the pending diff: changing a secret marks every service that references it "needs redeploy", with an optional "redeploy all affected" action.

## Access control and audit

- Write a secret: `write` on its scope. Reference a secret: `write` on the service and `read` on the secret's scope (not `read:secrets`; referencing never shows the value).
- See a value: `read:secrets` on the secret's scope, through **`POST /secrets/{id}/reveal`** only. List and get endpoints never return values, even to admins. Every reveal writes an audit event `secret.reveal` (actor, secret, version, IP).
- Audit for create, update (new version), rollback, delete, rotate. Diffs carry key and version numbers, never values.
- Manifest export: references export as `secret: KEY@scope`; values only with `read:secrets` and an explicit `includeValues` flag, audited as a reveal.
- Deploy and build logs: the worker masks every injected secret value (and its base64 form) in the log stream before it is stored or streamed.
- MCP tools come from the routes, so they inherit all of the above; `reveal` is marked sensitive.
- API responses for secrets set `Cache-Control: no-store`.

## API

| route | permission | notes |
|---|---|---|
| `GET /secrets?scope&scopeId` | read | metadata only: key, scope, version, updated, `usedBy` count |
| `GET /secrets/available?serviceId` | read | every secret in the service's chain, most specific per key, for the picker |
| `POST /secrets` | write | key, value, description; creates version 1 |
| `PATCH /secrets/{id}` | write | new value → new version; description |
| `POST /secrets/{id}/reveal` | read:secrets | optional `version` |
| `GET /secrets/{id}/versions` | read | metadata of every version |
| `POST /secrets/{id}/rollback` | write | copies an old version as a new one (history stays append-only) |
| `GET /secrets/{id}/usages` | read | services and env keys referencing it |
| `DELETE /secrets/{id}` | delete | 409 while referenced |
| `POST /organization/secret-keys/rotate` | admin | DEK rotation job |
| `PUT /services/{id}/env` | write | existing bulk save, entries gain `{ secretId }` or `{ value, secret: true }` (creates a service secret) |

Keys validated with the existing reserved-key rules (`LOGISTACK_*`). Values capped (64 KiB) at the zod boundary.

## UI

Follows the UI rules in `CLAUDE.md` (load the design skills first). Quiet, dense table in the Vercel/Infisical spirit.

- **Settings > Secrets & variables** (org) and **project > Secrets & variables**: a scope switcher (Organization, folders, Project, each environment) over one table. Columns: key, value (masked, eye button = reveal with a brief toast "Reveal recorded"), scope chip, version, used by, updated. Row menu: history drawer (versions, author, rollback), usages, copy reference, delete (disabled with reason while used). Tabs inside: Secrets / Variables.
- Folder pages get the same panel.
- **Service > Environment**: each row is `KEY = [Secret ▾ | Text]`.
  - Secret: a combobox listing available secrets grouped by scope (Organization, Folder, Project, Environment, Service), with search. Shows a lock icon and the source scope chip.
  - Text: free value; a "secret" toggle (default on when the key looks sensitive, using the same pattern as migrations) turns it into a service secret on save.
  - Broken references (secret deleted elsewhere is impossible, but moved projects are possible) show in red with a fix action.
  - Paste-a-.env keeps working: secret-looking keys become service secrets, the rest plain vars, with a summary step before save (rule 8).
- A banner on services whose referenced secret changed since the last deploy, with "Redeploy".

## Migration and rollback compatibility

Rule 10: the previous release must run on the new schema.

1. Migration adds `secret`, `secret_version`, `secret_key`, `env_var.secret_id`, `env_var.scope` value `folder`, `deployment.secret_versions`. No drops.
2. A boot task (idempotent, under a Redis lock) converts every `env_var` with `is_secret = true` into a `secret` at the same scope plus a reference row. Organization/project/environment secrets keep today's auto-injection for existing services by creating references in every service that currently receives them, so nothing changes at deploy.
3. **Compat shadow for one release:** reference rows keep `value_encrypted` filled with the `v1` ciphertext of the current value, so the previous release still deploys correctly after a rollback. The next release stops writing the shadow and a later one blanks it. This keeps the old weaker format around for one release; it is no weaker than today.
4. Folder-scope rows are invisible to the previous release (it never queries that scope); acceptable because folders gain secrets only with the new release.

## Tests

- `packages/core`: crypto (above), resolution snapshots.
- `apps/server`: reveal requires `read:secrets` and writes audit; list never contains values; reference outside the chain → 400; delete referenced → 409; rollback creates a new version; manifest round trip with references.
- `apps/worker`: deploy injects only referenced secrets; log masking; DEK rotation job is idempotent and leaves every value readable; boot migration is idempotent and preserves the effective env of every existing service (compare `resolveEnv` before and after on fixtures).
- e2e on the web mock: pick an inherited secret, type a new one, save, see the reference.

## Phases

1. **Core**: crypto v2 + keyring, schema, resolution, `/secrets` API, reveal audit, worker injection, log masking, boot migration. Ships with the existing editor showing references read-only.
2. **UI**: Secrets & variables pages, service picker, history and usages, redeploy banner.
3. **Rotation**: DEK rotation job and UI, `keys rotate-master` CLI, docs-site page.

## As built (2026-11-06)

Differences from the design above, and why:

- **No `kek_version`, no `keys rotate-master` CLI.** The KEK is HKDF of the master key, and every other subsystem (mounts, provider credentials, AI keys, preview settings) still encrypts `v1` with the raw master key. Replacing the master key therefore means re-encrypting all of those too, which is its own job. Data-key rotation (`POST /organization/secret-keys/rotate`) ships; master key rotation is listed under Later.
- **No `deployment.secret_versions`.** `loadService` resolves references to current values, so the pending diff already shows "changed (secret)" on every service whose referenced secret changed. No new column is needed for the redeploy banner.
- **Plain variables keep their four scopes.** Only secrets gain the folder scope; a plain folder variable can come later on the same chain.
- **Legacy secret variables** (`is_secret` without `secret_id`) still get written by the env-var API, manifests, templates and database setup. The worker converts them at boot and before every deploy (`convertLegacySecrets`), so those writers keep working unchanged. Until a row converts, it cascades as before.
- **Service secrets typed in the Environment tab** are deleted when the variable that created them is removed and nothing else references them. Only a secret with the variable's key, at that service's scope, qualifies.
- **Cleanup triggers** (`0040_scope_cleanup.sql`): deleting a service, environment, project or folder deletes its variables and secrets. Before this, `env_var` rows outlived their scope.
- The managed value is never returned by `GET /services/{id}/env-vars` or `GET /env-vars`, even with `read:secrets`; only `POST /secrets/{id}/reveal` returns it.

## Later (not in this plan)

- Master key rotation across every encrypted column (`v1` and the secrets KEK).
- Manifests: export and apply references (`secretRef`) instead of copying values. Today a duplicated environment copies referenced values into service secrets.
- Move the in-process credential readers (database explorer, storage keys, game RCON) from the `v1` copy on `env_var` to `readSecretValues`, then stop writing the copy.

- `${{ secrets.KEY }}` interpolation inside plain values (e.g. `DATABASE_URL=postgres://app:${{ secrets.PG_PASSWORD }}@db/app`).
- Mount as file (Swarm secret) per reference.
- External KMS as KEK provider.
- Stacks (compose) consuming references; today they keep their own env.
- Secret expiry reminders and generated secrets (random password button exists in templates; reuse it).

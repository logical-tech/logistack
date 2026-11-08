# LogiStack plugin index

The marketplace's server side (`docs/plans/plugins.md`, "Marketplace and distribution"): a Cloudflare Worker with D1 at `https://stack.logicaltech.it/plugins/api`. It stores plugin metadata only (manifest, image digest, README, changelog, icon URL). Images stay in each publisher's registry.

Like `sponsors/`, it sits outside the Bun workspaces. It imports the manifest schema from `packages/contracts/src/plugin.ts`, so run `bun install` at the repo root before running it.

## Signed responses

`GET /v1/index` and `GET /v1/plugins/{id}` answer with this JSON envelope:

```json
{
  "keyId": "EfBkYCgUNTKG8XzXf7kJsamCVq2kxJ-U9JrEQq-FlGA",
  "payload": "{\"v\":1,\"kind\":\"index\",\"issuedAt\":\"2026-11-08T22:16:28.184Z\",\"plugins\":[]}",
  "signature": "KvY7Xsrg…"
}
```

- `payload` is a string: the exact JSON text that was signed. A verifier checks the signature over these bytes and only then parses them. There is no canonicalization.
- `signature` is the base64url (no padding) Ed25519 signature over the UTF-8 bytes of `payload`.
- `keyId` is the signer's base64url raw 32-byte Ed25519 public key. A server accepts a response only when `keyId` is one of the keys it ships with. To rotate a key, ship the new public key in a release next to the old one, then switch `SIGNING_KEY`.
- The payload is `{v: 1, kind: "index", issuedAt, plugins: PluginIndexEntry[]}` or `{v: 1, kind: "plugin", issuedAt, plugin: {id, publisher, installs, versions: PluginIndexVersion[]}}`. The zod schemas are at the end of `packages/contracts/src/plugin.ts`. `kind`, plus the `id` in a plugin answer, stop one signed answer from standing in for another. `issuedAt` lets a server refuse an index older than the one it cached.

The verifier for LogiStack servers is `packages/core/src/plugin-index.ts`. `verifyIndexResponse(body, trustedKeys)` checks the signature. `readPluginIndex(payload)` and `readPluginDetail(payload, id)` then parse the payload; they skip entries a server cannot read (for example, a newer schema) instead of failing. `PLUGIN_INDEX_KEYS` stays empty until the production key exists, so until then every response fails verification.

A private index implements the same two endpoints and the same envelope.

## Endpoints

Paths are relative to `/plugins/api`.

| | |
|---|---|
| `GET /v1/index` | Signed. Every plugin with a listed version: `latest` (newest version that is not yanked), `latestVerified`, the `yanked` versions, and `installs`. |
| `GET /v1/plugins/{id}` | Signed. All listed versions, newest first, with README and changelog. |
| `POST /v1/ping` | `{pluginId, installId}`. Opt-in and anonymous: `installId` is a random id from the instance. No IP address or instance data is stored. `installs` counts the distinct ids seen in the last 30 days. |
| `POST /v1/reports` | `{pluginId, version?, reason, contact?}`. Goes to the admin queue. |
| `POST /auth/login` | `{email}`. Sends a magic link through Resend. |
| `GET`/`POST /auth/callback` | The link opens a page with a button. The POST spends the token and sets the session cookie, so a mail scanner that fetches the link spends nothing. |
| `POST /me` | `{name}`. Sets the public publisher name. |
| `GET /me/plugins` | Your plugins and versions, with their status and review notes. |
| `POST /me/plugins` | `{id}`. Registers a plugin id, first come, first served. Ids under `dev.logistack.` and `it.logicaltech.` are for admins. |
| `POST /me/plugins/{id}/versions` | `{image, manifest, readme?, changelog?, iconUrl?}`. Submits a version. |
| `POST /me/tokens` | `{name}`. Returns an API token once, for the CLI and CI. |
| `GET /admin`, `GET /admin/queue` | The review queue (HTML or JSON): pending, unverified and verified versions, and open reports. |
| `POST /admin/versions/{id}/verify` | `{commit}`. Records the reviewer and the reviewed source commit. |
| `POST /admin/versions/{id}/reject` / `yank` | `{notes}`. |
| `POST /admin/versions/{id}/checks` | CI results as JSON, up to 16 KiB. |
| `POST /admin/publishers/{id}/suspend` | `{reason}`. Blocks the publisher, revokes their sessions and tokens, and yanks every listed version. |
| `POST /admin/reports/{id}/resolve` | `{resolution}`. |

Everything under `/me` and `/admin` takes either the session cookie (from the HTML pages at `/`, `/dashboard` and `/admin`) or `Authorization: Bearer lspi_…`. A request that uses the cookie must come from the same origin.

## Review pipeline

1. **Submit.** The Worker validates the manifest with the contract schema, strictly at the top level. The index takes free plugins only, so keys such as `price` or `licenseKey` are refused, not dropped. The manifest id must be the plugin's id. The image must be `registry/repo@sha256:…`.
2. **Registry check, in the Worker.** It reads the registry manifest by digest and, for an index, every linux image in it. It then reads each image's config blob and checks that the `io.logistack.plugin.manifest` label equals the submitted manifest. Each document is checked against its digest. Access is anonymous, so only public images can be listed. If every check passes, the version is listed as `unverified`. Otherwise it is `rejected` with the reason, and the publisher can submit the same version again.
3. **Contract test and scan, in CI.** A Worker cannot pull or run images. `ci/review.yml` is an example GitHub Actions job (not enabled) that starts the image with the reconciler's hardening, runs `logistack-plugin test` and trivy, and attaches the results with `POST /admin/versions/{id}/checks`.
4. **Verify.** An admin reads the source at a commit and marks the version `verified`, which records the reviewer and the commit. Admins can also reject, yank and suspend.

Versions are immutable. Statuses: `pending` (while the submit check runs), `unverified`, `verified`, `rejected` and `yanked`. Servers see only `unverified`, `verified` and `yanked`.

## Local development

```sh
bun install                  # at the repo root, then here
bun scripts/keygen.ts --dev  # writes .dev.vars (gitignored) with a dev key; prints the dev public key
bun run dev                  # applies migrations to the local D1, then wrangler dev on :8787
bun test
```

With `DEV_LOGIN_LINKS=1` (set by `--dev`), sign-in links go to the wrangler log instead of to Resend. To make yourself an admin locally, run `wrangler d1 execute PLUGIN_INDEX --local --command "INSERT INTO admins (email, created_at) VALUES ('you@example.com', 0)"`.

To publish from a plugin folder, run `LOGISTACK_INDEX_URL=http://localhost:8787 LOGISTACK_INDEX_TOKEN=lspi_… logistack-plugin publish ghcr.io/acme/x@sha256:… src/main.ts`.

## Deploy

None of this has been run. Do it in this order, from `plugin-index/`:

1. Create the databases, then put each printed id in `wrangler.jsonc` (production, and `env.sandbox`):
   ```sh
   bunx wrangler d1 create logistack-plugin-index
   bunx wrangler d1 create logistack-plugin-index-sandbox
   ```
2. Apply the migrations:
   ```sh
   bunx wrangler d1 migrations apply PLUGIN_INDEX --remote
   bunx wrangler d1 migrations apply PLUGIN_INDEX --remote --env sandbox
   ```
3. Generate a signing key for each environment. The private key goes straight into the secret and never touches disk. Note the public key printed on stderr:
   ```sh
   bun scripts/keygen.ts | bunx wrangler secret put SIGNING_KEY
   bun scripts/keygen.ts | bunx wrangler secret put SIGNING_KEY --env sandbox
   ```
4. Add a Resend key that can send from `plugins@logicaltech.it`. The domain is already verified for the sponsors email.
   ```sh
   bunx wrangler secret put RESEND_API_KEY
   bunx wrangler secret put RESEND_API_KEY --env sandbox
   ```
5. Routes: `stack.logicaltech.it` must be proxied by Cloudflare (orange cloud) for the `stack.logicaltech.it/plugins/api*` routes to reach the Worker ahead of the Dokploy origin. If it is DNS-only, either proxy it or move the index to its own custom domain, as `sponsors.logicaltech.it` does, and update `PLUGIN_INDEX_URL` in `packages/core/src/plugin-index.ts`.
6. Deploy:
   ```sh
   bunx wrangler deploy
   bunx wrangler deploy --env sandbox
   ```
7. Make yourself an admin:
   ```sh
   bunx wrangler d1 execute PLUGIN_INDEX --remote --command "INSERT INTO admins (email, created_at) VALUES ('info@logicaltech.it', unixepoch())"
   ```
8. Put the production public key from step 3 in `PLUGIN_INDEX_KEYS` (`packages/core/src/plugin-index.ts`) and release LogiStack. Check it with `curl https://stack.logicaltech.it/plugins/api/v1/index`: the `keyId` must equal that key.

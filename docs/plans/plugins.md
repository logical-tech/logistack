# Plugins and plugin marketplace plan

Goal: a user with a niche need that LogiStack does not cover installs a community plugin from a marketplace, or installs their own, in a guided wizard. A broken or malicious plugin cannot take over the cluster, read other tenants' data or act beyond the permissions the user approved.

Status: phase 1 built on `feat/plugins` (2026-11-08), plus plugin tools from phase 2. See "Implementation status" at the end.

## What already exists

- **Templates** (`packages/templates`, `apps/server/src/routes/templates.ts`): a catalog of compose apps, deployed as stacks with provenance `template:<id>:…`. Data only, no code.
- **Provider registries** (`packages/providers`): `dnsProviders`, `notificationChannels`, `secretProviders`, backup destinations, git. Each is a `ProviderDef` with a zod `configSchema`; `/integrations/schemas` already serves them as JSON Schema to the wizards, and `secret: true` fields are masked.
- **Events** (`packages/contracts/src/events.ts`, `EVENTS_CHANNEL`): a typed event envelope that notification rules and the `webhook` channel already deliver as signed HTTP.
- **Service accounts and scoped API keys**, audit log with actors, MCP tools generated from the OpenAPI document, the AI agent's tool calls and approvals.
- **The platform itself runs containers**: reconciler, labels, immutable image refs, registries with credentials, vulnerability scanning.

## Premise: a plugin is a container, never code in our process

The server process holds the Docker socket and the master encryption key. Code loaded into it (an npm package, a `require` of an uploaded file) owns every node and every secret. So a plugin never runs inside `apps/server`, `apps/worker` or `apps/agent`.

A plugin is an **OCI image plus a manifest**. LogiStack runs it as a managed Swarm service and talks to it over HTTP. This reuses what we already do well (reconcile a service, pin a digest, scan an image, limit resources) and works in any language.

Rejected for v1:

| Option | Why not |
|---|---|
| JS loaded in-process | Full compromise on install. No isolation between plugins. |
| QuickJS / WASM sandbox | Safe, but only for small pure functions: no long-running work, no libraries, a custom SDK for every capability. Keep it for the Automations Code node. |
| Webhooks only (plugin hosted elsewhere) | Works, and we keep it as the dev mode (below), but users want "install" to mean "it runs here". |

## What a plugin can contribute

Ordered by value and by how little new surface they need.

1. **Event hooks.** Subscribe to event types; LogiStack POSTs each event, signed, to the plugin. Asynchronous, cannot block a deploy. Reuses the webhook delivery path.
2. **API access.** The plugin calls the LogiStack REST API with a token scoped to the permissions approved at install. Everything a plugin does is audited with actor `plugin:<pluginId>`.
3. **Providers.** A new DNS provider, notification channel, secret provider or backup destination. The plugin declares the provider and its JSON Schema config; LogiStack shows it in the existing wizards and forwards each provider call to the plugin over HTTP.
4. **Tools.** Named operations with a JSON Schema input, exposed to the AI agent, to MCP and later as Automations nodes.
5. **Settings page.** A config form rendered by LogiStack from the plugin's JSON Schema. No plugin code in the dashboard.
6. **UI pages.** Screens the plugin adds to the dashboard: a sidebar page, a tab on a service or project, a settings section. Rendered in a sandboxed iframe with an opaque origin; see "UI pages" below. Never script in our origin.
7. **Deploy gates (later).** A synchronous pre-deploy hook that can approve or reject, with a timeout and a per-install fail-open or fail-closed choice.

Not in scope: changing the compilers, the reconciler or the proxy config. Those stay pure and ours (rules 1 and 2).

## Manifest

Zod schema in `packages/contracts/src/plugin.ts`, served as JSON Schema like the project manifest. Shipped as an OCI image label `io.logistack.plugin.manifest` (JSON), so LogiStack reads it from the registry or from `docker image inspect` without starting the container.

```yaml
id: com.acme.hetzner-dns          # reverse-DNS, unique in an index
version: 1.2.0                    # semver
name: Hetzner DNS
description: DNS-01 and records on Hetzner DNS
author: { name: Acme, url: https://acme.dev }
license: MIT
logistack: ">=0.6.0"              # compatible server versions
port: 8080
resources: { memory: 128Mi, cpu: 0.25 }
permissions:                      # existing permission actions; the installer picks the scope (org or projects)
  - read
egress:                           # declared, shown to the user; enforced later
  - dns.hetzner.com
config:                           # JSON Schema; secret: true fields are encrypted
  type: object
  properties: { }
contributes:
  events: [deployment.succeeded, deployment.failed]
  dnsProviders:
    - name: hetzner
      title: Hetzner DNS
      configSchema: { type: object, properties: { token: { type: string, secret: true } } }
  tools:
    - name: purge-cache
      description: Purge the CDN cache for a domain
      inputSchema: { type: object, properties: { domain: { type: string } } }
      destructive: false
  pages:
    - id: costs
      title: Costs
      icon: chart                 # from our icon set, not a URL
      location: sidebar           # sidebar | service-tab | project-tab | settings
      path: /ui/costs             # served by the plugin container
    - id: cache
      title: CDN cache
      location: service-tab
      serviceKinds: [application] # where the tab appears
      path: /ui/cache
```

The image ref itself is not in the manifest: the index or the user supplies it, always as a digest (`ghcr.io/acme/hetzner-dns@sha256:…`), per rule 6.

## Runtime

- **Install = a row; the reconciler runs it** (rule 1). A `plugin_install` row compiles to a Swarm service `ls-plg-<shortid>` (rule 5) with labels `logistack.managed=true`, `logistack.kind=plugin`, `logistack.resource=<installId>`, `logistack.org=<orgId>` (rule 4). `compilePlugin(row) -> ServiceSpec` is pure and snapshot-tested, likely a thin call into `compileService`.
- **Hardening, not optional:** no Docker socket, no host mounts, no `privileged`, `CapDrop: ALL`, read-only rootfs with a tmpfs `/tmp`, memory and CPU limits from the manifest (with an instance cap), one named volume `/data` for the plugin's own state.
- **Network:** a dedicated overlay `ls-plugins`. It reaches the LogiStack API and the internet; it does not join project networks, so a plugin cannot reach users' databases unless it goes through the API. Egress allowlisting through a proxy is a later phase; v1 shows the declared hosts.
- **LogiStack → plugin:** HTTP to `http://ls-plg-<shortid>:<port>`, each request signed with a per-install HMAC secret (same scheme as the webhook channel), with timeout and retries for events. Contract endpoints, versioned:
  - `GET /v1/health`
  - `POST /v1/events`
  - `POST /v1/providers/{kind}/{name}/{op}` (ops mirror the provider interface: `test`, `listZones`, `upsertRecord`, `send`, …)
  - `POST /v1/tools/{name}`
  - `POST /v1/config/validate` (optional, for "Test connection" in the wizard)
- **Plugin → LogiStack:** env `LOGISTACK_URL` and `LOGISTACK_TOKEN`, a service-account key scoped to `permissions`, created at install and rotated on update. Secrets go through env, never argv (rule 3). Config values arrive in each signed request, secrets decrypted per call, not stored in the container env, so a config change does not need a restart.
- **Kill switch:** disabling an install scales it to 0 and hides its contributions. Resources that use a plugin provider show "plugin disabled" instead of failing silently. Uninstall is blocked while resources reference it, as with secrets in use.

## UI pages (decided: needed from the first phase)

A plugin page is plugin-authored HTML and JS shown inside our dashboard. The rule: it runs in an **opaque origin**, so it cannot read our cookies, our DOM, our local storage or call our API as the user.

### Serving

- The server proxies `GET /plugins/{installId}/ui/*` to the plugin container's page `path`. The proxy strips `Cookie`, `Authorization` and `x-api-key` from the request and `Set-Cookie` from the response.
- Every proxied response gets `Content-Security-Policy: sandbox allow-scripts allow-forms; frame-ancestors 'self'` and `X-Content-Type-Options: nosniff`. The CSP `sandbox` directive forces an opaque origin even when someone opens the URL directly in a tab, which is the attack a plain iframe `sandbox` attribute does not cover.
- The dashboard embeds it as `<iframe sandbox="allow-scripts allow-forms" src="/plugins/{installId}/ui/…">`. No `allow-same-origin`, no `allow-top-navigation`, no `allow-popups`.
- One URL shape for all installs, so no wildcard DNS or certificate is needed on self-hosted instances. Dev-URL installs are proxied the same way.

### Bridge

A small postMessage protocol, wrapped by `@logistack/plugin-ui` in the SDK. The host accepts messages only when `event.source` is that iframe's `contentWindow` (the origin is `"null"`, so origin checks are useless).

| message | direction | purpose |
|---|---|---|
| `init` | host → page | theme (light/dark and our CSS variables), locale, user (id, name), org, context (`serviceId`/`projectId` for tabs), a session token |
| `token.refresh` | page → host | a new session token before the old one expires |
| `resize` | page → host | content height, so the page does not scroll inside a scroll |
| `navigate` | page → host | go to a dashboard route (validated against our router) or another page of the same plugin |
| `toast` | page → host | a native toast |
| `confirm` | page → host | a native confirm dialog; the answer comes back. Destructive actions in plugin UIs use this, so they look like ours |
| `openExternal` | page → host | open an `https` URL in a new tab after a host prompt showing the domain |
| `storage.get` / `storage.set` / `storage.delete` | page → host | small key-value storage for UI state (filters, collapsed panels, preferences) |

### Storage for pages

An opaque origin has no `localStorage`, `sessionStorage`, cookies or IndexedDB: touching them throws `SecurityError`, and many libraries do so on import, which blanks the page. So:

- `@logistack/plugin-ui` exposes `storage` (async `get`, `set`, `delete`) over the bridge, plus a `localStorage`-shaped adapter for libraries that accept a custom storage.
- The host persists it server-side in `plugin_ui_storage` (`install_id`, `user_id`, `key`, `value` jsonb, `updated_at`; PK on the first three) through `GET/PUT/DELETE /api/plugins/{installId}/storage/{key}`. Per user and per install, so it follows the user across browsers.
- Limits: keys up to 128 chars, values up to 16 KB, 256 keys per user per install. It is for UI state, not plugin data, which lives in the plugin's own backend and volume.
- Deleted with the install. Values are not secrets: the docs say so.
- `logistack-plugin dev` serves pages with the same CSP sandbox, so a developer sees the crash locally; the marketplace review pipeline loads each page in a sandboxed headless browser and fails on uncaught errors.

### Auth for page requests

- The session token is a short-lived (5 min) JWT signed by the server: user, org, install, the viewing user's permissions on the context resource. Not usable on our API.
- The page calls its own backend through the same proxy (`/plugins/{installId}/ui/api/…`) with the token in a header. The proxy verifies it and forwards the claims to the container as signed headers (same HMAC as other calls). The plugin trusts those headers, not the browser.
- Work the page triggers runs with the plugin's own scoped token. The plugin must check the forwarded user permissions before acting; the SDK does this by default (`requirePermission("deploy")`).
- The dashboard shows a page entry only to members with `read` on its context.

### Look and feel

The SDK ships a small CSS kit built on the CSS variables sent in `init` (type scale, spacing, buttons, inputs, tables, both themes), so plugin pages look like LogiStack without loading our bundle. Optional: plugins may use anything.

### Anti-spoofing

The host draws a thin, fixed header above every plugin page: plugin icon, name, author, verified badge. The iframe never covers it, never goes fullscreen, and cannot open dialogs over the host. Plugin pages must never ask for LogiStack passwords; the review checklist covers this.

### Dashboard routes

- `/_app/plugins/$installId/$pageId/$` for sidebar and settings pages; a "Plugins" group in the sidebar lists them.
- A plugin tab on service and project pages (`…/plugin/$installId/$pageId/$`).
- The nav reads `GET /api/plugins/contributions` (pages, providers, tools of enabled installs), cached with TanStack Query.

### Scope: per organization

One install per organization that wants the plugin, one container each. Tenants are isolated by construction, the token is org-scoped, labels carry the org. A single-org instance pays one container. The instance admin sets a policy: plugins off, marketplace-verified only, or any image.

### Who can install (decided)

- The **instance admin**, who also sets the policy.
- A member whose role has the new permission action **`plugins`** (in `permissionActions`). Like `exec` and `ai`, it is not in `developer` or any built-in role except owner/admin: someone grants it explicitly. It covers install, update, configure, disable and uninstall, inside the instance policy. A plugin cannot receive permissions its installer does not hold.

## Data model (additive migrations)

| table | columns |
|---|---|
| `plugin_index` | `id`, `url`, `name`, `public_key`, `fetched_at`, `entries` jsonb (cache) |
| `plugin_install` | `id`, `org_id`, `plugin_id`, `version`, `image` (digest), `manifest` jsonb, `index_id` nullable (null = uploaded by the user), `config` (secret fields through the secrets envelope), `service_account_id`, `signing_secret` (encrypted), `enabled`, `status`, timestamps |

Provider rows: add `plugin` to `dns_provider_kind`, `notification_channel_kind` and the others, plus nullable `plugin_install_id` and `plugin_provider` columns. The provider registry resolves `kind = plugin` to an HTTP proxy implementing the same interface, so every caller stays unchanged.

## Marketplace and distribution

- **Index = an API at `stack.logicaltech.it/plugins/api`** (decided). A Cloudflare Worker with D1, deployed like the sponsor Workers, plus a sandbox environment. Publishers sign in, register a plugin id, and submit versions from a web form or from `logistack-plugin publish`; no git PRs. We host metadata only (manifest, digest, README, changelog, icon); images stay in the publisher's registry, referenced by digest.
- **Endpoints for LogiStack servers:** `GET /v1/index` (all plugins, latest compatible versions) and `GET /v1/plugins/{id}` (all versions). Each response is signed with an Ed25519 key, the same pattern as sponsor keys; the server checks it with the public key bundled in the release. The server fetches only when someone opens the marketplace or clicks Refresh, never on a cron, and caches the result in `plugin_index` (PIANO rule 8: no runtime CDN downloads, explicit updates only).
- **Review pipeline:** on submit, a job pulls the image by digest, validates the manifest label, scans the image (same scanner as `image.vulnerable`), and runs the SDK contract test. A version goes live as "unverified" after automatic checks pass. "Verified" means a maintainer reviewed the source at that commit, from an admin queue in the same app. Unverified entries show a clear badge, or are hidden by the instance policy.
- **Moderation:** report a plugin, yank a version (servers show a warning on installs of a yanked version at next Refresh, never remove them), suspend a publisher. Install counts come from anonymous pings only if the instance opts in; ratings are a later idea, not v1.
- **Free only (decided):** the manifest and the API have no price, license key or checkout fields, and submission rejects plugins that gate features behind payment. Revisit later as a separate decision.
- **Private indexes:** an instance can add more index URLs (a company's internal marketplace) that implement the same two read endpoints and signature format.
- **Bring your own plugin:** "Install from image" takes an image ref from any configured registry (existing registry credentials), resolves it to a digest, reads the manifest label and continues in the same wizard, marked "Unlisted". For development, "Install from URL" points at a plugin running elsewhere (`https://…`), no container: the fastest loop while writing one.
- **Updates:** explicit. The update dialog shows the version, the changelog, and a permission and egress diff; added permissions need consent again. Rollback reinstalls the previous digest.

## Install wizard (rule 8)

1. Pick from the marketplace, or paste an image, or a dev URL.
2. Review: author, verified state, image digest, scan result, what it contributes, permissions, declared egress, resources.
3. Configure: the form from `config` JSON Schema, with secrets masked.
4. Test: start the container, wait for `/v1/health`, call `/v1/config/validate` if present.
5. Summary and install.

Pages: Settings → Plugins (installed, with status, logs and metrics from the existing service views) and a Marketplace tab. Contributions show up where they belong: a plugin DNS provider in the DNS wizard, tools in the Agent, events in the plugin's detail page.

## SDK and developer experience

- **Contract as OpenAPI** (`plugin-contract.yaml`), so a plugin can be written in any language.
- **`@logistack/plugin-sdk`** (TypeScript, published to npm): typed manifest builder, request signature check, handlers for events, providers and tools on top of Hono, a typed client for the LogiStack API generated from our OpenAPI document.
- **`logistack-plugin` CLI:** `init` (from a template repo), `dev` (runs locally and registers as a dev-URL install), `test` (the same contract test CI runs), `build` (image with the manifest label).
- One or two reference plugins written by us, to prove each contribution type (a DNS provider and an event-to-chat hook).
- A docs-site section: concepts, manifest reference, contract reference, publish guide.

## Phases

| phase | content | done when |
|---|---|---|
| 0. Community templates | Templates index from an external repo, same signing and Refresh model. Data only. | A user installs a template that is not in the release. |
| 1. Runtime + pages | Manifest schema, `plugin_install`, `compilePlugin`, hardening, `ls-plugins` network, scoped token, signed calls, event hooks, settings form, install from image and from dev URL, kill switch, audit actor. UI pages: proxy with CSP sandbox, bridge, bridge storage, session tokens, sidebar and service-tab routes, CSS kit. SDK v0 (server + `plugin-ui`) and CLI `init/dev/test`. | A self-built plugin posts each failed deploy to a niche chat tool and shows a sidebar page plus a service tab, installed through the wizard; opening its page URL directly in a tab cannot read the dashboard's cookies. |
| 2. Contributions | Provider proxy (DNS, notify, secrets, backup), tools in Agent and MCP. | A plugin DNS provider issues a wildcard certificate through DNS-01. |
| 3. Marketplace | Index Worker + D1 with publisher accounts, submit form and `publish` CLI, review pipeline and admin queue, signed responses; marketplace UI in LogiStack, verified badge, private indexes, updates with permission diff, instance policy. | A third party publishes a plugin and another instance installs and updates it end to end. |
| 4. Extensions | Deploy gates, egress allowlist proxy, Automations nodes, project-tab pages. | |

## Risks

- **Supply chain.** A verified plugin's new version can be malicious. Mitigation: digests only, explicit updates, permission diffs, re-review for verified, a scan on every version.
- **Abuse of granted scopes.** A plugin with `services:write` can deploy anything. The review screen must say this in plain words; destructive operations need a `destructive` scope, as in the Automations plan.
- **Plugin pages.** Opaque origins break code that touches `localStorage` or cookies without a guard; the bridge storage, the sandboxed dev server and the review check reduce it, the docs must say it plainly. Phishing inside a page is limited by the fixed host header and review, not prevented.
- **Contract churn.** Version the contract (`/v1`) from day one and declare compatibility in `logistack`.
- **Cost.** One container per plugin per org. Fine for self-hosted; document the resource caps.
- **Maintenance of the index.** Reviewing submissions, moderation and the publisher accounts are ongoing work for us, and the index API is one more service to keep up. Losing its signing key means a release with a new public key, as with sponsors.

## Decisions

- 2026-11-08: installers are the instance admin and members with the `plugins` permission action.
- 2026-11-08: no paid plugins for now.
- 2026-11-08: the index is an API on stack.logicaltech.it, not a git repo.
- 2026-11-08: UI pages ship in phase 1, with the runtime.

## Open questions

None for now.

## Implementation status (2026-11-08, branch `feat/plugins`)

Built:

- Contract: `packages/contracts/src/plugin.ts` (manifest, page bridge messages, user claims, policy, storage limits). Permission action `plugins`.
- Data: `plugin_install`, `plugin_ui_storage`, `instance_settings.plugin_policy` (migration 0059, additive).
- Runtime: `compilePlugin` (`packages/core/src/plugin.ts`, snapshot-tested), `reconcilePlugins` in the worker every 30 s and on change, overlay `ls-plugins` attached to the api and worker. Tested on a real Swarm (`apps/worker/test/plugins.integration.test.ts`, `PLUGINS_IT=1`).
- Calls: `callPlugin` and `pluginHeaders` in `packages/providers/src/plugin.ts`. Events reach subscribed installs through the notification dispatcher, with its retries and dedupe.
- API (`apps/server/src/routes/plugins.ts`): inspect, install, update (settings, kill switch), uninstall, test, session token, page storage, policy, tools list and run, and `GET /plugins/self` for a plugin's own settings.
- Page proxy: `apps/server/src/plugin-proxy.ts`.
- SDK v0 and CLI: `packages/plugin-sdk` (`init`, `dev`, `test`, `build`), reference plugin `examples/plugins/deploy-notifier`.
- Tools (phase 2): `GET /plugins/tools`, `POST /plugins/{id}/tools/{name}` and `/destructive`. The Agent and MCP reach them as ordinary API operations; destructive ones need `delete`, MCP `confirm` and Agent approval.
- End-to-end test: `apps/server/test/plugins.test.ts`.
- Phase 3, index side: the Worker in `plugin-index/` (D1, magic-link publishers, API tokens, register and submit, admin queue, reports, install pings, signed `GET /v1/index` and `GET /v1/plugins/{id}`; format in `plugin-index/README.md`), the verifier `packages/core/src/plugin-index.ts`, the payload schemas at the end of `packages/contracts/src/plugin.ts`, and `logistack-plugin publish`. Not deployed.

Decisions taken while building:

- **Settings reach the plugin through `GET /api/plugins/self`** with its own key (cached 30 s by the SDK), not in every signed request. One path for events, tools and pages; a settings change needs no restart.
- **The plugin's permissions are a role `plugin:<id>`** held by its service account. The colon keeps it out of the custom-role namespace; `GET /roles` hides it.
- **Static page files are served without a session.** An opaque-origin page sends no cookies with its subresource requests, so a cookie check would break every script and stylesheet. Only `/ui/api/*` reaches plugin data, and it needs the session token. The install id in the URL is not a secret.
- **The session token is signed with a key derived from `BETTER_AUTH_SECRET`**, carries the viewer's actions on the page's context, and is bound to one install. It is not accepted by `/api`.
- **The signature covers the forwarded user claims**: HMAC over `<timestamp>.<claims>\n<body>`, so a captured request cannot be replayed with other claims.
- **Dev URLs go through the SSRF guard**; plain http is allowed only to a private address when the instance allows private hosts.
- **Plugin images must own `/data`** (`RUN mkdir /data && chown <user> /data`): the root is read-only and a new volume copies the mountpoint's owner. The `init` template does it.
- **Uninstall keeps the data volume.** Reinstalling finds its state; removing it is manual for now.
- **The review pipeline is split.** A Worker cannot pull or run images, so on submit it checks only what it can: the manifest (strict at the top level, so payment-shaped keys are refused), the digest form, and the registry manifest plus config blob of every linux image, compared with the submitted manifest and checked against their digests. Access is anonymous, so only public images are listed. The contract test and the trivy scan run in a GitHub Actions job (`plugin-index/ci/review.yml`, an example, not enabled) that attaches its results to the version. Only an admin changes the status.
- **Publishers sign in with a magic link** through Resend, as the sponsors Worker sends mail. There is no password to store and no OAuth app, and sponsors has no OAuth precedent. The CLI and CI use API tokens created on the dashboard.
- **The signed envelope carries the payload as a string** (`{keyId, payload, signature}`), so verification runs over the exact bytes with no canonicalization. `keyId` is the raw public key, so rotation means shipping the new key next to the old one.
- **Suspending a publisher yanks their listed versions**, so servers learn of it at their next Refresh through the same yanked list.
- **Install pings carry a random per-install id** and are counted as distinct ids seen in the last 30 days. The index stores no IP address.

Not built yet:

- Phase 0 (community templates index).
- Phase 2 providers. Design for DNS: rows of kind `plugin` with `plugin_install_id` and `plugin_provider` columns, a proxy implementing `DnsProvider` over `POST /v1/providers/dnsProviders/{name}/{op}`, and DNS-01 through the `caddy-dns/acmeproxy` module pointed at an api endpoint that forwards `present`/`cleanup` to the plugin. Notification channels, secret providers and backup destinations follow the same row shape.
- Phase 3, server side: the marketplace UI, fetching and caching the index in `plugin_index`, the verified policy, updates with a permission diff, and sending opt-in pings. On the index: deploying it and filling `PLUGIN_INDEX_KEYS`, unsuspend and un-yank, pruning old pings, rate limits beyond one sign-in link a minute per address, and private registries. Phase 4.
- Token rotation on update, `logistack` version range enforcement, project-tab pages, the review pipeline's headless page check, publishing the SDK to npm (it imports the private contracts package today).

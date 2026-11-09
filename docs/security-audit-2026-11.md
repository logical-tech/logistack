# Security audit, November 2026

Full audit of the `develop` branch on 2026-11-09. Nine read-only audits ran in parallel, one per area:
authentication; authorization, in two halves; injection and RCE; SSRF; agent, worker, proxy and plugins;
the browser; secrets and supply chain; MCP, AI and public endpoints. Each finding was checked against the
code before it was fixed. Nothing is committed yet.

## Summary

All critical, high and medium findings are fixed. Three findings are only mitigated (see "Mitigated,
with limits"). After this release, rotate the secrets listed under "After deploying".

## Critical

1. **Dockerfile builds reached the control network.** BuildKit ran on `ls-control`. A `RUN` step could
   read Caddy's admin API (no authentication), which holds the Redis password and every organization's
   DNS tokens, replace the whole proxy config, and then forge terminal tickets in Redis. **Fixed:**
   BuildKit now runs on a dedicated `ls-build` network that only the worker joins. Existing installs are
   moved automatically (`apps/worker/src/build.ts` `ensureBuildNetwork`, `install/stack.yml`). There is
   now one BuildKit per organization, pinned to the worker's node, because rootless BuildKit has no
   process sandbox and a shared daemon exposes processes and cache between tenants. Integration test
   against a real Swarm: passes.
2. **Symlinks in the repository read the worker's secrets.** A symlink such as `l -> /run` combined with
   `context: l/secrets` exposed `master_key` and `postgres_password` to the build. **Fixed:** after the
   clone, every tracked symlink must resolve inside the checkout (`assertSymlinksInside`, with a test).
3. **A developer got root on the nodes through GitOps.** The GitOps actor inherited the owner's
   instance-admin flag, so a manifest could request a bind mount of `/`. **Fixed:** the GitOps actor
   never carries `instanceAdmin`, and `guardHostSettings` refuses host settings coming from GitOps.
4. **Caddy placeholder injection.** An error page or maintenance message containing
   `{file./config/caddy/autosave.json}` or `{env.*}` was expanded by Caddy, which handed the full proxy
   config to the tenant. Verified on a real Caddy 2.11.7. **Fixed:** braces are escaped in every response
   body, paths may not contain braces, and Caddy no longer writes its config to disk (`persist: false`).
   Covered by tests.
5. **Anyone could sign up and create an organization.** The better-auth `/organization/create` endpoint
   was open. **Fixed:** an allow-list sits in front of `/api/auth/*`. The `organization/*`, `admin/*` and
   `api-key/*` families accept only the six endpoints the browser needs (accept, reject and get
   invitation, list, set-active, list invitations). That also closes four other holes: an API key created
   to bypass two-factor, a role named `x,owner`, impersonation, and `update-user` editing a user's role.
6. **The Agent ran writes with no approval.** Only DELETE and stop/restore were gated. A guest's comment
   read by the model could trigger `api_key_create` or `secret_reveal` plus a webhook. **Fixed:** every
   non-GET operation needs approval, and tool output reaches the model marked as untrusted data.

## High (all fixed)

- An API key narrowed to scopes could reach the owner's full grants through the Agent. The Agent now
  accepts only session credentials, and its runs enforce two-factor.
- A narrowed key could rotate the owner's unscoped key. A narrowed key can now rotate or delete only
  itself.
- Hostname takeover across organizations, by path prefix or by an exact host under someone else's
  wildcard, or with a custom certificate. Fixed by `assertHostnameFree`, which also protects the dashboard
  hostnames and status pages.
- A developer could rewrite or delete any DNS record in a zone, including through a forged
  `dnsRecordId`.
- Root on one node could impersonate another node, the manager included. Re-enrolling a node that already
  has a token now answers 409.
- Org admins could reach the shared nodes in four ways: host schedules, adopting other tools' volumes,
  Tailscale on every node, and local backup folders. Each now requires an instance admin.
- A tenant registry's redirect could delete Caddy's config (image retention SSRF). Now guarded with
  `pinnedFetch`.
- CSRF from same-site origins: every `*.sslip.io` host on a default install, or a sibling subdomain.
  Cookie-authenticated writes and WebSocket upgrades now require the dashboard's origin.
- The terminal now re-checks `exec` on the service when the ticket is redeemed.

## Medium and low (fixed)

- `X-Forwarded-For` was spoofable, so sign-in brute force was unlimited. Caddy now sets
  `X-Logistack-Client-Ip` from the connection, and the API trusts it only from the control network. There
  is also a per-account limit on sign-in.
- Gateway budgets could be bypassed with a negative `max_tokens` or with an unpriced model. A capped
  member is now refused when a model has no known price.
- Unmarking a variable as secret no longer reveals it. Restoring over the same database needs admin.
  Database rows, documents and Redis values need `read:secrets`. Config file contents need `read:secrets`.
- External secret references (`secret://vault/...`) need admin on the organization.
- Schedules re-check the target service when edited or run. Git providers are checked against the
  organization.
- SSO: an email domain held by another organization is refused. Discovered endpoints must use https and
  pass the SSRF check.
- Adding an existing user by email requires a verified email. The owner created by setup counts as
  verified.
- Stored SSRF through forward_auth; SSRF through SMTP; the control subnet is now blocked even when
  private hosts are allowed; IPv6 `::/96` and SIIT ranges are covered; plugin manifests are read through
  the guard; the egress proxy always blocks link-local addresses.
- Security headers on every response (nosniff, SAMEORIGIN, Referrer-Policy, HSTS over https), a CSP on
  the app shell with the inline script hashed, and `__Secure-` session cookies in production
  (`SECURE_COOKIES`).
- Smaller fixes: status pages leaking monitors or dashboard hosts; managed certificate names visible
  across organizations; CR not escaped in the iCal feed; ClickUp import leaking the member directory;
  log-drain tests runnable on another organization's node; folders moved to the top level; the TeamSpeak
  key needed only `write`; share links not bound to the share password; storage share tokens without
  AAD; example keys accepted in production; plugin containers without `NoNewPrivileges`; plugin
  signatures not bound to method and path; plugins able to send `Clear-Site-Data`; no CPU or memory
  limits on schedules; wider audit redaction; `javascript:` URLs allowed in plugin and template metadata.

## Mitigated, with limits

- **WebDAV backups**: rclone still dials by name and follows redirects; it has no option to disable
  either. SFTP now dials the checked IP.
- **Ephemeral schedules** now have CPU and memory limits but still run on the default bridge network,
  which can reach 169.254.169.254.
- **SSO**: a domain belongs to the first organization that registers it, with no DNS TXT verification.

## Networks shared between tenants (fixed in a second pass)

Before the fix, every organization's public apps shared `ls-ingress`, and its storage and game services
shared `ls-storage` and `ls-game`. One organization's container could reach another organization's app at
`ls-svc-<id>:<port>`, skipping Caddy's basic auth, IP rules and forward auth.

Each organization now has its own `ls-ingress-<hash>`, `ls-storage-<hash>` and `ls-game-<hash>`
networks, alongside the per-organization database network that already existed (`apps/worker/src/apply.ts`
`ensureOrgNetwork`). The shared networks now carry only Caddy, tunnels and the local registry.
- **Caddy** joins each organization's ingress network.
- **The api and the worker** join each storage network.
- **The api** joins each game network.
- **Live services** are moved by the reconciler, with one rolling update each.
- **At boot**, the worker reattaches the control plane to every existing organization network, because
  `docker stack deploy` resets the specs.

The cost: the first public service an organization deploys restarts Caddy once. Caddy runs in global
mode with host ports, so stop-first, a few seconds. The first storage or game service restarts the api
and the worker the same way. Integration test on a real Swarm:
`apps/worker/test/org-networks.integration.test.ts` (3 pass).

## Behaviour changes to be aware of

- Every Agent write asks for approval, and the Agent is no longer available to API keys.
- Viewers no longer read database rows or config files without `read:secrets`.
- Existing storage share links, work share unlock cookies and sessions stop working after the deploy
  (new token formats and the `__Secure-` cookie names).
- Plugin SDK 0.2.0: the v2 signature covers method and path. The server still sends v1 for one release.
- Adding password users by email now requires an invitation, because there is no email verification
  flow.
- A forward-auth URL can no longer point at internal `ls-*` names or at the control network.
- A capped member is refused when a model has no known price.

## After deploying

If an instance was multi-tenant before this release, assume the Caddy config was readable. Rotate:
- the Redis password;
- the organizations' DNS-provider tokens;
- the ZeroSSL EAB credentials;
- the acme-proxy passwords;
- the agent enrollment token.

## Tests

- Packages: core 821, contracts 47, providers 199, plugin-sdk 1, proxy 68 (including the integration
  tests against real Caddy). All pass, 0 fail.
- Worker unit tests: 97 pass. The BuildKit build integration test on a real Swarm passes.
- Server: full suite 717 tests; the only 2 failures came from a security header overwriting
  `no-referrer` on share pages, now fixed, and that file passes again.
- Worker integration on a real Swarm (`worker`, `rolling-update`, `storage`): 12 pass. One fails, "redeploy
  with new env rolls start-first", and it fails the same way without these changes.
- Typecheck: clean apart from the missing `sharp` module, which predates these changes.

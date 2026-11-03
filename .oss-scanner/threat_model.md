# LogiStack threat model

## What LogiStack is

LogiStack is a self-hosted PaaS. It deploys applications, databases, and scheduled jobs on Docker Swarm, on servers that the operator owns. One installation is one Swarm stack:

- `logistack-api` (`apps/server`) is the Hono API. It serves REST, OpenAPI, WebSocket, MCP, public webhooks, and the dashboard (`apps/web`).
- `logistack-worker` (`apps/worker`) runs BullMQ jobs: git clones, BuildKit builds, deployments, backups, schedules, certificate checks, and the reconciler. It mounts the Docker socket.
- `logistack-agent` (`apps/agent`) runs once per node, mounts the Docker socket and host `/proc`, `/sys`, and `/`, and dials the API over WebSocket.
- `caddy` terminates TLS on ports 80 and 443. The worker configures it through the Caddy admin API, which listens only on the `ls-control` overlay network.
- `postgres` holds the desired state. `redis` holds queues and the event bus. Both are reachable only on `ls-control`.

Desired state lives in Postgres. Pure compilers turn it into Docker service specs (`packages/core/src/compile-service.ts`) and Caddy JSON (`packages/proxy`). The reconciler converges Docker and Caddy to that state.

## Trust boundaries

1. **Internet to Caddy to the API.** Anyone can reach Caddy. Caddy forwards the dashboard hostname to `logistack-api:3000`. Before setup completes, a catch-all route sends every host to the API, and `/setup` is open to the first visitor.
2. **Authenticated users.** better-auth issues sessions (password, passkey, TOTP, OIDC, SAML). Every route checks `can(actor, action, resource)` from `packages/core/src/permissions.ts`. Actions are `read`, `read:secrets`, `deploy`, `exec`, `write`, `delete`, and `admin`. Grants attach to a scope (organization, folder, project, environment, service) and apply to everything below it. Built-in roles are `owner`, `admin`, `developer`, and `viewer`. Custom roles exist.
3. **API keys.** Keys belong to a user or to a machine account. A key can carry scopes narrower than its owner's grants, never wider.
4. **Node agents.** The agent first presents the shared enrollment token (`logistack-agent-token` secret) and its Swarm node id. The server answers with a per-node `lsn_` token, stored hashed, and the agent uses that token afterwards. A revoked node gets 403. The server sends the agent jobs, exec sessions, and log requests over this connection, so a forged agent must not be able to read another node's traffic or impersonate the server.
5. **Git provider webhooks.** `POST /api/webhooks/git/{providerId}` is public. The provider's HMAC signature, or GitLab's secret token, authenticates it. An authentic push queues deployments of the services that track the branch.
6. **The worker and the agents hold the Docker socket.** Socket access is root on the host. Anything that makes the worker or an agent run attacker-chosen containers, mounts, or capabilities is host compromise.

## Where untrusted input enters

- **HTTP API and WebSocket.** Request bodies are parsed with zod at the route. Service specs (`packages/contracts/src/service-spec.ts`) control image, command, ports, mounts, user, capabilities, and placement. Adding or changing bind mounts (`allowSensitiveHostPath` included) or capabilities beyond Docker's defaults needs `admin` (`apps/server/src/host-settings.ts`).
- **Webhooks.** Payloads from GitHub, GitLab, Gitea, Bitbucket, and generic providers.
- **Compose and template imports.** The Dokploy importer (`apps/server/scripts/import-dokploy.ts`, `dokploy-compose.ts`) parses compose YAML, `.env` files, and Traefik labels. It refuses keys it does not map.
- **Git repositories.** The worker clones the repository and builds it with rootless BuildKit (`ls-buildkit`) through a Dockerfile or railpack. Build steps run attacker code inside BuildKit. Build output and logs flow back to the dashboard.
- **Schedules.** A schedule runs a user script in an ephemeral container, inside a service (needs `deploy`), or on the host as root (needs `admin`).
- **Outbound URLs that users configure.** S3 endpoints, git provider and registry URLs, OIDC issuers, DNS provider APIs, and notification webhooks (Slack, Discord, Teams, Mattermost, ntfy, Gotify, generic webhook). These requests go through the SSRF guard (`apps/server/src/ssrf.ts`, `apps/worker/src/ssrf.ts`). The guard resolves the name once, rejects private, loopback, link-local, metadata, and other non-public ranges, and pins the connection to the checked address. An instance owner can turn on `allowPrivateHosts` in Settings.
- **Domains.** Hostnames and path prefixes that users enter reach the Caddy config compiler.
- **Logs and container output.** The dashboard renders deployment logs, build logs, and container exec output.

## Key assets

- `LOGISTACK_MASTER_KEY`. It encrypts every stored secret with AES-256-GCM: env vars, registry passwords, SSH keys, git provider and DNS credentials, S3 secrets, and notification configs. It lives in a Docker secret and in `/etc/logistack/credentials` (mode 600).
- The Docker socket on every node.
- The agent enrollment token and the per-node tokens.
- `BETTER_AUTH_SECRET`, user sessions, and API keys.
- The Postgres and Redis passwords.
- Swarm join tokens, which the installer writes to `/var/log/logistack-install.log` (mode 600).
- The audit log, which is append-only.

## Severity guidance

| Finding | Severity |
| --- | --- |
| Unauthenticated RCE, or auth bypass that reaches any write route | Critical |
| RCE on the host or the Docker socket from a non-admin role (`developer`, `viewer`, a scoped API key) | Critical |
| Reading the master key or decrypted secrets without `read:secrets` on that scope | Critical |
| A forged or revoked agent that receives another node's jobs, exec sessions, or secrets | Critical |
| Webhook signature bypass that triggers deployments | High |
| SSRF that reaches cloud metadata, `ls-control` (Caddy admin, Postgres, Redis), or loopback while `allowPrivateHosts` is off | High |
| Stored XSS in the dashboard, for example through service names, logs, or build output | High |
| Privilege escalation across scopes or organizations (a grant on one project acting on another) | High |
| Escape from a BuildKit build or an ephemeral schedule container to the host | High |
| Taking over `/setup` after setup has completed | High |
| Secret values in logs, audit diffs, API responses, or argv | Medium |
| CSRF on a state-changing route | Medium |
| Reflected XSS that needs user interaction | Medium |
| Information disclosure that needs `read` on the same scope | Low |
| Issues that need `admin` or `owner` | Low, unless they escalate beyond the host LogiStack runs on |

`admin` and `owner` are root-equivalent by design. They can bind-mount host paths and run host schedules as root. A finding that needs these roles matters only when it escapes the servers that LogiStack manages, for example by reaching another tenant, a cloud account, or a machine outside the swarm.

## Out of scope

- The behaviour of the applications that users deploy, and the content of their images.
- Bugs in Docker, Caddy, BuildKit, Postgres, Redis, or Bun themselves. Unsafe use of them by LogiStack is in scope.
- An attacker with root on a node, or with access to `/etc/logistack/credentials`.
- Ports that Docker publishes past UFW or firewalld.
- The unauthenticated `/setup` route on a fresh install before the owner completes it. The installer prints the URL to the operator, and the window is expected.
- The shared Let's Encrypt rate limit on sslip.io and nip.io hostnames.
- Volume-based denial of service and missing rate limits without a concrete impact.
- Test files, `docs/spikes`, and development-only files such as `docker-compose.dev.yml` and `.env.example`.

## Reports and patches

Send one finding per report with the file, the route or job, and a minimal reproduction. Patches follow the repository rules in `CLAUDE.md`: parse input with zod at the boundary, never build shell strings, and add a test with the fix.

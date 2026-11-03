# Spike: production images and Swarm stack, end to end

Date: 3 Nov 2026. Machine: Apple Silicon Mac, OrbStack, host Docker 29.8.2. The test daemon is `docker:29-dind` (Docker 29.9.2, linux/arm64, no AppArmor), so the host swarm is never touched.

Rerun with `bash install/smoke.sh` (`KEEP=1` keeps the container). It starts the privileged container `ls-test-pkg-dind` (label `logistack.test=pkg`) with the checkout mounted read-only at `/src`. Inside it runs `install.sh --local-build --yes --advertise-addr <dind ip>`, then the API steps below, then removes the container. A helper container `ls-test-pkg-client` lives inside the dind daemon only.

## Result of the last run

Every step passed except the agent check, which fails as expected because the server does not mount the gateway yet. Total 195 s from an empty daemon.

Update, same day: with the gateway mounted and node-token enrollment, a rerun in `ls-test-bridge-dind` (`SMOKE_NAME=ls-test-bridge-dind SMOKE_LABEL=bridge`) passed every step in 228 s: install 167 s, agent enrolled 10 s after the deploy checks (it backs off up to 30 s while setup is pending), and a forced agent task restart reconnected with its kept token in 31 s.

| Step | Result | Time |
| --- | --- | --- |
| Build `logistack` (api target) | done | 23 s |
| Build `logistack-worker` | done | 13 s |
| Build `logistack-agent` | done | 10 s |
| Build `logistack-caddy` (xcaddy, 7 modules) | done | 96 s |
| Deploy, then all six services n/n and Caddy answering on :80 | done | 24 s |
| `GET /api/health` through Caddy :80 | 200 | <1 s |
| `GET /api/setup/status` | `setupCompleted: false` | <1 s |
| `POST /api/setup`, sslip quick start | 201 | <1 s |
| `POST /api/auth/sign-in/email` with `Origin: https://<host>` | 200, `better-auth.session_token` set | 5 s (includes pulling the client image) |
| `POST /api/projects`, then its environments | 201, default `production` listed | <1 s |
| `POST /api/environments/{id}/services`, `nginx:alpine` | 201 | <1 s |
| `POST /api/services/{id}/deploy` | 202 | <1 s |
| Deployment status | `healthy` | 6 s |
| Swarm service `ls-svc-<id>` | exists with `logistack.managed`, `.kind`, `.org`, `.resource` | <1 s |
| Caddy after the worker's proxy sync | dashboard host answers 308 to https | 2 s |
| Worker process | uid 1000, docker socket group added at start | <1 s |
| Worker `ensureBuildkit`, then `buildctl` Dockerfile build with a `RUN` step | built, image tarball returned | 8 s |
| Migration `0003_node_token` | `node_token` exists | <1 s |
| Agent connected (`ls:nodes:<id>` in Redis) | XFAIL here; passes since the gateway is mounted (see the update above) | <1 s |
| `install.sh --local-build` re-run after setup | passes, no task restarted | 6 s |

## Image sizes

Uncompressed, as `docker image inspect` reports them on linux/arm64.

| Image | Size |
| --- | --- |
| `logistack` (api) | 493 MB |
| `logistack-worker` | 714 MB |
| `logistack-agent` | 211 MB |
| `logistack-caddy` | 170 MB |

The api and the worker stay separate targets. The worker adds 221 MB for `git` (108 MB with its Debian dependencies) and the pinned `buildctl` and `railpack` binaries (55 MB). That is 45% of the api, which never runs them. The api's runtime install keeps only `@logistack/server` and `@logistack/worker` dependencies, which cut it from 590 MB to 493 MB; 222 MB of that is `node_modules` and 103 MB the bun binary.

## BuildKit under Swarm

| Variant | Daemon starts | `RUN` step |
| --- | --- | --- |
| Stack, rootless image, `security_opt: [seccomp=unconfined, apparmor=unconfined]` | No. `stack deploy` prints "Ignoring unsupported options: security_opt"; rootlesskit fails with `fork/exec /proc/self/exe: operation not permitted` | n/a |
| Stack, rootless image, `cap_add: [SYS_ADMIN]` | Yes | Fails: `unable to join session keyring: unable to create session key: operation not permitted` (default seccomp blocks `add_key`) |
| Stack, rootful image, `cap_add: [SYS_ADMIN]` | No, exits 1 | n/a |
| Engine API, rootless, `Privileges.Seccomp=unconfined`, `AppArmor=disabled` (the worker's `ensureBuildkit`) | Yes | Dockerfile build and a railpack plan build both succeed |

Swarm has no privileged mode, and the docker CLI has no flag for the service-level seccomp or AppArmor settings (API 1.44+). So BuildKit stays where the worker already puts it, and `stack.yml` documents why. Not verified here: an AppArmor host such as Ubuntu 24.04. The API variant disables AppArmor for the service, which is what BuildKit's rootless docs ask for.

## Findings fixed in the install files

- `stack deploy` with an unchanged tag cannot see a rebuilt image, so `--local-build` tags images `<version>-local.<hash of the four image ids>`. With provenance attestations on, every build got a new id (the attestation carries a timestamp), and a no-op re-run restarted four services. Builds now pass `--provenance=false`.
- After setup, the worker's Caddy config replaces the bootstrap catch-all and routes only the dashboard host. `http://127.0.0.1/api/health` then answers 404, and the installer's final check never passed on a re-run. It now accepts 404 or a redirect once every service is n/n, since the api's own healthcheck gates its replica count.
- The worker's config redirects the dashboard host to https. A browser then sends `Origin: https://<host>` and better-auth answered 403 `INVALID_ORIGIN`, because `BETTER_AUTH_URL` and `WEB_ORIGIN` were both the http install URL. `WEB_ORIGIN` is now the https URL, and better-auth trusts the `BETTER_AUTH_URL` origin as well.
- The api required `WEB_ORIGIN`, which the stack never set.
- On a fresh deploy Caddy restarts about four times before the `redis` name resolves, because the bootstrap config provisions Redis storage at load. Swarm's restart policy converges in under 30 s, so this stays as is.

The smoke test's setup uses `letsencryptEmail: ops@smoke.test`. After setup Caddy asks Let's Encrypt production for a certificate for the real public IP's sslip.io name. The `.test` contact makes the ACME account registration fail first, so no order is placed and none of sslip.io's shared weekly budget is used.

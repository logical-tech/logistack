# Spike: Caddy ingress (Phase 0)

Date: 3 Nov 2026. Machine: Apple Silicon Mac, OrbStack, Docker 29.8.2, single-node Swarm. Caddy 2.11.7 built from `docker/caddy/Dockerfile` (`ls-test-caddy`).

Every number below comes from `packages/proxy/spike/proxy-spike.ts`. Rerun it with `bun packages/proxy/spike/proxy-spike.ts all`. It creates two Caddy containers, one Redis and one upstream on the bridge network `ls-test-proxy-net`, all named `ls-test-proxy-*` with label `logistack.test=true`, and removes them by exact name at the end. Each spike also runs alone (`setup`, then `shared`, `zero 20`, `invalid`, `features`, `deadlock`, `timing`, `dns`, `psl`, then `cleanup`).

All configs come from `compileProxy()`. The spike swaps every issuer for Caddy's internal CA, so no public ACME server is contacted. Hostnames use `.test` and are reached with `curl --resolve`.

## Summary

| Question                                   | Result                                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Image builds with all modules              | Yes. `caddy list-modules` shows the 6 DNS providers and `caddy.storage.redis`                   |
| Certificates shared through Redis          | Yes. Instance 2 served the same serial as instance 1 and logged no issuance                     |
| Failed requests during 20 reloads          | 5 of 2,130 new connections (0.23%), 0 of 12,289 keep-alive requests. 0 failures without reloads |
| Invalid config                             | Rejected with HTTP 400, error body surfaced by `CaddyAdmin`, old config keeps serving           |
| `/load` latency, 10 / 1,000 / 5,000 routes | Median 4 / 28 / 121 ms (HTTP routes), 9 / 33 / 120 ms (HTTPS routes)                            |
| `/load` deadlock from PIANO §3.3           | Does not reproduce on 2.11.7. `/load` called from inside a proxied request returned in 2 ms     |
| sslip.io, nip.io, traefik.me in the PSL    | None of the three is listed                                                                     |

## 1. Image and module choice

`docker/caddy/Dockerfile` builds Caddy v2.11.7 with `xcaddy` in `caddy:2.11.7-builder-alpine` and copies the binary onto `caddy:2.11.7-alpine`. Every module is pinned:

| Module                                   | Version                                            |
| ---------------------------------------- | -------------------------------------------------- |
| `github.com/caddy-dns/cloudflare`        | v0.2.4                                             |
| `github.com/caddy-dns/route53`           | v1.6.2                                             |
| `github.com/caddy-dns/hetzner/v2`        | v2.0.1 (`/v2` module path)                         |
| `github.com/caddy-dns/digitalocean`      | commit `04bde28` (June 2025; the repo has no tags) |
| `github.com/caddy-dns/ovh`               | v1.1.0                                             |
| `github.com/caddy-dns/porkbun`           | v0.3.1                                             |
| `github.com/pberkel/caddy-storage-redis` | v1.9.0                                             |

`caddy list-modules --versions` on the built image prints `caddy.storage.redis v1.9.0`, `dns.providers.cloudflare v0.2.4`, `dns.providers.digitalocean v0.0.0-20250606074528-04bde2867106`, `dns.providers.hetzner v2.0.1`, `dns.providers.ovh v1.1.0`, `dns.providers.porkbun v0.3.1` and `dns.providers.route53 v1.6.2`.

**Redis storage: `pberkel/caddy-storage-redis`.** It is the maintained rewrite of `gamalan/caddy-tlsredis`, which was archived in 2024. Its last push was 8 Oct 2026 and v1.9.0 targets Caddy 2.11. It locks with `bsm/redislock`, supports Sentinel and Cluster for a later HA Redis, offers at-rest encryption (`encryption_key`) and compression, and indexes keys in sorted sets so listing certificates does not `SCAN` the keyspace. Redis is already in the stack for BullMQ, so this storage adds no service. The Postgres and S3 storage modules would work too, but Redis keeps the lock latency low and matches PIANO §4.1.

Superseded at integration: `docker/caddy/entrypoint.sh` binds the admin API to the task's own `ls-control` IP (not `0.0.0.0`, which `ls-ingress` apps could reach) and boots a catch-all to the api. No `--resume`, because a restarted task gets a new IP. The worker compiles one config per Caddy task with `adminListen = <task ip>:2019` and storage `key_prefix: "caddy"`, and re-syncs whenever a new Caddy task appears.

**DNS credential field names are checked against the real modules.** The `dns` spike runs `caddy validate` (no network, file storage) on a compiled wildcard config for each provider with the field names typed in `DnsChallenge`. All six validate. A negative control with `api_tokn` fails with `json: unknown field "api_tokn"`, which proves Caddy decodes provider configs strictly and that the check can fail.

## 2. Shared certificates through Redis

Procedure: load a config with `shared.test` on caddy1, wait for its TLS handshake, then load the same config on caddy2 and handshake there.

|                                                     | caddy1                             | caddy2                             |
| --------------------------------------------------- | ---------------------------------- | ---------------------------------- |
| Serial                                              | `F3458F1BE471BA6C2FB43C3048DF5D98` | `F3458F1BE471BA6C2FB43C3048DF5D98` |
| SHA-256 fingerprint                                 | `49:2A:1E:9B:...:54:0E`            | same                               |
| `obtaining certificate` log lines for `shared.test` | 1                                  | 0                                  |
| `certificate obtained successfully`                 | 1                                  | 0                                  |

After caddy1 issued, Redis held `ls-test/certificates/local/shared.test/{crt,key,json}` and the internal CA under `ls-test/pki/authorities/local/`. caddy2 only logged `enabling automatic TLS certificate management` and served the stored certificate (HTTPS 200). The internal CA itself is shared too, so every instance signs with one root.

## 3. Zero-downtime reloads

Procedure: caddy1 serves `app.test` (HTTPS) and `plain.test` (HTTP). Four clients run at once. Three loops spawn a fresh `curl` per HTTPS request (new TCP and TLS each time), one loop spawns `curl` per plain HTTP request, and one Bun `fetch` loop reuses keep-alive connections. Meanwhile the loader POSTs `/load` 20 times, 250 ms apart, each config adding one more route so every load is a real reload. The run lasted 5.1 s.

| Client                          | Requests | Failed                                   |
| ------------------------------- | -------- | ---------------------------------------- |
| curl HTTPS, new connection each | 1,455    | 2 (`curl: (35) SSL_ERROR_SYSCALL`)       |
| curl HTTP, new connection each  | 675      | 3 (`curl: (52) Empty reply from server`) |
| fetch, keep-alive               | 12,289   | 0                                        |

The 20 loads took 2 to 9 ms each. The final running config had 23 HTTPS routes, so all 20 loads applied.

Controls and repeats: two runs with 0 reloads had 0 failures in 2,000 HTTPS requests each. Nine earlier runs with 20 reloads (while the script was being built) failed 4, 0, 1, 1, 2, 1, 0, 2 and 3 new connections. Failures happen only with reloads, only on new connections, at 0 to 5 per 20 reloads.

Cause (inferred, mechanism read in source): on Linux Caddy binds every listener with `SO_REUSEPORT` (`listen_unix.go`, `listenReusable`), so a reload opens a new socket next to the old one and then closes the old one. Linux resets connections still queued in a closed reuseport socket's accept backlog. That matches the symptom: connections that were mid-handshake when the old socket closed get a reset, while established keep-alive connections finish on the old server. Not tested on a non-OrbStack Linux host.

What it means for us: each reload costs a handful of fresh connections under load. Coalescing pushes (`coalesce()`, about 1 s window) bounds reloads to at most one per window no matter how many domains change. Swapping `/load` for `PATCH` by `@id` would not help, because Caddy reloads the whole config on any change.

## 4. Invalid config

Procedure: load a good config, then the same config with one handler replaced by an unknown module.

`CaddyAdmin.load()` threw `CaddyAdminError` with `failure = { kind: "http", status: 400, body }` and the body is Caddy's own message:

```
{"error":"loading config: loading new config: loading http app module: provision http: server https: setting up route handlers: route 1: loading handler modules: position 0: loading module 'no_such_handler': unknown module: http.handlers.no_such_handler"}
```

`GET /config/` afterwards was structurally equal to the good config (Caddy re-serializes with sorted keys, so the spike compares with `Bun.deepEquals`), and `app.test` still answered 200. A broken custom certificate fails the same way (`loading certificates: PEM pair 0: x509: invalid ECDSA parameters`, seen while building the `features` spike). The `ProxySync` caller can therefore store the body on the domain and keep the old config live.

## 5. `/load` timing and memory

Procedure: on caddy2, for N routes, push 6 configs that differ by one toggled route (Caddy skips a byte-identical config, so each sample is a real reload) and time `CaddyAdmin.load()` from the host. For HTTPS routes the spike waits 2 s (10 routes) or 20 s (1,000 and 5,000) after the first load so internal issuance settles before the next samples. Memory is `docker stats` usage of the container after the 6 loads.

| Routes | Kind  | Config size | 1st load | Median of loads 2-6 | Range 2-6  | Memory after |
| ------ | ----- | ----------- | -------- | ------------------- | ---------- | ------------ |
| 10     | HTTP  | 4 KiB       | 8 ms     | 4 ms                | 3-9 ms     | 14 MiB       |
| 1,000  | HTTP  | 171 KiB     | 68 ms    | 28 ms               | 24-32 ms   | 47 MiB       |
| 5,000  | HTTP  | 854 KiB     | 161 ms   | 121 ms              | 115-144 ms | 157 MiB      |
| 10     | HTTPS | 4 KiB       | 23 ms    | 9 ms                | 5-15 ms    | 157 MiB      |
| 1,000  | HTTPS | 189 KiB     | 50 ms    | 33 ms               | 30-59 ms   | 97 MiB       |
| 5,000  | HTTPS | 951 KiB     | 168 ms   | 120 ms              | 118-186 ms | 283 MiB      |

Reading the numbers:

- Load time grows linearly, about 24 µs per route, which is provisioning one route's matchers and handler plus JSON decoding. The 10-route time (3-9 ms) is mostly the HTTP round trip through OrbStack's port forward.
- HTTPS routes do not make `/load` slower. Caddy starts certificate management asynchronously, so `/load` returns before issuance: 5,000 internal certificates were issued in the background (an earlier identical run left 5,214 `.crt` keys in Redis).
- Memory rows run in sequence on one container, so a row includes garbage from earlier configs that Go has not returned yet (the 10-route HTTPS row shows 157 MiB left over from the 5,000-route HTTP row, and later rows drop). Read them as upper bounds. The 5,000-route HTTPS row (283 MiB) also holds 5,000 certificates in the in-memory cache.
- Single run per size, 5 samples each. Good enough to show the scale is not a problem below 5,000 routes. Not a benchmark.

Conclusion: full-config `/load` stays the plan (PIANO §3.3 shortcut). At 5,000 routes a push costs about 120 ms per instance and under 1 MiB of JSON. Revisit only if a single install passes roughly 20,000 routes.

## 6. The `/load` deadlock (PIANO §3.3)

Procedure: route `deadlock.test` on caddy1 to a Bun server on the host, whose handler calls `POST /load` on caddy1 with a changed config and awaits it before answering. curl calls `deadlock.test` through caddy1 with a 60 s timeout.

Result: the `/load` inside the handler returned in 2 ms and curl got 200 in 4 ms. No hang.

Why: in Caddy 2.11.7 `caddyhttp.App.stop` starts the old servers' `Shutdown` in goroutines and only waits for them when the process exits (`modules/caddyhttp/app.go`, `stop`, "we don't really need to wait for the grace period to finish if the process isn't exiting"). A reload therefore no longer waits for in-flight requests.

We keep the rule anyway: `ProxySync` runs only in the worker, behind `coalesce()`, never inline in an API handler. A request-driven push skips coalescing, so every edit becomes a reload that drops a few new connections (section 3), and the API would depend on the proxy it is served through. The `ProxySync` doc comment records this.

## 7. Feature check against real Caddy

The `features` spike loads one compiled config with every route kind and probes it:

| Route                                      | Probe                   | Result                                                                                                                                                        |
| ------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.test` HTTPS                           | `GET /`                 | 200                                                                                                                                                           |
| `app.test` + `pathPrefix: "/api"`          | `GET /api/x`            | 200                                                                                                                                                           |
| `*.wild.test`, DNS-01 policy               | `GET a.wild.test`       | 200, certificate SAN `DNS:*.wild.test`                                                                                                                        |
| `custom.test`, custom cert                 | handshake               | our self-signed serial served, log says `skipping automatic certificate management because one or more matching certificates are already loaded`, 0 issuances |
| `www.test`, `redirectTo: https://app.test` | `GET /foo?x=1`          | 308 to `https://app.test/foo?x=1`                                                                                                                             |
| any HTTPS host over HTTP                   | `GET http://app.test/p` | 308 to `https://app.test/p`                                                                                                                                   |
| `plain.test`, `https: false`               | `GET` over HTTP         | 200                                                                                                                                                           |
| unknown host over HTTP                     | `GET nobody.test`       | 404 page                                                                                                                                                      |
| access log                                 | stdout                  | JSON lines with logger `http.log.access.ls-access`                                                                                                            |

The wildcard probe ran with the internal issuer, so it proves routing and policy selection, not the DNS-01 exchange with a real provider. HTTP-01 is solved by our own `:80` server: Caddy's HTTP server answers ACME challenges before routing (`modules/caddyhttp/server.go`, `HandleHTTPChallenge`). That path is also unexercised here, because it needs a public ACME server.

## 8. Public Suffix List

Fetched `https://publicsuffix.org/list/public_suffix_list.dat` on 3 Nov 2026 (`VERSION: 2026-10-31_14-17-28_UTC`, 336,160 bytes). A case-insensitive substring search found no line containing `sslip.io`, `nip.io` or `traefik.me`. The same search finds `duckdns.org` (positive control).

What it means. Let's Encrypt counts its limit of 50 new certificates per registered domain per week against the registered domain, which the PSL defines. Without a PSL entry the registered domain of `app-1a2b.1-2-3-4.sslip.io` is `sslip.io` itself. Every LogiStack install, and every other sslip.io user in the world, shares one budget of 50 certificates a week. The same holds for `nip.io`. So HTTPS for generated domains (PIANO §6.6) will hit `too many certificates already issued for "sslip.io"` often, and the failure is outside our control.

Recommendation for §6.6:

1. Generated sslip.io / nip.io domains start HTTP-only and offer HTTPS as best effort, surfacing the rate-limit error from `certificate.failed` on the domain.
2. The default for HTTPS is a per-server wildcard (`*.srv1.example.com`) issued once with DNS-01 through a connected DNS provider. One certificate covers every generated subdomain, so its own registered domain's budget is never touched.
3. ZeroSSL as fallback issuer (already supported by `compileProxy`) is an option for sslip.io. Whether ZeroSSL applies a comparable per-domain limit was not checked.

## API surface (`@logistack/proxy`)

- `compileProxy(input: ProxyInput): CaddyConfig`. Pure and deterministic: routes are sorted (dashboard first, exact hosts before wildcards, longest path prefix first, then `domainId`), DNS policies are grouped per identical credential and sorted, and object keys are built in a fixed order. Shuffled input yields byte-identical JSON (tested). Throws on a wildcard without a DNS challenge.
- `ProxyRoute` is a union keyed by `https` and `cert`: `cert: "custom"` requires `customCert`, `dnsChallenge` exists only on `cert: "auto"`, and `https: false` forces `cert: "none"`. `DnsChallenge` is a union per provider with that module's credential fields.
- `CaddyAdmin(endpoint, timeoutMs = 30000)` with `load(config)` and `getConfig()`. Failures throw `CaddyAdminError` with `failure: { kind: "http", status, body } | { kind: "timeout", timeoutMs } | { kind: "network", message }`.
- `ProxySync(endpoints, timeoutMs?)` with `push(config): Promise<InstanceResult[]>`, one result per instance, never throwing.
- `coalesce(fn, windowMs)` batches calls in a window into one call with the last value, resolves every caller with that result, and never overlaps runs, so an older push cannot land after a newer one.

## Risks and open points

- Certificate private keys and the internal CA key sit in Redis in clear text. Set the module's `encryption_key` and keep Redis on the internal network only. Not wired into `compileProxy` yet.
- The admin API has no auth. It must stay on `ls-control` and never be published (PIANO §3.3). `GET /config/` returns DNS credentials and the Redis password.
- Reloads drop about 0.1-0.3% of new connections under load (section 3). Coalescing is the mitigation. Measured on OrbStack only.
- HTTP-01 and DNS-01 against real CAs were not exercised (no public ACME in this spike). The first staging deploy should issue one certificate of each kind against Let's Encrypt staging.
- A hostname with both an HTTPS route and an `https: false` route has its HTTP route shadowed by the HTTP to HTTPS redirect. Contracts should reject mixing the two on one hostname.
- Wildcard without DNS challenge makes `compileProxy` throw, which would block the whole sync. Contracts must reject it at input so it never reaches the compiler.

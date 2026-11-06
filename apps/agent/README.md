# logistack-agent

Per-node agent. It runs as a global Swarm service (`install/stack.yml`) and dials the server at `GET /api/agent/ws`. The protocol, its size limits and its backpressure policy live in `packages/contracts/src/agent.ts`.

## Configuration

Every variable also accepts `<NAME>_FILE`, which wins over the plain variable.

| Variable                       | Default        | Meaning                                               |
| ------------------------------ | -------------- | ----------------------------------------------------- |
| `LOGISTACK_API_URL`            | required       | Server base URL. `http` becomes `ws`.                 |
| `LOGISTACK_AGENT_TOKEN`        | required       | Enrollment token from the installer (see below).      |
| `LOGISTACK_AGENT_TOKEN_PATH`   | `/var/lib/logistack-agent/node-token` | Where the issued node token is kept. |
| `LOGISTACK_NODE_ID`            | required       | Swarm node id (`{{.Node.ID}}`). Requests route by it. |
| `LOGISTACK_NODE_HOSTNAME`      | OS hostname    | Shown in the UI.                                      |
| `HOST_PROC`, `HOST_SYS`        | `/proc`,`/sys` | Host `/proc` and `/sys` mounts.                       |
| `HOST_ROOT`                    | `/`            | Host `/` mount, for statfs on host mount points.      |
| `LOGISTACK_AGENT_METRICS_PORT` | `9469`         | Prometheus `/metrics` on 127.0.0.1. `0` turns it off. |
| `LOGISTACK_AGENT_INTERVAL_MS`  | `10000`        | Heartbeat period.                                     |
| `LOGISTACK_AGENT_METRICS_INTERVAL_MS` | `30000` | Metrics period (one Docker stats call per container). |

## Enrollment

The agent sends its Swarm node id in `x-logistack-node-id` and the enrollment token as a bearer. On the first `hello` the server creates the `node` row and answers `hello.ok` with a per-node `lsn_` token, stored hashed in `node_token`. The agent writes it to `LOGISTACK_AGENT_TOKEN_PATH` (the stack mounts the per-node `agentdata` volume there) and presents it from then on. A 401 on that token makes it fall back to the enrollment token, which the server refuses with 403 `node_revoked` once the node was revoked. Before setup has created an organization the server answers 503 `setup_required`. Every failed attempt is logged with its HTTP status or close code and the backoff; a repeat of the same failure within 30 s is counted instead (`suppressed`).

## Build and run

`bun run --filter @logistack/agent build` writes a single binary to `apps/agent/dist/logistack-agent`. The image build (`install/agent.Dockerfile`) does the same on Linux.

On macOS the compiled binary's ad-hoc signature is invalid as written, and the kernel kills it at exec with exit 137 and no output. Re-sign it before a local run with `codesign --force --sign - apps/agent/dist/logistack-agent`. Production ships Linux binaries in a container and is unaffected. Outside Linux there is no `/proc`, so `metrics.host` is `null`.

## Tests

`bun test apps/agent` runs the unit tests and an integration test that boots the gateway on a Hono app, a Redis container and the agent process against the local daemon. It creates only `ls-test-agent-<run>-*` objects labelled `logistack.test=agent` and removes them by that exact prefix.

`apps/agent/scripts/measure-rss.ts` is the memory soak. It runs the built image on Linux against 10 busy Swarm replicas for `RSS_MINUTES` (default 6) and prints the agent's VmRSS every 30 s.

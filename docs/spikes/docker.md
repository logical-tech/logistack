# Spike: Docker layer (Phase 0)

Date 2026-11-03. Machine: macOS, OrbStack, Docker Engine 29.8.2 (API 1.56, min 1.40), single-node Swarm, Bun 1.4.0.
Every script lives in `packages/docker/spikes/` and is rerunnable. Each one creates only `ls-test-*` objects labelled `logistack.test=true` and removes them before it exits.

## Verdicts

| Question                                                    | Verdict                                                                 | Evidence                             |
| ----------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------ |
| JSON calls with `fetch(url, { unix })`                      | Works                                                                   | `fetch-basics.ts`                    |
| Streaming `/events`, logs, stats with fetch                 | Works, abort via `AbortSignal`                                          | `fetch-basics.ts`, integration tests |
| Interactive exec with fetch                                 | Does not work                                                           | `exec-fetch-duplex.ts`               |
| Interactive exec with `Bun.connect({ unix })` + raw upgrade | Works, including resize and stdin half-close                            | `exec-hijack.ts`, integration tests  |
| dockerode under Bun 1.4                                     | Works, including hijacked exec                                          | scratch run, see below               |
| Swarm `start-first` with healthcheck                        | Zero failed requests over 4 runs of updates                             | `swarm-deploy.ts`                    |
| Automatic rollback on a failing healthcheck                 | Works, about 14 s end to end, detectable from `UpdateStatus` and events | `swarm-deploy.ts`                    |
| Agent memory (events + stats every 10 s)                    | 22.6 to 23.2 MB RSS, flat after the first 2 minutes                     | `agent-memory.ts`, `measure-rss.ts`  |

**Decision.** Our own client (`packages/docker`), no dockerode. Plain calls and streams use Bun `fetch` over the socket. Hijacked connections (exec, later attach) use `Bun.connect` with a hand-written HTTP/1.1 upgrade.

## 1. Engine API from Bun

**Socket path.** `/var/run/docker.sock` is a symlink to `~/.orbstack/run/docker.sock` on this machine. The client defaults to `$DOCKER_SOCKET`, then `/var/run/docker.sock`. That path is also the default on Linux servers.

**JSON and streams over fetch.** `fetch("http://docker/_ping", { unix })` returns `200 OK` with header `api-version: 1.56`. `/events?since&until` streams `application/jsonl` and ends at `until`. A live `/events` stream aborted after 300 ms rejects with `AbortError` 320 ms in, so cancellation works. Container and service logs, `stats?stream=true` and `/images/create` stream the same way. The integration tests cover each one.

**Log demux.** Non-TTY logs and exec output arrive as `application/vnd.docker.multiplexed-stream`. Each frame has an 8-byte header `[stream, 0, 0, 0, size uint32 BE]`. TTY output arrives as `raw-stream`. The client picks the decoder from `Content-Type` and never guesses. `Demuxer` is a pure incremental decoder. Its unit tests feed one packed chunk, then the same bytes one at a time. They cover a split header, a 70 000-byte frame, a non-multiplexed input (rejected) and a truncated stream (rejected).

**Exec over fetch fails.** With a `ReadableStream` request body and `Connection: Upgrade`, Bun returns the `101` response headers in 1 to 5 ms. The request body is not delivered interactively, though. The engine replied with a multiplexed stream even though the start body said `Tty: true`, so the JSON body itself never arrived intact. Input written after the response never produced output, and the read timed out after 5 s. When the whole input is enqueued and the body closed up front, output does come back, but only after close. That makes it a batch call, not a terminal. Conclusion: fetch cannot do duplex hijack.

**Exec over `Bun.connect` works.** A raw `POST /exec/{id}/start` with `Connection: Upgrade` / `Upgrade: tcp` gets `HTTP/1.1 101 UPGRADED`. After that the socket is the process stdio. `stty size` printed `40 123` after `POST /exec/{id}/resize?h=40&w=123`. `echo` round-trips, and the exec inspect reports the real exit code (`exit 7` reads back as 7). Half-close (`socket.shutdown()` with `allowHalfOpen: true`) delivers EOF to stdin. A 256 KiB payload piped through `cat` came back byte-identical, which exercises partial writes and the `drain` path.

**dockerode under Bun 1.4.** `dockerode@4.0.9` in a scratch directory: ping, hijacked exec (`echo` round-trip in 51 ms), resize and logs all worked. The historical `node:http` upgrade problem does not reproduce on Bun 1.4. We still skip it. It pulls 65 packages (including `ssh2` and native-addon postinstalls), ships no first-party types, and uses Node streams and callbacks where the rest of LogiStack uses web streams and `AbortSignal`. Our client is about 820 lines of logic plus 560 lines of hand-written types (Biome-formatted). Every endpoint we call has an integration test against the real daemon.

## 2. Swarm zero-downtime deploy

`swarm-deploy.ts` creates a one-replica `busybox:1.37` httpd service published on port 18473 (ingress mode). It uses a `wget` healthcheck (interval 1 s, retries 2, start period 2 s) and `UpdateConfig {Parallelism 1, Order start-first, FailureAction rollback, Monitor 5s, MaxFailureRatio 0}` plus `RollbackConfig {Order start-first, Monitor 5s, FailureAction pause}`. A load loop sends `GET /` over a fresh connection per request (`Connection: close`), so the routing mesh picks a backend each time. It counts non-2xx responses and network errors as failures. One replica is the hardest case, because nothing else is serving during the swap.

| Run                     | Clients | Phase                     | Requests | Failed                                       | Duration          |
| ----------------------- | ------- | ------------------------- | -------- | -------------------------------------------- | ----------------- |
| start-first             | 1       | 3 good updates (v1 to v4) | 2 237    | 0                                            | 8.4 to 8.7 s each |
| start-first             | 1       | bad update, auto-rollback | 1 146    | 0                                            | 13.9 s            |
| start-first             | 8       | 3 good updates            | 16 979   | 0                                            | 8.4 to 8.8 s each |
| start-first             | 8       | bad update, auto-rollback | 8 831    | 0                                            | 13.7 s            |
| **control: stop-first** | 8       | 1 good update             | 5 233    | **968** (952 connection errors, 16 timeouts) | 13.0 s            |

The control run matters. The same loop against `Order: stop-first` sees 968 failures, so the instrument does detect downtime. Zero under `start-first` is a measurement, not a blind spot. The 8-client loop runs about 540 req/s. A gap shorter than about 15 ms per client could slip between requests. The control shows the real stop-first gap is seconds long.

**Bad update.** The update points the healthcheck at a missing path (`/healthz-missing`) while the server itself stays up, so the only failure is health. That stands in for "an image whose healthcheck fails". The new task never turns healthy. Swarm kills it (`task: non-zero exit (137): dockerexec: unhealthy container`), the update fails, and `FailureAction: rollback` restores the previous spec. The load loop saw only `v=4` responses during the whole bad update, so an unhealthy `start-first` task never receives ingress traffic. After rollback, `Spec` is back to v4.

**Detecting rollback.**

- `ServiceInspect.UpdateStatus.State` moves `updating -> rollback_started -> rollback_completed`, with `Message: "rollback completed"`. A good update moves `updating -> completed`. `rollback_paused` and `paused` mean a human has to act.
- `/events` with `type=service` emits `update` events whose `Actor.Attributes` carry `updatestate.old` and `updatestate.new`. Observed sequence for the bad update: `->updating`, `updating->rollback_started`, `rollback_started->rollback_completed`. The agent can drive the deploy state machine from events alone. Polling `UpdateStatus` is the fallback for the reconciler.
- `UpdateStatus` is absent on a service that has never been updated.

**Cost of a deploy.** About 8.5 s per good update: health start period, the first passing check, the 5 s `Monitor` window, then the old task's stop. Rollback takes about 14 s, because Swarm first waits out the failed health retries, then runs the rollback with its own monitor. Both scale with `Monitor` and the healthcheck timings, and the compiler controls both.

## 3. Agent memory

`agent-memory.ts` is agent-shaped. It holds one long-lived `/events` subscription and, every 10 s, lists running containers and fetches one-shot stats for all of them in parallel. It was compiled with `bun build --compile` (Bun 1.4.0, darwin arm64, 63 MB binary). `measure-rss.ts` spawns the binary and samples `ps -o rss=` from outside every 30 s for 6 minutes. The OS-charged RSS is the number reported, not the process's own estimate. Ten extra `busybox` containers (`ls-test-rss-*`, removed afterwards) brought the total to 10 to 12 running containers. A full integration-test run during the window pushed 447 events through the subscription.

| t     | RSS     | stats calls | events |
| ----- | ------- | ----------- | ------ |
| 2 s   | 17.6 MB | 11          | 0      |
| 62 s  | 21.8 MB | 78          | 113    |
| 122 s | 22.6 MB | 144         | 146    |
| 242 s | 22.7 MB | 276         | 251    |
| 332 s | 23.2 MB | 371         | 447    |

RSS settles at 22.6 to 22.7 MB after about 2 minutes, and the JS heap stays at 0.7 MB throughout. The +0.5 MB in the last sample coincides with the burst of events from the test run. One 6-minute run on macOS is not a leak test. A Linux run over hours, with about 50 containers, belongs in the agent's own Phase 1 soak. This run rules out the client itself being heavy. A Bun agent costs about 25 MB per node, not 100+.

**Gotcha.** On this macOS host, the compiled binary's ad-hoc signature is invalid as written (`codesign --verify`: "code or signature have been modified"), so the kernel SIGKILLs it at exec with exit 137 and no output. `codesign --force --sign - <bin>` fixes it. Agents ship as Linux binaries in a container, so production is unaffected. Developers running a compiled agent on macOS hit it.

## Risks found

- **Version conflicts are a 500, not a 409.** A stale `version` on `POST /services/{id}/update` returns HTTP 500 `update out of sequence`. The client maps that text to `DockerVersionConflictError`. The integration test asserts it, so an engine release that rewords the message fails CI instead of silently becoming a generic 500.
- **Overlay networks report `Driver: ""` for about 100 ms after create.** The swarm allocator fills it asynchronously. The reconciler must not flag that as drift. The integration test waits for allocation.
- **`stdout` and `stderr` log lines have no relative order** across streams, even for a script that writes them in sequence.
- **Image pull errors arrive inside a 200 stream** as `{"error": ...}`. The client turns them into `DockerError`. A naive status check would report success.
- **Hijacked output has no read-side backpressure.** A consumer that stops reading lets frames queue in memory. This is fine for shells and dumps read promptly. Fix it with `socket.pause()`-style flow control before streaming multi-GB restores through exec stdout. Stdin writes already honour `drain`.
- **Not exercised here:** `swarm init` (the swarm is already active) and `nodes.update` (it would mutate the real node). Both are thin wrappers over a single call. Multi-node overlay and routing-mesh behaviour, and zero-downtime for long-lived keep-alive clients, need the Phase 1 multi-node test bed.

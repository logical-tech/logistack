# Game servers plan

A new service kind, **Game server**, next to Database and Object storage in the new-service wizard. Each game gets its own wizard steps, its own detail tab and its own DNS shape. First wave: Minecraft (Java, Bedrock), Counter-Strike 2, TeamSpeak 3, Mumble.

Planned as six PRs (GS-1 to GS-6); landed together on 2026-11-06. What shipped differs from the sections below in a few places:

- RCON goes through a Source RCON client in `packages/providers/src/game/` over `ls-game`, for Minecraft too, instead of `rcon-cli` over exec.
- TeamSpeak's `serveradmin` password is minted and passed as `TS3SERVER_SERVERADMIN_PASSWORD`; privilege keys come from ServerQuery (`privilegekeyadd`), so nothing is parsed from logs.
- Game hostnames are written by the API when they are created or synced (`POST /game-endpoints/{id}/sync`), the way domain records are. shortcut: when a game server moves node or port, the Game tab flags its hostnames as out of sync instead of a reconciler rewriting them.
- Not built yet: Modrinth search, world upload/reset from the panel (use the Files and Volumes tabs), channel lists, the real-client SRV spike.

## The networking fact the whole feature hangs on

Game traffic is raw TCP/UDP, not HTTP. Consequences:

- **Caddy is not in the path.** Players connect to a published port on the node that runs the container. Nothing goes through the `domain` table or the Caddy compiler.
- **Cloudflare proxy (orange cloud) does not work** for these protocols. Records must be DNS-only (grey cloud), so the node IP is public. The wizard says this plainly. Cloudflare Spectrum can proxy Minecraft, but it is a paid add-on; out of scope, mention it in the help text only.
- **Cloudflare Tunnel does not work for players.** A tunnel exposes arbitrary TCP only to clients running `cloudflared access`, which game clients don't. The existing `domain.tunnel` path stays HTTP-only.
- **"Domain without a port" is an SRV record, not TXT.** The client looks up `_<service>._<proto>.<name>` and gets the port and target host from it:

| Game | Default ports | SRV the client reads | Domain without port |
|---|---|---|---|
| Minecraft Java | 25565/tcp (+25575/tcp RCON, never published) | `_minecraft._tcp.<name>` | yes, any port |
| Minecraft Bedrock | 19132/udp | none, Bedrock ignores SRV | only on 19132 |
| Counter-Strike 2 | 27015/udp game, 27015/tcp RCON | none | only on 27015 (`connect play.example.com`) |
| TeamSpeak 3 | 9987/udp voice, 30033/tcp files, 10011/tcp query (never published) | `_ts3._udp.<name>` | yes |
| Mumble | 64738/tcp+udp | `_mumble._tcp.<name>` | yes |

So for SRV-capable games we can run many servers on one node on any free port and still give each a clean hostname. For CS2 and Bedrock, the first server on a node gets the default port and a clean hostname; the next ones get `host:port`, and the wizard shows that.

The record set per endpoint is: `A`/`AAAA` `<target>` → node address, DNS-only; plus the SRV pointing at `<target>` with the published port. When `<name>` itself is the target (`play.example.com`), one A record plus one SRV on `_minecraft._tcp.play.example.com` is enough. The existing DNS layer already handles SRV values (`packages/contracts/src/dns.ts`, `packages/providers/src/dns/cloudflare.ts`) and the `proxied` flag; no provider work needed beyond forcing `proxied: false`.

Spike before GS-2: confirm each client's SRV behaviour with a real client (Java 1.21+, TS3 3.6, Mumble 1.5), and that Cloudflare accepts an SRV whose target is a grey A in the same zone. Write results to `docs/spikes/game-dns.md`.

## What already exists and gets reused

- `StorageSpec` + `storageEngineDefs` (`packages/core/src/storage.ts`): the pattern for an engine-driven kind. Image, data dir, env derived from minted secrets, Swarm config files. Games copy it as `gameDefs`.
- Wizard: `storageSteps` / `storageSummary` in `apps/web/src/components/storage/wizard-steps.tsx`, hooked into `services/new.tsx` by `kind`. Games add `gameSteps` the same way.
- Detail tab gating in `services/$serviceId/route.tsx` (`t.id !== "storage" || service.kind === "storage"`).
- `PortMapping` with `protocol` and `mode`, and `publishedPortConflicts` + `ingressPortHolder` in `packages/core/src/ports.ts`. Games use `mode: "host"` so players' real IPs reach the server (bans, rate limits); the routing mesh would NAT them.
- Volumes, volume upload/download, container files tab, backups: worlds, plugins and mods go through these unchanged.
- Service exec over the agent: used for `rcon-cli` in the Minecraft image.
- DNS providers and record CRUD, propagation checks (`packages/providers/src/dns/propagation.ts`).

## GS-1: the `game` kind, Minecraft Java only

Contracts (`packages/contracts/src/game.ts`, new):

- `gameKinds = ["minecraft-java", "minecraft-bedrock", "cs2", "teamspeak3", "mumble"]`, `GameKind`.
- `GameSettings` discriminated on `game`. Minecraft Java: `{ game, flavour: "vanilla"|"paper"|"fabric"|"forge"|"neoforge", version, memoryMb, motd, maxPlayers, difficulty, gamemode, onlineMode, whitelist: boolean, seed? }`. Validated at the boundary (rule 7).
- `GameSpec = { kind: "game", settings: GameSettings, resources, port: Port }` added to the `ServiceSpec` union.

DB: add `game` to `serviceKinds` (enum value add, rule 10 ok). Settings live in the spec JSON like storage, no new table.

Core (`packages/core/src/game.ts`):

- `gameDefs: Record<GameKind, GameDef>` with `image` (pinned digest, rule 6 spirit: never `:latest`), `dataDir`, `ports(settings, published)`, `env(settings, secrets)`, `healthcheck`, `probe` kind, `srv` (`{ service, proto } | null`), `defaultPort`.
- Minecraft Java uses `itzg/minecraft-server` (env-driven: `EULA`, `TYPE`, `VERSION`, `MEMORY`, `ENABLE_RCON`, `RCON_PASSWORD`). EULA: the wizard has an explicit "I accept the Minecraft EULA" checkbox; we don't set `EULA=TRUE` silently.
- `compileService` gains a `game` branch: one container, host-mode published port(s), named volume on `dataDir`, labels per rule 4, pinned to a node (placement `node.id==…`) because host ports and the world volume live there. Snapshot test per game.
- RCON password minted at creation into a secret service env var, same as storage root credentials.

Ports: a `suggestGamePort(game, node, holders)` helper returns the default port if free on that node, else the next free one in a per-game range. Uses `publishedPortConflicts`. Unit test.

Web:

- `new.tsx`: a fourth card "Game server" next to Object storage. Step 1 picks the game from two groups, **Games** and **Voice**, with icons (`service-icon.ts`).
- `components/game/wizard-steps.tsx`: Minecraft steps are *Edition & version* (flavour, version list fetched from Mojang's version manifest by the server, cached), *World* (seed, gamemode, difficulty, max players, MOTD), *Resources* (memory slider that sets both the container limit and `-Xmx` with headroom), *Node & port* (node picker, suggested port, conflict check), *Summary*.
- Mock adapter fixtures for the new kind.

Tests: contract parse tests, compile snapshot, port suggestion, API create → spec stored, one Docker integration test that starts the Minecraft image as `ls-test-game-*` and waits for the healthcheck (slow; tagged).

## GS-2: game endpoints and DNS

A game hostname is not a `domain` row (that table is Caddy routes, unique per hostname+path, HTTPS-shaped). New table, additive:

```
game_endpoint
  id            gep_…
  service_id    → service, cascade
  hostname      text, unique
  dns_provider_id → dns_provider, set null
  a_record_id, srv_record_id  text (provider ids, for idempotent upsert and cleanup)
  status        pending | active | error, status_message
```

- Reconciler (worker): for each endpoint, upsert the A/AAAA to the address of the node the service is pinned to (`node.address`; add an optional per-node `publicAddress` override for NATed nodes, additive column), and the SRV from `gameDefs[game].srv` with the published port. Always `proxied: false`. When the service moves node or port, records follow. Delete removes only the record ids we stored.
- Compiler stays pure: `compileGameRecords(endpoint, game, port, address) -> DnsRecordInput[]`, snapshot-tested.
- Wizard step *Address* (after *Node & port*): pick a DNS provider and zone, type a name, see the exact records that will be created, with a warning box: "These records are DNS-only. Cloudflare's proxy and Tunnel cannot carry game traffic, so this node's IP is public." For CS2/Bedrock on a non-default port it shows `play.example.com:27016` as the address players type. Without a DNS provider, show the records to create by hand and a copy button.
- *Test* step: DNS propagation check (existing), then a protocol probe from the control plane against the public hostname (see GS-3 probes). If the probe fails but the container is healthy, the message points at the host firewall / cloud security group for that port and protocol. LogiStack does not manage host firewalls.
- MCP/REST: `game_endpoint_create|update|delete`, read under `GET /services/:id/game`.

## GS-3: Minecraft panel

A **Game** tab on game services (gated like Storage). For Minecraft Java:

- **Status** header: online/offline, version, MOTD, `players online / max`, latency. Source: a Server List Ping probe (`packages/providers/src/game/minecraft-slp.ts`, small TCP protocol, unit-tested against captured bytes). Polled by the worker into the existing metrics path, so the service overview chart can show players over time.
- **Console**: live log tail (existing logs) plus a command input. Commands run as `rcon-cli <argv…>` through service exec; argv only, never a shell string (rule 3). Command history per user in localStorage.
- **Players**: online list with kick/ban/op actions (RCON), and editors for `whitelist.json`, `ops.json`, `banned-players.json` that write through RCON when running and through the volume when stopped.
- **Settings**: a typed form for the common `server.properties` keys (backed by spec settings → env, so a change is a redeploy with a pending diff), plus a raw editor for everything else via the container files tab.
- **Mods & plugins**: upload `.jar` into `plugins/` or `mods/` depending on flavour, using the existing volume upload. Modrinth search is a later nice-to-have, not in this PR.
- **World**: download world (volume download), upload a world zip, reset world (typed confirm). Backups tab already covers schedules; preset "before each restart".

## GS-4: voice servers

TeamSpeak 3 (`teamspeak` official image):

- Wizard: license acceptance checkbox (`TS3SERVER_LICENSE=accept`), slots, node & port, address. Ports: 9987/udp and 30033/tcp published, 10011 never published.
- On first start the server prints the admin privilege key and ServerQuery password once. The worker captures them from the first log lines of the first task, stores them as secret env vars, and the panel shows them behind the same reveal component used for backup keys. If capture fails, a "reset" action restarts with a new `serveradmin` password via env.
- Panel: status and clients online via ServerQuery (TCP 10011, over the overlay network, never published), virtual server name/welcome message/slots, channel list (read-only first), privilege key reveal and "create new key".
- SRV `_ts3._udp`. TeamSpeak 6 server is in beta; add it as a separate `GameKind` once it is stable.

Mumble (`mumblevoip/mumble-server`):

- Wizard: server name, welcome text, max users, server password (optional), SuperUser password minted and revealable. 64738 tcp+udp.
- Panel: status and users via Mumble's UDP ping (unauthenticated, returns users/max/bandwidth), settings form backed by env, SuperUser password reset.
- SRV `_mumble._tcp`.

## GS-5: Counter-Strike 2

- Image: a community SteamCMD-based image (e.g. `joedwards32/cs2`), pinned by digest; spike first to confirm it updates CS2 on start, runs as non-root and keeps the install on a volume. The install is ~60 GB: the *Resources* step shows disk free on the chosen node (existing node disk endpoint) and refuses below a threshold.
- Wizard: GSLT (Steam Game Server Login Token, secret env, with a link to Steam's token page and why it's needed for a public listed server), server name, password, max players, game type/mode preset (Competitive, Casual, Deathmatch, Wingman), start map, workshop collection id (optional), RCON password minted.
- Ports: 27015/udp + 27015/tcp. First CS2 server on a node gets 27015; others get the next free one, and the address shows `:port`.
- Probe: A2S_INFO over UDP (`packages/providers/src/game/a2s.ts`): name, map, players, max, VAC. Same probe works for any future Source/Steam game.
- Panel: status, current map with a "change map" action, RCON console via a Source RCON client in the server (TCP, over the overlay network; RCON is never published), players with kick/ban.
- Updates: "Update game" = redeploy, which re-runs SteamCMD; a pending diff isn't meaningful here, so the button says what it does.

## GS-6: Minecraft Bedrock and polish

- Bedrock (`itzg/minecraft-bedrock-server`), 19132/udp, no SRV. The *Address* step explains that Bedrock players type the port unless it is 19132.
- Geyser option on Minecraft Java (Paper flavour): adds the Geyser plugin and publishes 19132/udp, so Bedrock players join the Java server.
- Templates page entries for each game, so they are also deployable from manifests and MCP.
- Screenshots in `apps/web/docs/screenshots/game/` light/dark, 1440/390, like storage.

## Security notes

- RCON, ServerQuery and Mumble Ice are never published. The server reaches them over a dedicated `game` overlay network, same pattern as the `storage` network.
- All game passwords and tokens (RCON, GSLT, privilege keys, SuperUser) are secret service env vars; never argv, never logs (rule 3).
- Containers drop all capabilities except what the image needs, run non-root where the image allows it.
- Console commands are audited (`game.command`, with the command text; RCON passwords never appear).
- Permission: running console commands needs the same permission as service exec.

## Out of scope

- Proxying game traffic (Spectrum, Velocity/BungeeCord networks, TCP load balancing).
- Host firewall management.
- Billing/slot limits per org beyond existing resource profiles.
- Other games. `gameDefs` + the A2S probe make Source games (TF2, Garry's Mod, Rust) and Valheim cheap follow-ups.

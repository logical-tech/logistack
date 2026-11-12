# Home network plan

Goal: LogiStack on a server at home is the only thing you run. It deploys the services and it is also the house's DNS: ad blocking, local zones, DHCP, people and devices, filter groups with schedules. The feature is optional, built on Technitium DNS Server, and merges the Casa DNS project (`casa/dns`: Technitium + Caddy + a Bun/Hono app) into LogiStack. Ideas and behaviour are ported; the code is rewritten on LogiStack's stack.

Decisions below come from the planning interview of 2026-11-12.

## Decisions

| Area | Decision |
|---|---|
| Engine | Technitium DNS Server, pinned image tag (rule 6), bumped with LogiStack releases |
| Scope | **Instance level.** One Technitium, one network per installation. No organization owns it |
| Activation | Three doors, same result: `install.sh --enable-dns` (alias `--with-dns`) on a new or a running server, `logistack network enable`, and a wizard in the UI |
| Node | One Technitium on a node picked in the wizard (default: the manager). Movable later. No Technitium cluster |
| Breadth | The home part is native UI. Everything else (cluster, Technitium users, cache, DNSSEC, advanced zone options) is a link to the Technitium console |
| "Apps" | Two things: **Extensions** (Technitium DNS Apps: install, update, configure) and **blockable apps** (the catalog of ~140 services blocked per group or per time slot) |
| Service domains | A domain inside a local zone gets its record on Technitium automatically. Every such domain has a switch: **home only** / **also from the internet** (existing Cloudflare Tunnels) |
| Navigation | A **Network** group in the sidebar, shown only when the feature is on. The rest of LogiStack does not change. No "home profile" |
| Migration from Casa DNS | None. Start from zero. Pi-hole / AdGuard Home import stays |
| Delivery | This plan first, then three phases on one branch, each usable on its own |

## What Casa DNS has, and where it goes

| Casa DNS | In LogiStack |
|---|---|
| People, devices, groups, schedules, pause, no-history | New, phase 2 |
| Advanced Blocking config generator (`api/rules.ts`) | Pure compiler in `packages/core` (rule 2), snapshot-tested |
| Blocklists, allow/block, "why is it blocked?", list status | New, phases 1-2 |
| Dashboard, live query log | New, phase 1 |
| Zones, records | New, phase 1 (common record types; the rest in the console) |
| DHCP scopes, leases, reservations | New, phase 3 |
| Technitium Apps page | New "Extensions" page, phase 3 |
| DoT profile for phones, QR code | New, phase 3 |
| Pi-hole / AdGuard import | New, phase 3 |
| Wake-on-LAN | New, phase 3, through a one-shot host-network job on the node's agent (no `wol-relay` service) |
| Own Caddy and service routes | **Dropped**: LogiStack's proxy and domains |
| Cloudflare Tunnel code (`api/tunnel.ts`) | **Dropped**: `cloudflare_tunnel` + `domain.tunnel` already do it |
| Network map | **Dropped**: `/network` map exists; it gains a "home DNS" node |
| Health checks, ntfy/Telegram | **Dropped**: uptime monitors, notification channels and rules. New events feed them |
| R2 backup | **Dropped**: backup destinations. The Technitium backup zip joins the instance backup once that exists |
| Login, account, Technitium user admin | **Dropped**: LogiStack auth. Users never log into Technitium |
| MCP server | **Dropped**: LogiStack's MCP mirrors the OpenAPI routes, so every new route is a tool for free |
| git auto-update timer | **Dropped**: LogiStack updates |
| Cluster, Cache, DNS client, Admin pages | Console link |

## What already exists in LogiStack

- Optional feature turned on from the UI, with a wizard, that the worker converges as a host-network Swarm service through the Engine API: Tailscale (`apps/server/src/routes/tailscale.ts`, `apps/worker/src/tailscale.ts`, `integrations/tailscale_.new.tsx`). Home network follows the same shape, so old installations need no `stack.yml` change.
- Installer on/off flag kept across re-runs: `--no-ingress` / `--enable-ingress` (`install/install.sh`).
- `domain.tunnel`, `domain.dnsProviderId`, `cloudflare_tunnel`, DNS provider adapters (`packages/providers/src/dns`), DNS-01 wildcards.
- Network map (`packages/core/network-map`, `/network`), event bus, notification rules, uptime monitors, backup destinations, audit log, instance admins, CLI (`apps/cli`), setup wizard (`apps/web/src/routes/setup.tsx`).

## Design

### Runtime

- The worker creates one Swarm service `ls-dns` (rule 5) from a pure `compileHomeDns(row) -> ServiceSpec`: Technitium image, **host network**, placement constraint on the chosen node, one named volume, `NET_ADMIN` for DHCP, managed labels (rule 4). Host network is what gives Technitium the real client IPs and lets DHCP work; without it every device looks like the Docker gateway and groups are useless.
- The API and worker run on overlay networks, so they reach Technitium at `http://<node address>:5380` with a service token. That token and the generated admin password are stored encrypted. The console is therefore reachable on the LAN, behind Technitium's own login; "Open console" reveals the password to instance admins.
- Port 53: Ubuntu's `systemd-resolved` stub holds it. `install.sh --with-dns` / `--enable-dns` runs as root on the host, so it frees the port itself (drop-in for `DNSStubListener=no`, restart, check the host still resolves). The UI wizard cannot change the host: its preflight detects the busy port and shows that one command.
- macOS / OrbStack dev: works, but all clients appear as one IP. Dev only.

### Who owns the state (rule 1)

Two kinds of state, on purpose:

1. **LogiStack-owned, in Postgres, reconciled**: the feature itself (node, upstream, base lists), people, devices, groups, schedules, pauses, and the records of service domains. A reconciler pass compiles them and converges Technitium: settings, the Advanced Blocking app config, the bypass list, and records tagged with a `logistack:<domainId>` comment. It only ever touches records carrying that tag.
2. **Technitium-owned, passed through**: zones and records you create by hand, DHCP scopes and reservations, extensions and their config. The API routes validate with zod and call Technitium, the same way a Cloudflare zone is edited today. Mirroring all of Technitium in Postgres would be a second DNS database to keep in sync for no gain. These survive a server move because the Technitium backup is part of the instance backup.

### Data model (additive migrations, rule 10)

| table | purpose |
|---|---|
| `home_network` | singleton: enabled, node, LAN IP, upstream forwarders, base blocklists, safe search mode, encrypted token and admin password, status, last applied hash |
| `network_person` | name, icon, group, no-history |
| `network_device` | name, icon, **MAC and/or fixed IP**, person, own group (wins over the person's), no-history, notes |
| `network_group` | name, icon, filtering on/off, categories, blocked apps, allowed/blocked domains, safe search, no-history. A `default` row ("Whole house") always exists |
| `network_schedule` | group, days, start/end (may cross midnight), categories and apps blocked only in that slot |
| `network_pause` | device or person, until |
| `network_seen_client` | clients already seen, for "new device on the network" |

One change from Casa DNS: there a device **is** its IP. Here a device can be known by MAC, and the compiler resolves its current IP from the DHCP leases; a lease change triggers a reconcile. Without Technitium's DHCP a device needs a fixed IP, as today.

### API, CLI, events

- Routes under `/network/*` in `apps/server/src/routes/network/`, OpenAPI like the others; MCP tools follow automatically. Contracts in `packages/contracts`.
- Permissions: instance admins manage. Read-only for everyone else is not needed in v1 (see open questions).
- CLI: `logistack network enable|disable|status`. `enable` asks the same things as the wizard and calls the same route.
- New events on the bus: `network.device.new`, `network.dns.unhealthy`, `network.lists.failed`, so notification rules route them. Weekly summary is a built-in schedule that emits `network.summary`.

### Service domains

- When a domain's hostname falls in a local zone, the reconciler writes `A <node LAN IP>` for it on Technitium. Deleting the domain removes it.
- The domain form shows the switch when the feature is on. "Home only" is a domain with no public record and no tunnel. "Also from the internet" sets `domain.tunnel` on a Cloudflare provider, which already creates the ingress and the proxied CNAME. At home the name keeps resolving to the node (split horizon).
- Certificates: a local zone on a real domain you own uses the existing DNS-01 wildcard. A made-up zone (`home.lan`) gets Caddy's internal CA and a warning in the wizard.

### UI

Sidebar group **Network**, visible when enabled: Overview, People, Devices, Groups, Query log, Blocking, Zones, DHCP, Extensions, Map (the existing `/network`, same URL), Settings. New pages use flat routes (`network_.people.tsx`) so the map's URL does not move. When disabled, Settings → General has an "Enable home network" card that opens the wizard.

Wizard (rule 8): node → LAN address and port 53 preflight → upstream resolver (DoH, DNSSEC) → base blocklist → local zone → test (resolve a name, check a blocked one) → summary with "set this address as DNS on your router".

UI copy in English. UI skills from `CLAUDE.md` apply.

## Changes made while building phase 1

- **The installer cannot call the API**, because nobody can sign in before setup. `install.sh --enable-dns` frees port 53 and labels the node `logistack.dns=true`. The worker reads that label as a one-shot request: it turns the DNS on there with defaults (node address, Cloudflare DoH, Hagezi Pro) and removes the label, so turning the DNS off later sticks.
- **Disable always deletes the data.** Each enablement gets a fresh volume, because Technitium reads the admin password only on first start, so a kept volume could never be reused. Keeping the data is what Stop is for.
- **No instance backup exists yet** (`docs/PIANO.md` lists it for a later phase), so the Technitium backup has nothing to join. Until then zones made by hand live only in the Technitium volume.
- **The port 53 check is weak without a local zone.** With a zone the worker asks for its SOA, which only Technitium can answer. Without one, any resolver answering on that address passes.

## Phases

1. **DNS on.** Schema, `compileHomeDns`, worker reconcile, installer flags, CLI, wizard, overview dashboard, blocklists and allow/block, live query log, zones and records, console link, health events, Technitium backup in the instance backup.
2. **The house.** People, devices, groups, schedules, blockable apps, safe search, pause, no-history, "why is it blocked?", new-device alert, weekly summary.
3. **Integration.** Automatic records and the home/internet switch on domains, home DNS on the map, DHCP, Extensions, DoT profile + QR, Pi-hole/AdGuard import, Wake-on-LAN, docs-site pages.

## Spike results (2026-11-12)

Run on the dev machine (OrbStack, single-node Swarm, Docker 29.8.2) with `technitium/dns-server:15.6.2`.

- **S1, host-network Swarm service: works.** `docker service create --network host --cap-add NET_ADMIN` starts Technitium, which binds 53/udp, 53/tcp and 5380. Enabling a DHCP scope through the API binds 67/udp. A container on a bridge network reaches the API and resolves names at the node's address, so the API and worker can talk to it from their overlays. **Not proven:** a real lease handed to a LAN device, and real client IPs in the log. OrbStack has no LAN. Casa DNS already runs this way on Linux with host networking, so the risk is low, but the first check on the home server is a phone getting a lease.
- **S3, port 53: works.** On Ubuntu 24.04 with systemd, `systemd-resolved` holds `127.0.0.53:53` and `127.0.0.54:53`. A drop-in `/etc/systemd/resolved.conf.d/logistack-dns.conf` with `DNSStubListener=no` plus a restart frees both. The host keeps resolving: systemd rewrites `stub-resolv.conf` to the uplink servers by itself, so `/etc/resolv.conf` needs no change. The installer writes that one file and removes it on `uninstall.sh`.
- **S2, query log without a file: works.** The "Query Logs (Sqlite)" app has `useInMemoryDb`. With it on, rows are served by `logs/query` (row number, timestamp, client IP, name, response type; paging by start time works) and the database file on the volume stops changing. So no-history needs no file access: in phase 2 Technitium keeps a capped in-memory log, the worker copies new rows into Postgres by timestamp cursor and drops the rows of no-history devices before they are stored. In-memory row numbers restart with the container, so the cursor is the timestamp. Phase 1 keeps the app's default on-disk log and reads it through the API, since there is nothing to hide yet.
- **App install is slow.** The app zip is 17 MB and `download.technitium.com` served it at about 17 KB/s from here (1000 s). Technitium's `downloadAndInstall` call outlived a 150 s client timeout and still finished on its own later. The worker therefore treats app install as a slow, retried step with its own status, never as part of a request, and treats "already exists" as success. If this speed is normal and not this network, bake the apps into a LogiStack-built Technitium image.

## Open questions

1. **LAN devices behind a name.** Casa DNS can proxy `nas.<zone>` to any IP on the LAN (NAS, router, Home Assistant). LogiStack domains belong to a deployed service. Should phase 3 add an "external" service kind that is only a proxy route to a LAN address?
2. **Delegated access.** Is "instance admins only" enough, or should a non-admin (a partner) be able to pause filters or see the dashboard?
3. **Name.** "Network" in the sidebar and "home network" in the docs, or something else?

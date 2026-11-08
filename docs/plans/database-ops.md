# Database operations: public access, port forwards, upgrades, per-org network

Status: implemented on `feat/db-ops-c74a69` (2026-11-08). Closes the database items of the
roadmap. Coolify restores need SSH; Dokploy users ask for the same things in #2368, #1741,
#3609, #2542 and #3620.

## 1. Public access: TLS and an IP allowlist

Before this change a database had no published port at all. Exposing one needs three things:
the traffic is encrypted, only allowed sources connect, and the internal plain connections
(apps on the environment network, the explorer on the db network) keep working.

### Options

**A. Caddy layer-4 proxy.** Caddy would listen on the database port, match `remote_ip`, and
terminate TLS with the certificates it already manages.

- Postgres and MySQL do not open with a TLS handshake. Postgres sends an `SSLRequest` and
  waits for one byte, then starts TLS (direct TLS exists only for Postgres 17 clients that ask
  for it). MySQL is worse: the server speaks first, then the client asks for TLS inside the
  protocol. A generic L4 TLS terminator serves neither.
- Our Caddy build has no `layer4` app; it would be a custom build to maintain.
- Caddy publishes its ports on the Swarm service. Each new database port is a Caddy service
  update, which restarts the HTTP edge for every app.

**B. Agent-managed host firewall rules.** The node agent would write `DOCKER-USER` iptables
rules for the database's host port.

- It filters sources well, but it cannot require TLS: on MySQL and Mongo, TLS-only and plain
  share one port, so "refuse plain from outside, allow plain from inside" is not expressible.
  Requiring TLS in the engine breaks every app that connects in plain over the overlay.
- The agent would need `NET_ADMIN` on the host network, and rules vanish on reboot or a
  firewall reload, so the agent would reconcile kernel state outside Docker.

**C. A LogiStack TCP gateway per exposure (chosen).** A small Swarm service, `ls-gw-<id>`,
runs our own image with `ROLE=dbgateway`. It publishes the port in host mode (the client's
address reaches the process unchanged), joins the org's database network, and pipes bytes to
the database. Before it opens the upstream it:

1. checks the source address against the allowlist (`node:net` `BlockList`);
2. reads the first client bytes and refuses anything that is not a TLS request:
   - Postgres: an `SSLRequest` (`00 00 00 08 04 d2 16 2f`) or a direct TLS ClientHello;
   - MySQL and MariaDB: the server greeting is relayed first, then the client's first packet
     must be the 32-byte `SSLRequest` with `CLIENT_SSL` set;
   - Mongo and Redis: a TLS ClientHello (first byte `0x16`).

TLS itself terminates in the database, with a certificate Caddy issues for the chosen hostname
(Caddy's `certificates.automate`, read back from its Redis storage like `certs.ts` does). The
engine accepts TLS and plain, so apps and the explorer are unchanged; only the gateway's port is
TLS-only. Redis gets a second port (`--tls-port 6380`) because it cannot do both on one.

Costs, accepted:

- The certificate is a Swarm secret on the database service, so a renewal rolls the database
  (about every 60 days). The maintenance pass that reads certificates enqueues the deploy.
- The gateway runs on the database's node (host-mode port), so the hostname must resolve to
  that node.
- libSQL speaks HTTP; it is not offered.

## 2. Port forwards

A port forward is the same gateway with an expiry: the allowlist defaults to the caller's
address, the duration is 5 minutes to 8 hours, and the port is picked from 15000-15999. It
requires TLS when the database has a certificate, else it is a plain, single-address,
time-limited port and the wizard says so. At `expires_at` the gateway closes its listener and
every connection itself, and the worker's sweep removes the service and the row, so an
expired forward is closed even if one of the two fails.

## 3. Major-version upgrades

Steps, each recorded on the `database_upgrade` row and streamed to the wizard:

1. **Check**: engine supports it (Postgres, MySQL, MariaDB, Mongo), the target is newer, a
   replica is running.
2. **New instance**: a helper service on the target version, pinned to the database's node,
   with a fresh managed volume `ls-vol-<upgradeId>` and the same credentials. It joins no
   network, so nothing can write to it.
3. **Copy**: the old replica's full dump (`pg_dumpall`, `mysqldump --all-databases`,
   `mongodump`) is piped into the helper's restore tool.
4. **Verify**: exact row counts per table (documents per collection) on both sides must match.
5. **Switch**: the helper stops, the service row points at the new version and the new volume
   (`service.data_volume_id`), and the service deploys.
6. **Verify again** on the switched service. A failure here, or a failed rollout, restores the
   old version and volume and deploys again: the **automatic rollback**. The old volume is never
   written, and stays until the user deletes it.

Writes that reach the old instance after step 3 starts are not copied; the wizard says to stop
writers first.

## 4. Restore from an uploaded dump

The route already streamed the body into the restore tool. It now needs a `Content-Length` (so
the limit applies before the first byte reaches the tool) and refuses bodies above
`LOGISTACK_RESTORE_MAX_BYTES` (default 20 GiB) with a 413; a body that sends more than it
declared is cut off.

## 5. A database network per organization

Every database used to join the shared `ls-db`, so a database of one org could reach another's.
Databases now join `ls-db-<org>` (created on first use, managed labels). The worker attaches
the api to each org network, the same way `ensureStackNetwork` attaches it to `ls-db`; that is
one rolling api update per org, when its first database deploys. The api stays on `ls-db`, so
databases that have not redeployed yet keep working in the explorer; each one moves on its next
deploy, never on its own, because a network change restarts it.

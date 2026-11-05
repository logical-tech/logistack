# Migrate from Coolify plan

A server that runs Coolify should become a LogiStack server with one command and a wizard, the same way a Dokploy server does (`docs/plans/migrate-dokploy.md`). `install.sh` finds Coolify and installs LogiStack next to it with ingress off. The wizard then runs these steps in order:

1. Read Coolify's database read-only.
2. Show what migrates fully, what migrates in part and what does not.
3. Import everything into LogiStack without deploying it.
4. Cut over one service at a time, with a rollback for each.
5. Hand 80/443 from Coolify's proxy to Caddy with the certificates already in place.
6. Remove Coolify and archive its data.

Steps 2 to 6 already exist for Dokploy and are source-agnostic, or become so in COOL-1. Coolify brings three new parts: a reader, a different bridge, and the Coolify-specific halves of install, switch and decommission.

Decisions (operator, 2026-11-05):

- **Versions:** stable v4.0.0 and later. Betas are refused. Tested on v4.0.0, v4.5.3 and v4.6.0.
- **One-click services:** migrated as a compose split. A template that needs Coolify-only behaviour is refused.
- **Swarm:** `install.sh` initialises it on the Coolify host, with an address pool that collides with nothing.
- **Coolify's control plane:** frozen from the first cutover (the `coolify` container is stopped, with restart policy `no`), with an unfreeze.
- **Defaults:** the localhost server only. A Caddy-proxy Coolify switches without certificate import. Previews, scheduled tasks and volume backups are reported, not migrated.

Ground rules are the Dokploy program's:

- Read-only on Coolify until cutover.
- Every step is idempotent and resumable.
- Only Coolify's own objects are touched, by exact name or by Coolify's own labels.
- Coolify code is never copied. This plan cites its source only as evidence.

The PRs are COOL-1 to COOL-8.

## Facts (Coolify, read at tag v4.5.3 with `git show`; drift checked against v4.0.0 and v4.6.0)

Source checkout: `~/Documents/projects/logical/coolify`, a bare clone. Coolify's stable line runs from `v4.0.0` (2026-04-27) to `v4.6.0` (2026-11-02), and everything before it is `v4.0.0-beta.*`.

### Install layout

- `scripts/install.sh:44-53` creates `/data/coolify/{source,applications,databases,backups,services,proxy,proxy/dynamic,sentinel,ssh/keys,ssh/mux}`. `source`, `ssh` and `images` are mode 700.
- `/data/coolify/source/.env` holds `APP_KEY=base64:<32 bytes>`, `DB_USERNAME=coolify`, `DB_PASSWORD`, `REDIS_PASSWORD` and `PUSHER_*` (`install.sh:959-967`). `DB_DATABASE` is not in `.env`: compose defaults it to `coolify`.
- Coolify's own containers are plain compose containers, not Swarm:
  - `coolify`: Laravel, the scheduler and, since 4.4, realtime. `restart: always`, ports 8000, 6001 and 6002.
  - `coolify-db`: `postgres:15-alpine` on volume `coolify-db`, or `postgres:18-alpine` on `coolify-db-pg18` after the opt-in `scripts/upgrade-postgres.sh`.
  - `coolify-redis`.
  - `coolify-sentinel`, the metrics and status agent. It is on by default since `2026_09_08_202212_enable_sentinel_for_existing_regular_servers.php`.
- The `coolify` network is a local bridge: `docker network create --attachable [--ipv6] coolify` (`scripts/upgrade.sh:50-62`, `app/Models/Server.php:2653`).
- Coolify drives the host's Docker through the `docker` CLI over SSH to `host.docker.internal`, with the key `/data/coolify/ssh/keys/id.<user>@host.docker.internal` (`database/seeders/ProductionSeeder.php:86-135`).
- `install.sh:285` writes `default-address-pools: 10.0.0.0/8, size 24` into `/etc/docker/daemon.json`.

### Swarm on a Coolify host

- Coolify uses Swarm only for servers whose DB flags `server_settings.is_swarm_manager` or `is_swarm_worker` are set (`app/Models/Server.php:2370-2380,2563`). It does not detect Swarm on the host. Its localhost server stays a non-Swarm server and keeps using compose and the `coolify` bridge after `docker swarm init`.
- **Subnet collision, reproduced** (`docker:29-dind` with Coolify's address pool, 2026-11-05):
  - After a default `swarm init`, the `coolify` bridge is `10.0.1.0/24` and the first overlay also gets `10.0.1.0/24`.
  - With `--default-addr-pool 10.248.0.0/16`, ingress is `10.248.0.0/24`, overlays are `10.248.1.0/24`, and new bridges keep coming from `10.0.x`.
  - So on a Coolify host, `install.sh` must initialise Swarm with an address pool that overlaps no existing network or route (COOL-4).
- Not yet verified: Coolify's UI, deploys and Sentinel on a host with Swarm active. COOL-8 checks this.

### Database schema

- There is no Postgres schema dump. The schema comes from Laravel migrations, which are PHP, so tests can derive it only by running Coolify's own image (COOL-2).
- v4.0.0 has 326 migrations, v4.5.3 has 478 and v4.6.0 has 493. From v4.5.3 to v4.6.0, the only change in scope is `applications.git_https_username/password`. Columns added after v4.0.0 are read as optional; the full list is in the COOL-2 reader notes.
- Hierarchy: `teams` → `projects(uuid, name, team_id)` → `environments(uuid, name, project_id)`.
- `applications` holds:
  - `build_pack`: `nixpacks|static|dockerfile|dockercompose|railpack`, plus `dockerimage`.
  - Git and image: `git_repository/branch/commit_sha`, `source_type` (PHP class name: `App\Models\GithubApp|GitlabApp|GiteaApp`), `source_id`, `private_key_id`, `docker_registry_image_name/tag`, `dockerfile` (inline, plain text), `dockerfile_location`, `base_directory`, `publish_directory`.
  - Network: `ports_exposes` (comma-separated), `ports_mappings` (`host:container,…`), and `fqdn` (comma-separated URLs with scheme; a `:port` suffix is a container-port override).
  - Compose: `docker_compose_raw` and `docker_compose_domains` (JSON `{service: {domain}}`).
  - Settings: `custom_labels` (base64, or plain text in legacy rows), `health_check_*`, `limits_*` (strings, `'0'` means none), `custom_network_aliases` (JSON array), `swarm_replicas`.
  - State: `status` (`running:healthy`), and `deleted_at` (soft delete, so filter it).
- `application_settings` is 1:1 on `application_id`. It holds `is_static`, `is_spa`, `connect_to_docker_network`, `is_consistent_container_name_enabled` and `custom_internal_name`, among others.
- One-click `services` keep the user's compose in `docker_compose_raw`. `docker_compose` is Coolify's generated rewrite, so use `_raw`. Sub-resources are `service_applications` and `service_databases` (`fqdn`, `image`, `is_public`).
- Template magic variables are stored as `environment_variables` rows on the service (`parsers.php:2697-2850`), and those rows are the source of truth:
  - `SERVICE_FQDN_*` (host) and `SERVICE_URL_*` (with scheme).
  - Generated once: `SERVICE_PASSWORD_*`, `SERVICE_USER_*`, `SERVICE_BASE64_*`.
  - Runtime only, never stored: `COOLIFY_*`.
- Standalone databases:
  - Tables `standalone_{postgresqls,mysqls,mariadbs,mongodbs,redis,keydbs,dragonflies,clickhouses}`. Each has an `image` column, credential columns, and `is_public`/`public_port`.
  - Redis credentials live only in env rows, since `2024_10_16_120026_move_redis_password_to_envs.php`.
  - The database's own env rows override its columns (`StartPostgresql.php:261-280`).
- `environment_variables` (`resourceable_type` is the full class name, with no morph map):
  - Content: `key`, `value`, `is_preview`, `is_buildtime`, `is_runtime`, `is_literal`, `is_multiline`.
  - References in values: `{{team|project|environment|server.KEY}}` point at `shared_environment_variables`. `$OTHER` points at a sibling variable. `{{vault.KEY}}` is a remote secret that cannot be read from the DB.
- Organization resources:
  - `s3_storages`. Backup destinations are `s3_storage_id` plus the M:N `scheduled_database_backup_s3_storage` (since `2026_10_07`).
  - `scheduled_database_backups(frequency, database_type, database_id, retention_*)`, `private_keys`, `github_apps`, `gitlab_apps`.
  - Six notification tables per team: discord, slack, telegram, email, pushover, webhook.

### Encryption

- Laravel `AES-256-CBC` with `APP_KEY` (the `base64:` prefix stripped, then decoded to 32 bytes).
- The payload is `base64(JSON{iv, value, mac, tag})`. `mac` is hex `HMAC-SHA256(iv_b64 . value_b64)`.
- Two variants:
  - The `'encrypted'` cast (`encryptString`) stores raw plaintext. It covers database passwords (e.g. `StandalonePostgresql.php:96`), `private_keys.private_key`, `s3_storages.key/secret`, GitHub/GitLab secrets, `shared_environment_variables.value`, `local_file_volumes.content` and every notification secret.
  - `environment_variables.value` goes through a mutator that wins over the cast. It stores `encrypt(trim(v))`, so the plaintext is PHP-serialized: `s:N:"…";` (`EnvironmentVariable.php:705-725`).
- Older rows can be plaintext or serialized: `2026_10_19_083521_encrypt_plaintext_secrets.php` only now encrypts some columns. The decoder therefore:
  1. Tries decrypt, verifying the MAC.
  2. Treats a failure as plaintext only for the columns that migration lists.
  3. Unwraps `s:N:"…";`.
- A value the decoder cannot open is noted by its key, never echoed. That is the lesson from Dokploy (MIG-8a).

### Containers, volumes, networks

- Containers:
  - Standalone database: `<uuid>`, which is also its hostname. `internal_db_url` is `postgres://…@<uuid>:5432/…` (`StandalonePostgresql.php:347`).
  - Application: `<uuid>-<YYYYMMDDTHHMMSS>`, a new name on every deploy. With consistent names on it is `<uuid>` or `custom_internal_name`. Other containers therefore rarely address an app by hostname.
  - Compose app or one-click service: `<composeService>-<uuid>`, on its own attachable bridge network `<uuid>`. It also joins `coolify` only when `connect_to_docker_network` is set.
- Labels: `coolify.managed=true`, `coolify.type`, `coolify.applicationUuid|serviceUuid|databaseUuid`, `coolify.name`, `coolify.projectName`, `coolify.environmentName`, and `com.docker.compose.project=<uuid>` (`bootstrap/helpers/docker.php:636-651`).
- Volumes:
  - Standalone databases use `<type>-data-<uuid>` (`postgres-data-<uuid>`, …). Mongo has `mongodb-db-<uuid>` and `mongodb-configdb-<uuid>`.
  - The Postgres mount is `/var/lib/postgresql/data`, or `/var/lib/postgresql` on 18+.
  - Service named volumes are `<uuid>_<name>`. Bind directories live under `/data/coolify/{applications,services,databases}/<uuid>`.
- Every app, database and service container is `restart: unless-stopped`, so a `docker stop` survives a reboot.

### Proxy

- `coolify-proxy` runs Traefik `v3.7` by default, or a caddy-docker-proxy (`bootstrap/helpers/proxy.php:689`). Its config is `/data/coolify/proxy/docker-compose.yml`, and it is `restart: unless-stopped`.
- It uses the docker provider with `exposedbydefault=false` and **no network constraint**, plus a watched file provider on `/traefik/dynamic/`.
- Certificates: resolver `letsencrypt`, HTTP challenge, stored in `/traefik/acme.json` (`/data/coolify/proxy/acme.json` on the host). That is the same Traefik format Dokploy uses.
- Apps are routed by container labels: `http-<n>-<uuid>`/`https-<n>-<uuid>` routers, `Host() && PathPrefix()`. Services also get `traefik.docker.network=<uuid>`. The proxy is connected to every network a `coolify.managed` container uses (`proxy.php:410`).
- **Coolify brings its proxy back.**
  - `ServerCheckJob.php:80-100` and Sentinel's `PushServerUpdateJob.php:826-832` restart a stopped `coolify-proxy`.
  - Only `proxy.force_stop`, proxy type `NONE`, or ports 80/443 already in use stop that (`app/Actions/Proxy/CheckProxy.php:32,86-95`).
  - App, database and service containers are only marked `exited`, never restarted (`GetContainersStatus.php:377-475`).

### Backups

- Coolify's backups use `docker exec <uuid> pg_dump`. The dump goes to `/data/coolify/backups/databases/<team>-<id>/<db>-<uuid>/` and is uploaded with `mc` to `<bucket>/data/coolify/backups/...`.
- Old backups stay in the bucket under that prefix. LogiStack writes new ones in its own layout.

### Seeding a test Coolify (for COOL-8)

- The API is `/api/v1` with Sanctum bearer tokens, behind `instance_settings.is_api_enabled`, which is false by default.
- The first registration is root. `ROOT_USER_EMAIL` must pass a DNS check and the password a HaveIBeenPwned lookup, so a test install creates the user through tinker.
- `POST /s3-storages` refuses private endpoints (`SafeWebhookUrl`). The DinD S3 storage is therefore inserted through tinker, and everything else goes through the API.

## The bridge: keeping names and sites alive between cutover and switch

For Dokploy, LogiStack services joined Dokploy's overlay `dokploy-network` under the old name. That does not work here: Coolify's networks are local bridges, and a Swarm service cannot join a local bridge.

**Design: the bridge runs the other way.** LogiStack owns an attachable overlay, `ls-coolify-bridge` (labelled, with a subnet from LogiStack's own pool). Coolify's containers join it, which plain containers can do with an attachable overlay:

1. `install.sh` creates the overlay and connects `coolify-db` to it, so the api reads Coolify's database at `coolify-db:5432`. The api joins it in `stack.coolify.yml`.
2. Before each cutover the worker connects these containers to the overlay. The step is idempotent, because a Coolify redeploy or a reboot can drop an attachment:
   - `coolify-proxy`;
   - every running container labelled `coolify.managed=true` that belongs to a resource still on Coolify.
3. A migrated service joins the overlay with the source's exact container names as aliases: `<uuid>` for a database, `<svc>-<uuid>` for a one-click part. Coolify-side clients resolve the old name to it, and it resolves Coolify-side containers by their names.
4. A migrated service with domains carries Traefik router labels on its task containers, with `traefik.docker.network=ls-coolify-bridge`. Coolify's Traefik docker provider reads them from the task containers (it has no network constraint), so the old proxy routes to the new service until the switch.
5. Decommission disconnects everything and removes the overlay.

**Proved on the local Swarm** (2026-11-05, Docker 29.8.2, Traefik v3.6, `ls-test-coolspike-*`). The setup was a "Coolify" bridge network with a db, an app and Traefik with `exposedbydefault=false`, plus a Swarm service on an attachable overlay aliased as the db. All 8 checks passed:

- Traefik routed `old.test` to the Coolify container.
- The plain containers joined the overlay.
- The Swarm task reached the Coolify app by name.
- After `docker stop` of the old db, the Coolify app resolved the old name to the Swarm service.
- Coolify's Traefik routed `old.test` to the Swarm service 20 times out of 20.
- Rollback (start the old container, scale to 0) brought DNS and routing back to Coolify.
- Detach worked.

Consequences:

- Slugs:
  - A database keeps its Coolify `uuid` as its slug, because that is the host in every `DATABASE_URL` and stays valid after decommission. That is the same rule as Dokploy's `appName`.
  - A one-click part keeps its compose service name, as Dokploy's compose split does. Siblings move as one item.
  - An application gets a slug from its name, because nothing reaches it by its timestamped container name. Its consistent name or `custom_internal_name`, if set, becomes the slug.
- The aliases and router labels move from code that knows Dokploy (`apply.ts`, `bridgeRouterLabels`) into data: a `migration_bridge` row per imported service, holding the network, aliases and whether it routes. Dokploy's import writes the same rows (COOL-1).
- **Coolify is frozen during the migration** (decision 4). Otherwise its scheduler and Sentinel restart `coolify-proxy` after the switch, and a git push auto-deploys a new container next to the migrated service, giving two writers. At the first cutover the worker:
  1. saves the `coolify` container's state;
  2. sets its restart policy to `no`;
  3. stops it.

  `coolify-db` and `coolify-redis` keep running. A full rollback, or "Unfreeze Coolify" in the wizard, restores it.

## Dependency graph

- COOL-1 starts from `develop`.
- COOL-2 needs nothing and can run beside COOL-1.
- COOL-3 needs COOL-2. COOL-4 needs COOL-1.
- COOL-5 needs COOL-1, COOL-3 and COOL-4. COOL-6 needs COOL-5. COOL-7 needs COOL-3 and COOL-6.
- COOL-8 runs last.

## Make the pipeline source-agnostic (COOL-1, done)

- [x] `migration_source` gets `coolify` (`packages/db/drizzle/0026_migration_bridge.sql`). `planMigration` takes the source. The import acts as `migrate-<source>` into "Imported from <Label>". The routes find the source through `detectSource` (`apps/server/src/migration/sources.ts`). `decommissionBlocker` and the route copy name the source (`sourceProfiles` in `packages/core/src/migration.ts`).
- [x] The plan carries a `SourceDescriptor` per service item (`packages/core/src/migration.ts`), and the worker finds sources only through it (`apps/worker/src/migration.ts`):
  - Swarm services by exact name or stack label;
  - containers by every given label;
  - `routedByLabels` decides the bridge settle wait.
  - Dokploy's inventory fills it. A Dokploy plan stored before this PR gets its descriptor from `appName` (`dokployDescriptor`).
  - Evidence: an inventory test asserts the compose descriptor. `cutover.integration.test.ts` stores plans without one, so the fallback is what it runs.
- [x] `migration_bridge(service_id, migration_id, aliases[], routes)` replaces the Dokploy checks in `apply.ts`:
  - The import writes one row per service with a `bridge` draft. The network and router flavour come from the migration's source (`apps/worker/src/migration-source.ts`).
  - `compileService` takes `bridgeAliases` and `bridgeContainerLabels`.
  - `bridgeRouterLabels` has a `traefik-docker` flavour: `traefik.docker.network`, `http`/`https` entrypoints, labels on the containers.
  - The SQL backfills rows for services an unfinished Dokploy migration imported.
  - Decommission detaches the services named by the rows, then deletes the rows.
  - Evidence:
    - the core test "a service bridged to Coolify carries container routers and the old names";
    - `migration-import.test.ts` asserts the rows;
    - `WORKER_IT=1` `cutover`, `proxy-switch` and `decommission` integration tests: 7 pass on the real Swarm (2026-11-05);
    - full `bun test`: 1220 pass, 0 fail.
- [x] Worker settings per source: `sourceSettings(cfg, source)` gives the proxy name, `acme.json` path and bridge network, with `LS_COOLIFY_*` beside the `LS_DOKPLOY_*` overrides. The proxy switch uses it.
- [ ] The wizard's copy per source moves to COOL-7.

## Read Coolify into an inventory (COOL-2)

Code in `apps/server/src/migration/coolify/`: `snapshot.ts` (zod), `read.ts` and `decrypt.ts`, plus a pure `inventory.ts` producing the same `Inventory` and `ServiceDraft` types.

- [ ] Reader:
  - It runs inside a READ ONLY transaction.
  - It checks each required column against `information_schema` and names the missing one.
  - Columns added after v4.0.0 are optional.
  - Soft-deleted rows (`deleted_at`) are skipped.
  - Only resources on the localhost server (`servers.id = 0`) are read; others are `unsupported` (multi-server is out of scope).
- [ ] Upstream schema test (`COOLIFY_SRC`, opt-in): it runs Coolify's own image at each pinned tag (`php artisan migrate` against a scratch Postgres) and checks the reader's columns against it. No Coolify code lands in this repo. Tags: v4.0.0, v4.5.3 and v4.6.0.
- [ ] `decrypt.ts`: Laravel CBC with MAC check, the serialized and raw variants, and the plaintext fallback only where Coolify's own migration says rows can be plaintext. Evidence: unit tests on payloads made with a known key, including a wrong MAC.
- [ ] Env:
  - The service's runtime rows are read (`is_preview=false`), with shared `{{team|project|environment|server.KEY}}` and `$SIBLING` references resolved.
  - `{{vault.*}}`, unresolvable references and invalid keys are skipped and named.
  - Build-only rows become build args.
  - The notes never carry a value. Evidence: a test that searches the notes for fixture secrets.
- [ ] Applications:
  - `dockerimage` (pinned to the running container's image digest, as Dokploy's importer does), `dockerfile` (path or inline), `nixpacks`/`railpack` → Railpack with a note, and `static` (`publish_directory`, SPA).
  - Git sources: GitHub App, deploy key, public URL.
  - Ports from `ports_exposes`, with host `ports_mappings` reported. Domains from `fqdn`, including path, scheme and port override. Limits, health check and basic auth.
  - Persistent volumes are adopted under their Docker name. File volumes become configs.
- [ ] Standalone databases:
  - Postgres, MySQL, MariaDB, MongoDB and Redis on their official image keep their version and adopt `<type>-data-<uuid>`. Postgres 18+ gets the same `PGDATA` handling as Dokploy.
  - The credentials are written into the env, Redis's from its env rows.
  - KeyDB, Dragonfly, ClickHouse, custom images and SSL-enabled databases are `unsupported` until LogiStack has those engines. `is_public` is reported.
- [ ] `dockercompose` applications go through the existing `mapComposeServices`, with `docker_compose_domains`.
- [ ] Evidence: `test/coolify-inventory.test.ts` and `test/coolify-read.test.ts`, seeded against the schema of the upstream test.

## One-click services and organization resources (COOL-3)

- [ ] One-click services, per decision 2:
  - `docker_compose_raw` goes through `mapComposeServices`, one LogiStack service per compose service.
  - The stored magic-variable rows become plain env values, so generated passwords stay the same.
  - `service_applications.fqdn` becomes domains.
  - Coolify-only compose extensions are reported. One that changes behaviour (`exclude_from_hc`, `coolify.*` labels) refuses the item.
  - Named volumes are adopted as `<uuid>_<name>`.
- [ ] Organization items, reusing `org.ts`'s checked bodies:
  - S3 storages (path style from `use_path_style_endpoint`);
  - private keys;
  - GitHub Apps (private key from `private_keys`; webhook moved after the switch, as MIG-3c does);
  - Discord, Slack, Telegram, email (SMTP and Resend) and Pushover notifications, with Coolify's switches mapped to one rule.
  - GitLab and Gitea apps and the generic webhook are `unsupported`, with a note to reconnect.
- [ ] Database backups:
  - `frequency` → cron, aliases like `daily` expanded. Retention from `retention_amount_s3`.
  - Every destination from the M:N table. A backup with no S3 destination is reported.
- [ ] Not read: scheduled tasks, volume backups, previews, Sentinel and log drains, Cloudflare tunnels, server settings. They are reported where they exist.

## Detect Coolify in install.sh (COOL-4)

- [ ] Detect from the `coolify` container or `/data/coolify` (already in `detect_migration_source`). Explain the plan, install `--no-ingress` and private, allow 80/443 held by `coolify-proxy`, and write `migration_source=coolify`.
- [ ] Swarm init on a Coolify host uses `--default-addr-pool`. The pool is the first candidate in a fixed list that overlaps no existing Docker network subnet and no host route; if none fits, install stops with the reason.
- [ ] Credentials:
  - `APP_KEY`, `DB_USERNAME` and `DB_PASSWORD` are read from `/data/coolify/source/.env` (root only) and piped into the Swarm secrets `logistack-coolify-key` and `logistack-coolify-db-password` through stdin. They are never printed.
  - `install.sh` refuses if the `.env` is unreadable.
- [ ] `stack.coolify.yml`:
  - The api joins `ls-coolify-bridge` and mounts the secrets.
  - It also mounts `/data/coolify/{applications,services}` read-only, for compose and file volumes kept on disk.
- [ ] The bridge overlay is created with its label, and `coolify-db` is connected to it. A re-run restarts nothing.
- [ ] The tunnel port avoids 8000, 6001 and 6002.
- [ ] Evidence: a `SMOKE_COOLIFY=1` case in `install/smoke.sh`, mirroring MIG-5's.

## Cutover and rollback of plain containers (COOL-5)

- [ ] The source descriptor of a Coolify item is its exact container names, read at cutover by label (`coolify.applicationUuid|serviceUuid|databaseUuid=<uuid>`, `coolify.managed=true`) and saved once in `source_state`. A rollback restarts exactly those containers, by id.
- [ ] Freeze Coolify at the first cutover:
  - The `coolify` container's restart policy and running state are saved on the migration.
  - Its restart policy is set to `no`, then it is stopped.
  - Unfreeze restores both. Evidence: an integration test with a fake `coolify` container.
- [ ] `ensureBridge` connects `coolify-proxy` and the running Coolify containers still to migrate. It is idempotent: an already-connected container is a no-op.
- [ ] Order stays as in MIG-3b. A stateful item stops its containers first and waits until they exit. A stateless one deploys first, waits for Traefik's docker provider to see the new router, then stops the source.
- [ ] Evidence: `apps/worker/test/cutover-coolify.integration.test.ts` (`WORKER_IT=1`, `ls-test-cool5-*`, own subnet). A fake Coolify bridge, db, app and Traefik check:
  - a database takes over `<uuid>` and a Coolify-side app keeps working;
  - a site keeps answering through the old Traefik;
  - a deployment that never gets healthy rolls back;
  - a second cutover is a no-op.

## Switch the proxy and decommission (COOL-6)

- [ ] The proxy switch takes the source profile:
  - It stops `coolify-proxy` by exact name and sets its restart policy to `no`.
  - It imports certificates from `/traefik/acme.json` read through the Docker archive endpoint.
  - The fallback restores both.
  - Because Coolify is frozen, nothing brings its proxy back. Evidence: a `proxy-switch` integration case with the Coolify profile.
- [ ] Caddy-proxy Coolify, per decision 5: the switch works and Caddy issues fresh certificates. No import from caddy-docker-proxy's storage in this program.
- [ ] Decommission:
  - Gate and report as in MIG-7.
  - Archive:
    - `coolify.dump` (`pg_dump -Fc` of `coolify-db`, from a one-shot job on the bridge with Coolify's Postgres image and the password secret);
    - `data-coolify.tar.gz` of `/data/coolify` minus `backups/` (listed, not copied, as it can be large);
    - `inventory.json`.
    - The dump and tarball are verified before anything is removed.
  - Remove, by exact name:
    - `coolify`, `coolify-db`, `coolify-redis`, `coolify-realtime` (if present), `coolify-sentinel` and `coolify-proxy`;
    - the sources the cutovers stopped, by saved container id.
  - Disconnect and remove `ls-coolify-bridge`. Remove the `coolify` network and each `<uuid>` network only when nothing is attached.
  - Keep every volume and every item left on Coolify.
  - Evidence: an integration test with fake Coolify containers. The dump restores.

## Wizard (COOL-7)

- [ ] The wizard, Home panel and command palette name the detected source. Copy differs only by the source's name and steps:
  - "Freeze Coolify" is explained in step 3;
  - the confirm word is `coolify`.
- [ ] Evidence: mock API run in dark and light at 1440 px and 390 px, impeccable detector, keyboard-only pass.

## Prove it end to end (COOL-8)

- [ ] `bash install/smoke-migrate-coolify.sh` (`ls-test-cool8-dind`, `KEEP=1`). The run:
  - Uses Coolify **v4.5.3**, installed with its own `install.sh` inside docker:dind, with images preloaded from the host.
  - Creates the root user and API token through tinker and enables the API in SQL. Everything else is seeded through `/api/v1`:
    - a dockerimage app with a domain and a `DATABASE_URL` to the database;
    - a Postgres with a row of data and a backup to a MinIO S3 (the S3 row through tinker, since the API refuses private endpoints);
    - a multi-service one-click service with a domain.
  - Runs `install.sh --local-build` next to Coolify, then setup and the wizard through LogiStack's API.
- [ ] Checks:
  - Coolify keeps working after `swarm init` (UI 200, a redeploy, its proxy routes).
  - Every domain answers through Coolify's Traefik after each cutover.
  - Row 42 is read through the app on LogiStack's Postgres, over the adopted volume.
  - The proxy-switch HTTP gap is measured.
  - Coolify is removed and its archive is on disk.
  - The data, domains and volumes stay.

## Risks

- **Schema and format drift.** Coolify ships often (15 migrations from v4.5.3 to v4.6.0 in a week), and older rows mix encryption formats. Mitigation:
  - Read only stable v4 releases from v4.0.0 on, and refuse betas by checking for a column added in v4.0.0.
  - Treat later columns as optional.
  - Keep the upstream schema test per pinned tag.
  - Use the tolerant decoder.
- **Coolify acting behind our back.** Its scheduler restarts the proxy, and git pushes and its API redeploy apps. Freezing the `coolify` container is the mitigation; the risk is the user unfreezing it mid-migration. The wizard shows the freeze state.
- **Network attachments are lost** when Coolify recreates a container (a redeploy, an upgrade). `ensureBridge` before every cutover and switch repairs them, and the freeze prevents most recreations.
- **Subnet collision with Swarm** is proved (above). The address pool must be chosen at Swarm init and cannot change afterwards on that Swarm. A host that already runs a Swarm with a colliding pool is refused with the reason.
- **One-click templates rely on Coolify's compose rewrite** (magic variables, volume names, its labels). We map from `_raw` plus the stored values. A template whose behaviour depends on Coolify-only extensions is refused, not approximated.
- **Adopted volumes and rule 4**, as for Dokploy: the `adopted_volume` table guards them.

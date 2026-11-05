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

## Read Coolify into an inventory (COOL-2, done)

Code in `apps/server/src/migration/coolify/`: `snapshot.ts` (zod), `read.ts`, `decrypt.ts`, `source.ts`, and the pure `inventory.ts` and `org.ts`, producing the shared `Inventory` (`../types.ts`). Source-agnostic helpers moved to `migration/shared.ts`: `orgItem`, `refused`, `dependencyOrder`, `crossChecks` and `orgChecks`. The cross-environment check now also looks for Coolify's uuids, which have no dash.

- [x] Reader:
  - It runs inside a READ ONLY transaction.
  - It checks each required column against `information_schema` and names the missing ones.
  - Columns and tables added after v4.0.0 are optional: `domain_port_overrides`, `enable_ssl`, `use_path_style_endpoint`, `scheduled_database_backup_s3_storage`, and the KeyDB, Dragonfly and ClickHouse tables.
  - Soft-deleted rows are skipped.
  - Secrets are decrypted on the way out. A value no key opens becomes null and is listed in `undecryptable` by table, row name and column.
- [x] Real schema and data per release. Coolify's own image (`coollabsio/coolify:<tag>`) migrates a scratch Postgres, then `test/fixtures/coolify-seed.php` seeds it through Coolify's own Eloquent models, so the rows are cast and encrypted by Coolify. The reader and the inventory then run on it.
  - Evidence: `COOLIFY_TAGS=4.0.0,4.5.3,4.6.0 bun test test/coolify-read.test.ts` (2026-11-05): 4 pass. Every release reads with nothing undecryptable and plans the database, the application and the one-click service as `full`.
  - Schema diff (4.0.0 → 4.5.3), from the same run: the only columns the reader needs that 4.0.0 lacks are the optional ones above.
- [x] `decrypt.ts`:
  - Laravel AES-256-CBC with the HMAC checked first; `encrypt()` payloads are unserialized.
  - Plaintext rows from older releases pass through.
  - Evidence: `test/coolify-decrypt.test.ts`, on payloads Coolify 4.5.3's own encrypter made with a test key, plus a wrong key and a tampered payload.
  - Finding: `local_file_volumes.fs_path` and `mount_path` are encrypted too, not only `content`.
- [x] Env:
  - The non-preview rows of the resource.
  - `{{team|project|environment|server.KEY}}` is resolved against the shared variables of the resource's own team, project or environment, and a whole-value `$SIBLING` against the resource's own rows. `is_literal` rows are kept as written.
  - Vault references, values the key did not open and invalid keys are skipped and named.
  - Build-only rows are counted in a note.
  - Evidence: inventory tests, including one that searches the notes for every fixture secret.
- [x] Applications:
  - `dockerimage` maps to `name:tag`. A digest stays a digest, because Coolify keeps `@sha256` in the name.
  - Git sources:
    - a GitHub App keeps `owner/repo` and its provider;
    - the public GitHub source becomes the repository URL;
    - a deploy key, GitLab or Gitea is reported.
  - Builds: `dockerfile`, `static`, and `nixpacks`/`railpack` → Railpack (static when `is_static`). An inline Dockerfile is unsupported.
  - Domains from `fqdn` keep their scheme, path and port.
  - `ports_mappings` become host ports. The HTTP health check, memory and CPU limits (Docker size strings), basic auth, persistent volumes (adopted, or bind when they have a host path) and file volumes (configs, or binds for directories) all map.
  - Reported, not carried over: previews, GPU, pre- and post-deploy commands, custom run options and labels the user added.
  - Remote servers and Swarm destinations are unsupported.
  - Slug: the consistent container name when set, else from the name. The bridge aliases are the slug and the uuid.
- [x] Standalone databases:
  - Postgres, MySQL, MariaDB, MongoDB and Redis on their official image keep their version.
  - They adopt the volume at LogiStack's data dir, which is the same path Coolify mounts, so Postgres 18 needs no `PGDATA`.
  - Coolify's credentials become the env, with Redis's taken from its env rows.
  - Backups become S3 policies, with Coolify's frequency aliases as cron and retention from `retention_amount_s3`.
  - SSL, KeyDB, Dragonfly, ClickHouse, custom images and a missing data volume are unsupported.
  - The slug and the alias are the uuid.
- [x] `dockercompose` applications go through the compose mapper, with `docker_compose_domains`.
- [x] Detection: `detectSource` finds Coolify from `COOLIFY_DB_PASSWORD` and `COOLIFY_APP_KEY` (secrets). `POST /migrations` reads it, and a failed read is a 422 that never echoes the password. Evidence: `migration-routes.test.ts` (6 pass).

## One-click services and organization resources (COOL-3, done)

- [x] One-click services:
  - `docker_compose_raw` goes through `mapComposeServices`, with the service's stored env rows as the dotenv, so generated `SERVICE_PASSWORD_*` values stay.
  - Named volumes, declared or not, are adopted as `<uuid>_<name>`.
  - `exclude_from_hc` and Coolify's file-content keys are ignored.
  - A part's domain comes from `service_applications.fqdn`. Its port comes from the URL, else the `SERVICE_FQDN_<NAME>_<PORT>` variable, else its first port.
  - Each part answers on the bridge as `<name>-<uuid>`.
- [x] The compose mapper (shared with Dokploy) now maps `command`, `entrypoint` (compose word splitting) and `healthcheck` (`CMD`, `CMD-SHELL`, a string, `NONE`, `disable`). Dokploy composes gain these too. Evidence: `dokploy-compose.test.ts` "command, entrypoint and healthcheck carry over as argv".
- [x] Organization items:
  - S3 storages, with path style defaulting to on.
  - Git-related deploy keys. Coolify's own server key and GitHub App keys are not users' keys and are skipped.
  - GitHub Apps, not the seeded public one. GitHub Enterprise and uninstalled apps are unsupported.
  - Discord, Slack, Telegram, Pushover and email (SMTP or Resend; instance-wide SMTP is reported). The switches map to one rule, and switches with no LogiStack event are named.
  - GitLab apps and the generic webhook are unsupported.
- [x] Evidence: `test/coolify-inventory.test.ts` (9 pass).
- [ ] Not read: scheduled tasks, volume backups, previews, Sentinel and log drains, Cloudflare tunnels.

## Detect Coolify in install.sh (COOL-4, done)

- [x] Detection: a running `coolify` container. A `/data/coolify` with no Coolify running is only noted.
  - Coolify needs `coolify-db` running and a readable `/data/coolify/source/.env` holding `DB_PASSWORD` and `APP_KEY`; otherwise install.sh stops with the reason.
  - It explains the plan and installs `--no-ingress` and private, leaving 80/443 to Coolify's proxy.
  - It writes `migration_source=coolify` and creates the archive directory.
- [x] Swarm init on a Coolify host passes `--default-addr-pool`: the first of `10.248.0.0/16 10.249.0.0/16 172.29.0.0/16 192.168.248.0/21` that overlaps no Docker network and no host route (`free_swarm_pool`). On a Swarm that is already active, `check_networks` refuses any overlay that overlaps a local network next to Coolify.
- [x] Credentials: `DB_PASSWORD` and `APP_KEY` are piped from `.env` into the Swarm secrets `logistack-coolify-db-password` and `logistack-coolify-app-key` (stdin, never argv, never printed). A re-run keeps existing secrets.
- [x] `install/stack.coolify.yml`: the api joins `ls-coolify-bridge`, gets `COOLIFY_DB_USER`/`COOLIFY_DB_NAME`, and has the two secrets mounted as `*_FILE`.
- [x] The bridge overlay `ls-coolify-bridge` (attachable, labels `logistack.managed=true`, `logistack.kind=migration-bridge`; the orphan sweep only removes kind `network`) is created, and `coolify-db` is connected to it. A re-run reattaches it after a Coolify upgrade.
- [x] Evidence: `SMOKE_COOLIFY=1 bash install/smoke.sh` (`ls-test-cool4-dind`, dockerd with Coolify's `default-address-pool 10.0.0.0/8`, fake `coolify`, `coolify-db`, and `coolify-proxy` on 80/443), 2026-11-05:
  - `PASS Swarm on 10.248.0.0/16: ingress 10.248.0.0/24, bridge 10.248.1.0/24, clear of coolify 10.0.1.0/24`
  - `PASS coolify-db on coolify and ls-coolify-bridge`
  - `PASS ingress off: Caddy 0/0, API through the tunnel`
  - `PASS Coolify's password and APP_KEY are in no output, log, config file or api service spec`
  - `PASS api: readCoolify(coolifySource(config)) over ls-coolify-bridge lists 'Fake Coolify project'`
  - `PASS Coolify untouched`
  - "re-run restarts no task" failed in both runs, because I edited the checkout between the two installs: the diff of the service specs shows only the local-build image tag, which hashes the checkout. It is re-checked on a frozen checkout before the end.
- [x] The Dokploy smoke case now gets a `/data/coolify` with no Coolify running, where it used to get a fake `coolify` container.

## Cutover and rollback of plain containers (COOL-5, done)

- [x] The descriptor of a Coolify item is `coolify.managed=true` plus `com.docker.compose.project=<uuid>`, the project Coolify runs every resource under. The containers found are saved once in `source_state` and restarted by id on rollback.
- [x] Freeze (`apps/worker/src/coolify.ts`). At the first cutover, and at the proxy switch, the worker:
  1. saves `coolify` (restart policy, running) on `migration.freeze`;
  2. sets its policy to `no`;
  3. stops it.

  `POST /migrations/{id}/unfreeze` (the worker job `unfreeze`) restores both. The view shows `frozenAt`.
- [x] `ensureBridge` before every Coolify cutover:
  - It creates the overlay if install.sh's is missing.
  - It joins `coolify-proxy` first, then every running `coolify.managed` container that is not on it yet.
  - Why the proxy goes first: Traefik may route a container that has no `traefik.docker.network` through any of its networks, and the integration test caught a 2 s timeout when the proxy joined last.
- [x] Bridge routers carry `priority=100000`, above the source's own router for the host (Traefik ranks by rule length). Traffic therefore moves the moment the old proxy sees the new task, before the source stops. Before this fix the handover cost one timeout of more than 2 s while Traefik caught up with the stopped container. Dokploy's routers get the same priority.
- [x] Evidence: `apps/worker/test/cutover-coolify.integration.test.ts` (`WORKER_IT=1`, `ls-test-cool5-*`, overlay `10.231.5.0/24`, a real Traefik v3.6 docker provider), 2026-11-05: 4 pass.
  - A database takes over its uuid for a Coolify-side client. Coolify is frozen (`false no`). The client and the proxy joined the overlay. Rollback brings the old container back.
  - A site keeps answering through Coolify's Traefik while it moves. A 200 ms probe during the cutover saw 20 answers from Coolify, then 66 from LogiStack, with none failed.
  - Unfreeze restores `true always`.
  - The Dokploy suites still pass (7).

## Switch the proxy and decommission (COOL-6, done)

- [x] The proxy switch takes `sourceSettings`: `coolify-proxy` by exact name, `/traefik/acme.json` read through the archive endpoint, restart policy `no`, and the fallback restores both. It freezes Coolify first. On a Caddy-proxy Coolify the read fails, is recorded, and Caddy issues the certificates itself. Coolify end-to-end evidence comes in COOL-8.
- [x] Decommission (`apps/worker/src/decommission.ts`):
  - It takes an `ArchiveSource` per source. For Coolify:
    - the job runs Coolify's own Postgres image;
    - it reaches `coolify-db` on the bridge, reattaching it if needed;
    - the password comes from the secret install.sh made, and the user and database from `coolify-db`'s env.
  - The archive is `coolify.dump`, `data-coolify.tar.gz` (`/data/coolify` without `./backups`) and `inventory.json`.
  - It then:
    1. detaches the bridged services and every plain container from the overlay;
    2. deletes the `migration_bridge` rows;
    3. removes `coolify`, `coolify-db`, `coolify-redis`, `coolify-realtime`, `coolify-sentinel` and `coolify-proxy` by exact name;
    4. removes the stopped sources by saved id, and each moved resource's own `<uuid>` network;
    5. removes `coolify` and the bridge only when unused.
  - Items left on Coolify are kept, with "now without Coolify to manage it".
- [x] Evidence: the same suite's "decommission archives Coolify, then removes only what it owns":
  - The dump restores with Coolify's row in it.
  - The tarball has `source/.env` and not `backups/`.
  - Coolify's containers, its proxy and the moved site are gone; the database left on Coolify stays.
  - The client left the overlay, and the bridge rows are gone.

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

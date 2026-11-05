# Migrate from Dokploy plan

A server that runs Dokploy should become a LogiStack server with one command and a wizard. When `install.sh` finds Dokploy, it installs LogiStack with ingress off. Setup then opens a migration wizard that runs these steps in order:

1. Read Dokploy's database without changing it.
2. Show what migrates fully, what migrates in part and what does not.
3. Import everything into LogiStack without deploying it.
4. Cut over one service at a time, with a rollback for each.
5. Hand ports 80/443 from Traefik to Caddy with the certificates already in place.
6. Remove Dokploy and archive its data.

Coolify comes after this program, as a second source adapter for the same pipeline.

Decisions (operator, 2026-11-05):

- **Scope:** Dokploy first. Coolify is a later adapter.
- **Where it runs:** detection in `install.sh`, the migration in a UI wizard (rule 8).
- **Removal:** remove Dokploy's services, proxy and containers. Archive its DB dump and `/etc/dokploy` under `/var/lib/logistack/migration/<timestamp>/`. Deleting that archive and Dokploy's volumes needs a later explicit action.
- **Multi-service compose:** each compose service becomes a LogiStack service in the same environment. No new "stack" type.

Ground rules for this program:

- **Read-only on Dokploy until cutover.** Inventory and import never write to Dokploy's DB or touch its Docker objects.
- **Every step is idempotent and resumable.** Migration state lives in Postgres (rule 1). If the api restarts mid-migration, the migration continues from the last committed item.
- **We touch only Dokploy's own objects, by exact name or by Dokploy's own labels.** Never a prefix that could match the user's other containers.
- **We never copy Dokploy code.** We read its schema and on-disk layout, and write our own code.

The PRs are MIG-1 to MIG-8, in that order unless the dependencies say otherwise.

## What already exists

- `apps/server/scripts/dokploy-compose.ts` maps one compose project to an `ApplicationSpec`. It is pure and has tests. It refuses named volumes, `build:`, custom networks and Traefik rules other than `Host()`.
- `apps/server/scripts/import-dokploy.ts` imports through the API routes as the `system:import-dokploy` actor. It is idempotent through `service.imported_from` and pins images to what the running container uses.
- `install.sh --no-ingress` / `--enable-ingress` keeps 80/443 with the old proxy until the switch.
- A real migration on maddiona (2026-11-03) was done by hand with these pieces. It found two bugs:
  - The worker's node sync reverts Swarm node labels to the DB values, which breaks `--enable-ingress`.
  - The importer pinned the mutable tag instead of the running version. Fixed since.

## Dependency graph

- MIG-1 and MIG-2 start from `develop` and do not depend on each other.
- MIG-3 needs MIG-1 and MIG-2.
- MIG-4 needs MIG-3. MIG-5 needs nothing and can land any time.
- MIG-6 needs MIG-3, MIG-4 and MIG-5. MIG-7 needs MIG-6.
- MIG-8 runs last and checks the whole flow.

## Adopt existing named volumes (MIG-1)

Dokploy's databases and apps keep their data in named volumes that Dokploy created. Copying them doubles the disk space and lengthens downtime. LogiStack mounts the same volume instead.

- [x] An `adopted_volume` table maps a volume owner to the existing Docker volume. The owner is a volume mount's id, or a database or storage service's id for its data directory. The volume name is the primary key, so two services can never adopt the same volume. Evidence: `packages/db/drizzle/0021_adopted_volume.sql`.
- [x] `compileService` takes `adoptedVolumes` (owner id → name). It mounts an adopted volume under its own name, with no `VolumeOptions` labels, because Docker cannot relabel an existing volume. A database or storage service whose data directory is adopted uses that volume in place of `ls-vol-<id>`. Evidence: `adopted volumes` tests in `packages/core/test/compile-service.test.ts`. The snapshots are unchanged.
- [x] `POST /environments/{id}/services` takes `adoptedVolumes: [{ target, volume, source: "dokploy" }]`:
  - It needs admin.
  - `target` must be a volume mount or the data directory.
  - `logistack*` and `ls-*` names are refused.
  - A volume that is already adopted returns 409.
  - Evidence: `apps/server/test/adopted-volumes.test.ts` (5 tests).
- [x] Before every deploy, the worker refuses an adopted volume that is missing or carries `logistack.managed`. Swarm would otherwise create an empty volume, which looks exactly like data loss. Evidence: worker integration test "a missing adopted volume fails the deployment".
- [x] Volume backups and restores resolve the adopted name. Evidence: `volumeDockerName` in `apps/worker/src/backups.ts`, plus typecheck. No live backup run yet.
- [x] Cleanup audit. No code path deletes a service's volume. The orphan sweep lists only `logistack.managed` objects and keeps every volume, and `uninstall.sh` removes only its own named volumes. An adopted volume has no labels, so the sweep never even sees it. Evidence: worker integration test "an adopted volume is mounted as it is and survives its service". It deploys on Swarm, serves the volume's existing data, deletes the service, sweeps past the grace period, and finds the volume still on disk.
- [x] `dokploy-compose.ts` maps the top-level `volumes` to adopted volumes. A plain volume becomes `<appName>_<key>`, the name Dokploy's `-p <appName>` gives it. A `name:` or `external: true` volume keeps its own name. Driver options, undeclared volumes and read-only named volumes are refused. `import-dokploy.ts` sends them as `mounts` plus `adoptedVolumes`. Evidence: mapper tests and the importer integration test (`minecraft-p2m7rt_backups`).
- [ ] Multi-node: the existence check reads the worker's own node only (`shortcut:` comment in `apply.ts`). Ask the pinned node's agent once migrations run on multi-node Swarms.
- [ ] Credentials of an adopted database: the API mints new credentials, but the data in the volume still uses Dokploy's. MIG-3 must replace the env with Dokploy's credentials before the first deploy.

## Read Dokploy into a migration inventory (MIG-2)

This step maps Dokploy DB rows to an `Inventory` with one item per Dokploy service. Each item is `full`, `partial` or `unsupported`, with notes, and carries the LogiStack service drafts that replace it. The code is in `apps/server/src/migration/dokploy/`: `snapshot.ts` (the rows read, parsed with zod), `read.ts` and `inventory.ts` (pure). The Dokploy compose mapper moved there as `compose.ts`.

### MIG-2a (done)

- [x] Reader:
  - [x] Every SELECT runs inside a READ ONLY transaction.
  - [x] It checks each column it needs against `information_schema` first, and refuses a schema that lacks one, naming the column.
  - [x] Evidence: `test/dokploy-read.test.ts`. With `DOKPLOY_SRC` set, the test applies Dokploy's own migrations from a checkout with `git show`, so no Dokploy code lands in this repo. Checked on v0.30.0 and v0.30.10.
- [x] Hierarchy: the Dokploy project and environment names carry over, and each item names both.
- [x] Env: Dokploy exposes only the service's own lines, with `${{project.X}}` / `${{environment.X}}` substituted. So each service gets its env at service scope, with references resolved. Vault references and invalid keys are skipped and named. Evidence: `serviceEnv` test.
- [x] Applications:
  - [x] Sources: docker image, GitHub, GitLab, Gitea, Bitbucket and custom git. A provider-backed source keeps `owner/repo` plus a `gitProvider` reference for MIG-3.
  - [x] Builds: Dockerfile (path, context, stage, build args), Railpack and static. Nixpacks, Heroku and Paketo become Railpack, with a note.
  - [x] Ports, replicas, resources (bytes and nano CPUs), placement constraints, healthcheck (`CMD` / `CMD-SHELL`), and the command split on spaces as Dokploy does.
  - [x] Mounts: bind mounts, adopted volumes, and file mounts as configs.
  - [x] Domains, including path prefixes, and basic auth users.
  - [x] Reported but not carried over: redirects, previews, registry credentials, SSH keys, custom Swarm labels, networks, update and restart config, global mode, `stripPath` and `internalPath`. Drop sources and remote servers are `unsupported`.
  - [x] Evidence: `test/dokploy-inventory.test.ts`.
- [x] Databases:
  - [x] The official image only, with its version kept.
  - [x] The data volume found in Dokploy's `mount` rows at the engine's data directory is adopted.
  - [x] Dokploy's credentials become the env (`POSTGRES_USER/PASSWORD/DB`...), so the adopted data opens.
  - [x] Unsupported: custom images such as pgvector, and a missing data volume. An external port is reported. (Postgres 18+ was unsupported here; MIG-2c adds it.)
  - [x] Evidence: inventory tests.
- [x] Compose: a raw single-service file maps through the compose mapper, with Dokploy's domain rows. Evidence: inventory tests.
- [x] Notes never carry a value. Evidence: test that searches the notes for fixture secrets.

### MIG-2b (done)

- [x] Multi-service compose: `mapComposeServices` maps every service, and one unsupported service refuses the whole file. Each compose service becomes a draft whose slug is its service name, so siblings resolve it on the environment network. `depends_on` sets the draft order (dependencies first). A cycle or an unknown name is reported. Dokploy domain rows attach to their `serviceName`. Evidence: inventory test "a multi-service compose becomes one service per entry".
- [x] Git-sourced compose files are read from `<composeRoot>/<appName>/code/<composePath>`. A path that escapes the folder is skipped. Evidence: `readComposeFiles` test.
- [x] Hostnames: apps and databases keep Dokploy's `appName` as their slug, because that is the hostname other services use on `dokploy-network`. A service name that is not a DNS label is refused. Evidence: inventory tests.
- [x] Cross-item checks:
  - [x] Two services with one hostname in one environment: the later item is refused.
  - [x] An env value that names a service in another environment is reported, because Dokploy shares one network and LogiStack isolates environments.
  - [x] Evidence: "across items" tests.

### MIG-2c (done)

Organization-level resources become `OrgItem`s in `Inventory.org` (`org.ts`, pure). Each one carries the body of the LogiStack create route it maps to, already checked against that route's schema (`RegistryInput`, the S3 `Connection`, each channel's and GitHub's `configSchema`). Evidence: "organization resources" tests in `test/dokploy-inventory.test.ts`.

- [x] Registries: the host and image prefix become `host/namespace`. An empty URL or `docker.io` means Docker Hub (`docker.io/<prefix or username>`). `ghcr.io` and `registry.gitlab.com` get their own kinds.
- [x] S3 destinations: an endpoint without a scheme gets `https://`. Path style is on for every provider except AWS, as rclone does. Other rclone flags are reported. A bucket name LogiStack refuses makes the destination `unsupported`.
- [x] Database backups: each becomes a `BackupDraft` (cron, retention from `keepLatestCount`, enabled) on its database draft. If Dokploy has no count, retention is empty, so LogiStack keeps every backup too.
  - A backup whose destination does not import is dropped with a note. So is a cron that is not 5 fields.
  - Backups of databases inside a compose file are reported.
  - Earlier Dokploy backups stay in the bucket under their old prefix. LogiStack writes new ones in its own layout.
- [x] Notification channels: Slack, Discord, Teams, Mattermost, Telegram, email (SMTP and Resend), Gotify, ntfy and Pushover map to LogiStack channels.
  - Dokploy's switches become one organization-wide rule: deploys, build errors, backups and the server threshold.
  - Dokploy restarts, Dokploy backups and Docker cleanup have no LogiStack event. They are named in the notes.
  - Custom webhooks (headers, unsigned) and Lark are `unsupported`.
- [x] SSH keys: imported with their private key. A key without its private half is `unsupported`.
- [x] Git providers:
  - A GitHub App carries over with its id, private key, webhook secret and installation. Its webhook still points at Dokploy until the cutover moves it (MIG-3).
  - GitHub Enterprise and apps that were never installed are `unsupported`.
  - GitLab, Gitea and Bitbucket are connected through OAuth or app passwords in Dokploy, while LogiStack needs an access token. They are `unsupported`, and every application that uses one gets a note to reconnect it.
- [x] Postgres 18+: Dokploy mounts the volume on the image's PGDATA (`/var/lib/postgresql/<major>/docker`), so the cluster sits at the volume root. The draft adopts the volume on LogiStack's data dir (`/var/lib/postgresql`) and sets `PGDATA=/var/lib/postgresql`. Evidence: an inventory test, plus a manual check on postgres:18 (2026-11-05): data written in Dokploy's layout reads back with this mount and `PGDATA`.
- [x] Reader: the new tables are read the same way, with every column checked first. Evidence: the seeded reader test, and the upstream schema test on v0.30.0 and v0.30.10.
- [ ] Not read: Dokploy's certificates, volume backups, schedules, SSO, API keys and remote servers. They are left for later or for the user.

## Run a migration as a resumable state machine (MIG-3)

### MIG-3a (done)

- [x] `migration` and `migration_item` tables (`packages/db/drizzle/0022_migration.sql`):
  - [x] `migration` holds the organization, the source, the status (`planned → importing → imported`) and the archive path.
  - [x] `migration_item` holds the kind, the source id, the position, the status, the plan, the targets and the last error. The plan is the inventory item (drafts and notes) encrypted with the master key, because it carries passwords and keys. `targets` holds the resource id, or the service ids by slug for a compose split.
  - [x] Item statuses: `planned → imported → cut_over`, plus `failed` (retried by the next import), `rolled_back` (cut over again later) and `skipped` (undone with `unskip` until the cutover). The transitions live in `packages/core/src/migration.ts`. Evidence: `packages/core/test/migration.test.ts`.
- [x] `planMigration` stores an inventory: organization resources first, because services reference them, then the services in inventory order. An `unsupported` item starts `skipped`.
- [x] Import (`apps/server/src/migration/import.ts`):
  - [x] It creates every `planned` or `failed` item through the API routes, as the system actor `migrate-dokploy`. Nothing is deployed. A created service only runs after a healthy deployment, so the import never starts a second Postgres on a volume Dokploy is still using.
  - [x] It runs in the api, not in the worker, because the routes live in the api and the worker does not depend on `apps/server`. `resumeImports` restarts an import that a restart interrupted.
  - [x] Organization resources: registries, S3 destinations, SSH keys, notification channels plus their rule, and GitHub Apps. A GitHub App is stored through `POST /git-providers` with the new `github` variant, which keeps its key, webhook secret and installation.
  - [x] Services go into the folder "Imported from Dokploy", in their Dokploy project and environment. A Dokploy environment that LogiStack does not have yet is created, as `custom` unless it is `production`, `staging` or `preview`. Each service keeps its slug, mounts and adopted volumes.
  - [x] Env: the full service set is written with `PUT /services/{id}/env-vars`. Dokploy's values win over the credentials the API minted.
  - [x] Also written: domains, basic auth, backup policies on the imported destination, and the git source bound to the imported provider.
  - [x] Idempotent:
    - A service is found by `importedFrom` and an organization resource by name or URL. Settings are written as full sets, and domains and policies only when missing.
    - `targets` are saved after each service of an item, so a crash keeps what is done.
  - [x] A failing item is marked `failed` with the route's error, and the import goes on with the next one.
  - [x] Evidence: `apps/server/test/migration-import.test.ts` runs against Postgres and the real routes. It checks:
    - Every resource is created, with Dokploy's slugs and credentials, the backup policy, the git binding and the notification rule.
    - An item the API refuses is marked `failed` with the reason.
    - After resetting every item to `planned`, as if the api had died before marking them, a second run creates nothing twice.
- [ ] Routes to start a migration and run the import, for the wizard. They come with MIG-5 and MIG-6, once the api can reach Dokploy's database.
- [ ] Shortcut: one api process runs an import at a time (an in-process guard). Take a row lease once the api runs replicas.

### MIG-3b (next): cutover

- [ ] Cutover for one service, as a worker job. Each step is idempotent:
  - [ ] Scale Dokploy's Swarm service to 0, or stop its compose containers. The service is not removed.
  - [ ] Deploy the LogiStack service and wait for health.
  - [ ] On failure, scale the LogiStack service to 0, restore Dokploy's replicas, and mark the item `rolled_back` with the cause.
  - Evidence: integration test on OrbStack Swarm with a fake "Dokploy" service named `ls-test-mig-*`.

### MIG-3c: GitHub webhook and progress

- [ ] GitHub App: at cutover, point the app's webhook URL at LogiStack with `PATCH /app/hook/config` (app JWT). If that fails, the item is `partial` and says the user must reconnect. Evidence: unit test with a mocked GitHub API.
- [ ] Progress events go to the existing `EVENTS_CHANNEL`/WebSocket. Evidence: test that subscribes and sees each transition.

## Hand 80/443 from Traefik to Caddy (MIG-4)

- [ ] Read Dokploy's Traefik `acme.json` (`/etc/dokploy/traefik/dynamic/acme.json`). Import each certificate that is still valid for a migrated hostname into Caddy's storage, so Caddy serves it from the first second and renews it later. Evidence: unit test on a fixture `acme.json`, plus a live check that Caddy serves the imported certificate's serial.
- [ ] Fix the node-sync bug: the ingress label must be written to the DB first, so the worker does not revert it. Evidence: regression test.
- [ ] The switch, as one worker job:
  - [ ] Stop `dokploy-traefik`, whether it runs as a container or a service, matched by exact name.
  - [ ] Set ingress on the node and wait for Caddy to bind 80/443.
  - [ ] Probe every migrated domain over HTTPS.
  - [ ] If Caddy does not come up within the timeout, start Traefik again.
  - Evidence: integration test plus the measured gap in MIG-8.

## Detect Dokploy in install.sh (MIG-5)

- [ ] Detect Dokploy from the Swarm service `dokploy` or the directory `/etc/dokploy`, and Coolify from the container `coolify` or `/data/coolify`. Coolify detection only prints "Coolify migration is not supported yet" for now. Evidence: `smoke.sh` case with a fake `dokploy` service.
- [ ] When Dokploy is found, `install.sh` explains the plan, then installs with `--no-ingress` and the private setup. It allows ports 80/443 held by Dokploy's Traefik, and it writes `migration_source=dokploy` to `/etc/logistack`. Evidence: smoke output.
- [ ] Mount `/etc/dokploy` read-only into the api so the wizard can read compose files and `acme.json`. Connect to Dokploy's Postgres over its overlay network, using the credentials Dokploy keeps on disk. Never print them. Evidence: smoke check that the api can list Dokploy projects.
- [ ] `docs/INSTALL.md` has a "Migrating from Dokploy" section. Evidence: the doc.

## Migration wizard in the UI (MIG-6)

Load the UI skills listed in CLAUDE.md before starting.

- [ ] After admin setup, when `migration_source` is set, the dashboard opens the wizard. It can also be reached from Settings → Migrate. Evidence: screenshot.
- [ ] Step 1, Inventory: a table grouped by project. Each item shows its status (full, partial, unsupported) and why. Items can be excluded. Evidence: screenshots, light and dark, at 1440 and 390 px.
- [ ] Step 2, Import: shows live progress. A retry of a failed item runs that item only. Evidence: video.
- [ ] Step 3, Cutover: services one at a time or all in sequence. Each row has a status, logs and a "Roll back" button. Databases go before the apps that use them. Evidence: video.
- [ ] Step 4, Proxy: lists the certificates imported, then a "Switch traffic" button. The domain probes show live. Evidence: video.
- [ ] Step 5, Summary and decommission (MIG-7). Evidence: screenshot.
- [ ] The whole wizard works from the keyboard and resumes on reload at the current step. Evidence: keyboard-only video, plus a reload partway through.

## Decommission Dokploy (MIG-7)

- [ ] Archive under `/var/lib/logistack/migration/<timestamp>/`: a `pg_dump` of Dokploy's DB, a tarball of `/etc/dokploy`, and the inventory JSON. Evidence: files exist and the dump restores into a scratch Postgres.
- [ ] Remove Dokploy's Swarm services (`dokploy`, `dokploy-postgres`, `dokploy-redis`, `dokploy-traefik`) and its app services and containers, matched by Dokploy's own labels or the exact names in the inventory. Remove the `dokploy-network` once it is empty. Volumes stay. Evidence: integration test listing what is left.
- [ ] Do not decommission while any migrated item is not `cut_over` or `skipped`. Evidence: unit test.
- [ ] A later "Purge archive and old volumes" action is confirmed by typing the server name. It never deletes adopted volumes. Evidence: test.

## Prove it end to end (MIG-8)

- [ ] `SMOKE_MIGRATE=1 bash install/smoke.sh` runs in DinD (`ls-test-mig-dind`):
  - [ ] Install a pinned Dokploy version.
  - [ ] Seed it through its API with an image app with a domain, a git app, a postgres with data, a 3-service compose and an S3 backup.
  - [ ] Run `install.sh`, drive the wizard through the API, and decommission.
  - [ ] Check that the data is intact, the domains answer, and Dokploy is gone.
  - Evidence: CI log.
- [ ] Live run on a fresh VPS with real Dokploy and real domains. Record the HTTP downtime per service and for the proxy switch. Evidence: probe log with timestamps.

## Risks

- **Dokploy schema drift.** We read its DB directly. Mitigation: pin the tested versions, refuse unknown ones, and keep a fixture per supported version.
- **Compose split semantics.** Shared anonymous volumes, `network_mode: service:x` and `links` do not map. They stay `unsupported` and are listed.
- **Adopted volumes break rule 4** (labels on everything we create). We did not create these volumes, and the `adopted_volume` table is the replacement guard. Cleanup code must check it. This is the riskiest invariant in the program.
- **Let's Encrypt rate limits.** They only matter if certificate import fails. The import exists so that the switch does not trigger N new issuances at once.

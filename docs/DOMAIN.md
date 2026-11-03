# Domain model

Source of truth for entity shapes. `packages/db` implements it in Drizzle, `packages/contracts` mirrors it in zod. IDs are text (`cuid2`-style, prefixed: `prj_`, `svc_`, `dep_`...). Every table has `created_at`, `updated_at`. Every org-owned row has `organization_id`.

## Identity (better-auth owns these tables)

`user`, `session`, `account`, `verification`, `two_factor`, `passkey`, `organization`, `member`, `invitation`, `apikey`, `sso_provider`. `user.kind`: `human | machine` (machine = service account, API keys only).

## Hierarchy

- `folder` — `id, organization_id, parent_id?, name, slug, position`. Depth ≤ 2 (a folder with a parent cannot itself be a parent). Enforced in `core` and by a check trigger.
- `project` — `id, organization_id, folder_id?, name, slug, description`.
- `environment` — `id, project_id, name, slug, kind: production|staging|preview|custom, is_default`.
- `service` — `id, environment_id, name, slug, kind: application|database|compose|storage, node_id? (pinned when stateful), spec jsonb, desired_state: running|stopped, created_by, imported_from?`. `imported_from` is provenance (`dokploy:<appName>/<service>`), kept outside `spec` so spec edits never drop it; a re-import skips a service that carries it.
  - `spec` is a discriminated union by `kind` (zod in contracts):
    - application: `source` (git repo+branch+path | image ref), `build` (`dockerfile|railpack|static|image` + options), `ports[] {target, published?, protocol: tcp|udp, mode?: host|ingress (default host)}`, `replicas`, `resources {cpu, memory}`, `healthcheck`, `command?`, `placement[]`, `mounts?[] {kind: bind, hostPath, target, readOnly?, allowSensitiveHostPath?}` (admin only; pins the service to `node_id`), `user?` (`uid[:gid]`), `capAdd?[]`, `capDrop?[]`, `restart?: any|on-failure|none`.
    - database: `engine: postgres|mysql|mariadb|mongo|redis`, `version`, `credentials_ref`, `resources`.
    - compose: `source` (inline | git path), `original_yaml`, `services_overrides`.
    - storage: `engine: minio|rustfs|garage|seaweedfs`, `resources`. Root credentials are minted by `service.create` into secret service env vars (`STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, Garage also `STORAGE_ADMIN_TOKEN`, `STORAGE_RPC_SECRET`); the image is pinned per engine in `core/storage.ts`. The public S3 endpoint and the console are ordinary `domain` rows on the engine's S3 or console port.
- `env_var` — `id, scope: organization|project|environment|service, scope_id, key, value_encrypted, is_secret, is_build_time`. Resolution order org → project → environment → service.
- `mount` — `id, service_id, kind: volume|config|secret, target, volume_name? (volume), content_encrypted? (config/secret), read_only`.

## Runtime

- `node` — `id, organization_id, swarm_node_id, hostname, address, role: manager|worker, labels jsonb, status: pending|ready|down|draining, agent_version, last_seen_at`.
- `deployment` — `id, service_id, status` (state machine below), `trigger: manual|git_push|webhook|rollback|schedule|api, commit_sha?, commit_message?, image_ref?, started_at, finished_at, error?, log_path, superseded_by?`.
  - States: `queued → cloning → building → pushing → deploying → healthy | failed | cancelled | superseded`. `cloning/building/pushing` are skipped for image sources. Transitions only through `core/deployment.ts`.
- `service_status` — `service_id PK, observed: running|starting|unhealthy|stopped|failed|unknown, replicas_running, replicas_desired, tasks jsonb, observed_at`. Written by reconciler/agent events only.

## Networking & TLS

- `domain` — `id, service_id, hostname, port, path_prefix?, https: boolean, cert: auto|custom|none, custom_certificate_id?, redirect_to?, is_generated (sslip/nip), dns_provider_id?, dns_record_id?, status: pending|active|error, status_message?`.
- `certificate` — custom uploads: `id, organization_id, name, cert_pem, key_pem_encrypted, not_after, sans[]`.
- `dns_provider` — `id, organization_id, kind: cloudflare|route53|hetzner|digitalocean|ovh|porkbun, name, credentials_encrypted, zones_cache jsonb`.

## Integrations

- `git_provider` — `id, organization_id, kind: github|gitlab|gitea|bitbucket|generic, name, config_encrypted jsonb` (GitHub App id/private key/webhook secret; OAuth tokens...).
- `registry` — `id, organization_id, kind: local|ghcr|dockerhub|gitlab|generic, url, username, password_encrypted, is_default`.
- `ssh_key` — `id, organization_id, name, public_key, private_key_encrypted, fingerprint`.
- `s3_destination` — `id, organization_id, name, endpoint, region, bucket, prefix, access_key_id, secret_encrypted, force_path_style, storage_service_id?`. With `storage_service_id` the worker derives the endpoint from the service id on `ls-storage` and skips the SSRF check.

## Storage

- `storage_access_key` — `id, service_id, name, access_key_id, buckets text[], access: read|readwrite, created_by`. A scoped key LogiStack created in the engine (MinIO/RustFS service account with an inline policy, Garage key with per-bucket grants, SeaweedFS IAM user with a user policy). The secret is returned once and never stored.

### Engines and images

| Engine | Image (pinned by digest) | S3 / console | Versioning, policies | Usage |
| --- | --- | --- | --- | --- |
| MinIO | `cgr.dev/chainguard/minio` RELEASE.2026-10-23T20-06-51Z. MinIO stopped publishing community images in 2025 (`minio/minio` is gone from Docker Hub); Chainguard builds each release from source. | 9000 / 9001 | yes, yes | `datausageinfo` |
| RustFS | `rustfs/rustfs:1.0.4` | 9000 / 9001 | yes, yes | `datausageinfo` |
| Garage | `dxflrs/garage:v2.5.0` | 3900 / none (admin API 3903, never published) | no, no | admin `GetBucketInfo` |
| SeaweedFS | `chrislusf/seaweedfs:4.52` (`weed mini`) | 8333 / none | yes, yes | none |

Garage starts without a layout or keys; the api bootstraps it through the admin API on first use (assign the node, apply the layout, import the root key) and creates buckets with a global alias so scoped keys can address them by name.

### Network

The api and worker live on `ls-control`, storage on its environment network. Storage services also join `ls-storage`, a static overlay the api and worker join in the stack, so neither ever needs a `service update` (which restarts tasks) per environment. Apps never join `ls-storage`; storage tasks see each other there (each is authenticated S3), the same trade-off as `ls-ingress`. Object uploads stream from the browser through the api into a multipart upload (8 MiB parts), so storage needs no public endpoint or CORS; share links are S3 presigned URLs when the service has a public S3 domain, otherwise api links sealed with the master key.

## Operations

- `backup_policy` — `id, service_id, target: database|volume, volume_name?, s3_destination_id, cron, timezone, retention {count?, days?}, verify_cron?, enabled`.
- `backup_run` — `id, policy_id, status: running|succeeded|failed, size_bytes, object_key, checksum, started_at, finished_at, error?, kind: backup|verify|restore`.
- `schedule` — `id, organization_id, project_id?, name, cron, timezone, script, target: {kind: ephemeral, image} | {kind: service, service_id} | {kind: host, node_id}, timeout_s, concurrency: forbid|allow|replace, enabled`.
- `schedule_run` — `id, schedule_id, status, exit_code?, output (truncated), started_at, finished_at`.
- `notification_channel` — `id, organization_id, kind: email|slack|discord|telegram|teams|mattermost|ntfy|gotify|pushover|webhook, name, config_encrypted jsonb`.
- `notification_rule` — `id, organization_id, events text[], scope {project_id?, service_id?}, channel_id, enabled`.
- `audit_log` — `id, organization_id, actor {kind: user|apikey|machine|system, id}, action, resource_type, resource_id, diff jsonb (secrets redacted), ip, user_agent, request_id, outcome: success|denied|error, at`. Append-only, monthly partitions.

## Settings

- `instance_settings` — singleton: `setup_completed, public_url, primary_domain?, letsencrypt_email, generated_domain_base: sslip|nip|custom, custom_wildcard?, local_registry_enabled`.

## Permissions

Actions: `read`, `read:secrets`, `deploy`, `write`, `delete`, `admin`. Scope chain: organization → folder → project → environment → service; a grant on a scope applies to everything below it. Built-in roles: `owner` (all), `admin` (all but org deletion/billing-like), `developer` (read, deploy, write on granted scopes), `viewer` (read). Custom roles allowed. Single entry point `can(actor, action, resource)` in `packages/core`.

## Events (bus + realtime + notifications + audit)

`deployment.{queued,started,succeeded,failed,cancelled}`, `service.status_changed`, `backup.{succeeded,failed}`, `schedule.{succeeded,failed}`, `node.{joined,down,recovered}`, `certificate.{issued,failed,expiring}`, `domain.{active,error}`. Envelope: `{id, type, organization_id, resource {type,id}, payload, at}`.

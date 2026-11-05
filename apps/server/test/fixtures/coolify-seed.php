<?php
// Seeds a Coolify database through Coolify's own models, so every row is written, cast and
// encrypted the way Coolify writes it. Run inside the pinned coollabsio/coolify image against a
// scratch Postgres it has just migrated (apps/server/test/coolify-schema.ts). Test data only.
require "vendor/autoload.php";
$app = require "bootstrap/app.php";
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use App\Models\Application;
use App\Models\Environment;
use App\Models\EnvironmentVariable;
use App\Models\GithubApp;
use App\Models\PrivateKey;
use App\Models\Project;
use App\Models\S3Storage;
use App\Models\ScheduledDatabaseBackup;
use App\Models\Server;
use App\Models\Service;
use App\Models\ServiceApplication;
use App\Models\ServiceDatabase;
use App\Models\SharedEnvironmentVariable;
use App\Models\StandaloneDocker;
use App\Models\StandalonePostgresql;
use App\Models\Team;
use Illuminate\Database\Eloquent\Model;

Model::unguard();
$key = "-----BEGIN OPENSSH PRIVATE KEY-----\nfake-coolify-ssh-key\n-----END OPENSSH PRIVATE KEY-----";

Model::withoutEvents(function () use ($key) {
    $team = Team::forceCreate(["id" => 0, "name" => "Root Team", "personal_team" => false]);
    $pk = PrivateKey::forceCreate(["id" => 1, "uuid" => "pk1", "name" => "localhost key", "private_key" => $key, "team_id" => 0, "is_git_related" => false]);
    $server = Server::forceCreate(["id" => 0, "uuid" => "srv0", "name" => "localhost", "ip" => "host.docker.internal", "user" => "root", "port" => 22, "team_id" => 0, "private_key_id" => 1]);
    $dest = StandaloneDocker::forceCreate(["id" => 1, "uuid" => "dst1", "name" => "coolify", "network" => "coolify", "server_id" => 0]);
    $project = Project::forceCreate(["id" => 1, "uuid" => "prj1", "name" => "Shop", "team_id" => 0]);
    $env = Environment::forceCreate(["id" => 1, "uuid" => "env1", "name" => "production", "project_id" => 1]);
    SharedEnvironmentVariable::forceCreate(["key" => "REGION", "value" => "eu-west", "type" => "project", "team_id" => 0, "project_id" => 1]);

    $pg = StandalonePostgresql::forceCreate([
        "id" => 1, "uuid" => "pgk8s0wc8gw4o0c4ws0ok", "name" => "shop-db", "image" => "postgres:17-alpine",
        "postgres_user" => "shop", "postgres_password" => "fake-coolify-pg-secret", "postgres_db" => "shop",
        "environment_id" => 1, "destination_type" => StandaloneDocker::class, "destination_id" => 1,
        "status" => "running:healthy",
    ]);
    $pg->persistentStorages()->forceCreate(["uuid" => "seed2", "name" => "postgres-data-pgk8s0wc8gw4o0c4ws0ok", "mount_path" => "/var/lib/postgresql/data", "resource_type" => StandalonePostgresql::class, "resource_id" => 1]);

    $web = Application::forceCreate([
        "id" => 1, "uuid" => "webq0c8o4wk4gk8ows8sg", "name" => "shop-web", "environment_id" => 1,
        "destination_type" => StandaloneDocker::class, "destination_id" => 1,
        "fqdn" => "https://shop.example.com,http://www.shop.example.com", "git_repository" => "coollabsio/coolify", "git_branch" => "main",
        "build_pack" => "dockerimage", "docker_registry_image_name" => "nginx", "docker_registry_image_tag" => "1.27-alpine",
        "ports_exposes" => "80", "status" => "running:healthy",
    ]);
    $web->settings()->forceCreate(["application_id" => 1]);
    EnvironmentVariable::forceCreate(["uuid" => "seed3", "key" => "DATABASE_URL", "value" => "postgres://shop:fake-coolify-pg-secret@pgk8s0wc8gw4o0c4ws0ok:5432/shop", "resourceable_type" => Application::class, "resourceable_id" => 1, "is_preview" => false]);
    EnvironmentVariable::forceCreate(["uuid" => "seed4", "key" => "REGION", "value" => "{{project.REGION}}", "resourceable_type" => Application::class, "resourceable_id" => 1, "is_preview" => false]);
    EnvironmentVariable::forceCreate(["uuid" => "seed5", "key" => "DATABASE_URL", "value" => "preview-only", "resourceable_type" => Application::class, "resourceable_id" => 1, "is_preview" => true]);

    $svc = Service::forceCreate([
        "id" => 1, "uuid" => "svcm4sgkso8c0gw0skwcg", "name" => "blog", "environment_id" => 1, "server_id" => 0,
        "destination_type" => StandaloneDocker::class, "destination_id" => 1, "service_type" => "custom",
        "docker_compose_raw" => "services:\n  app:\n    image: nginx:1.27-alpine\n    environment:\n      - SERVICE_FQDN_APP_80\n      - CACHE_URL=redis://cache:6379\n      - SECRET=\${SERVICE_PASSWORD_APP}\n    depends_on: [cache]\n    healthcheck:\n      test: [\"CMD\", \"true\"]\n  cache:\n    image: redis:7-alpine\n    volumes:\n      - cache-data:/data\n    exclude_from_hc: true\n",
    ]);
    ServiceApplication::forceCreate(["id" => 1, "uuid" => "sa1", "name" => "app", "service_id" => 1, "fqdn" => "https://blog.example.com:80", "image" => "nginx:1.27-alpine", "status" => "running:healthy"]);
    ServiceDatabase::forceCreate(["id" => 1, "uuid" => "sd1", "name" => "cache", "service_id" => 1, "image" => "redis:7-alpine", "status" => "running:healthy"]);
    EnvironmentVariable::forceCreate(["uuid" => "seed6", "key" => "SERVICE_PASSWORD_APP", "value" => "fake-coolify-svc-secret", "resourceable_type" => Service::class, "resourceable_id" => 1, "is_preview" => false]);
    EnvironmentVariable::forceCreate(["uuid" => "seed7", "key" => "SERVICE_FQDN_APP_80", "value" => "blog.example.com", "resourceable_type" => Service::class, "resourceable_id" => 1, "is_preview" => false]);
    \App\Models\LocalPersistentVolume::forceCreate(["uuid" => "seed8", "name" => "svcm4sgkso8c0gw0skwcg_cache-data", "mount_path" => "/data", "resource_type" => ServiceDatabase::class, "resource_id" => 1]);

    $s3 = S3Storage::forceCreate(["id" => 1, "uuid" => "s31", "name" => "minio", "region" => "us-east-1", "key" => "fake-s3-access", "secret" => "fake-s3-secret", "bucket" => "backups", "endpoint" => "https://minio.example.com", "team_id" => 0]);
    ScheduledDatabaseBackup::forceCreate(["id" => 1, "uuid" => "bk1", "enabled" => true, "save_s3" => true, "frequency" => "daily", "database_type" => StandalonePostgresql::class, "database_id" => 1, "s3_storage_id" => 1, "team_id" => 0, "database_backup_retention_amount_s3" => 7]);

    $ghKey = PrivateKey::forceCreate(["id" => 2, "uuid" => "pk2", "name" => "github app key", "private_key" => $key, "team_id" => 0, "is_git_related" => true]);
    GithubApp::forceCreate(["id" => 1, "uuid" => "gh1", "name" => "acme-coolify", "api_url" => "https://api.github.com", "html_url" => "https://github.com", "app_id" => 123, "installation_id" => 456, "client_id" => "cid", "client_secret" => "fake-gh-client-secret", "webhook_secret" => "fake-gh-webhook-secret", "private_key_id" => 2, "team_id" => 0, "is_public" => false]);

    \App\Models\DiscordNotificationSettings::forceCreate(["team_id" => 0, "discord_enabled" => true, "discord_webhook_url" => "https://discord.com/api/webhooks/1/fake-discord-token", "deployment_success_discord_notifications" => true, "backup_failure_discord_notifications" => true]);
});
echo "seeded\n";

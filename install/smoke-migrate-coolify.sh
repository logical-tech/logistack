#!/usr/bin/env bash
# `check && pass || fail` is intended: pass only prints, so fail runs only when the check failed.
# shellcheck disable=SC2015,SC2016,SC2317,SC2329
# The Coolify migration end to end (COOL-8), in a throwaway docker:dind named ls-test-cool8-dind:
#   1. Coolify (pinned, v4.5.3) brought up the way its installer leaves it: Docker's address pool
#      10.0.0.0/8, /data/coolify with its .env and its SSH key to the host, the `coolify` network,
#      and Coolify's own compose files read from a Coolify checkout at the pinned tag (COOLIFY_SRC).
#   2. Seeded through its own API (a root user and token made in its tinker, the API switched on):
#      an image app with a domain and a DATABASE_URL to a Postgres with a row of data and an S3
#      backup, and a two-service compose stored as a one-click service, with a domain and Coolify's
#      magic variables. Coolify deploys them.
#   3. install.sh --local-build next to it, setup, then the migration wizard driven through
#      LogiStack's API: plan, import, cut every item over, switch traffic, remove Coolify.
#   4. Checks along the way: the row survives, every domain keeps answering through each cutover,
#      the proxy switch's HTTP gap is measured, and Coolify is gone with its archive on disk.
# Touches only the ls-test-cool8-dind container. KEEP=1 leaves it running for inspection;
# STOP_AFTER=coolify|seed stops early, to iterate on a phase.
#   bash install/smoke-migrate-coolify.sh
set -euo pipefail

NAME=${SMOKE_NAME:-ls-test-cool8-dind}
LABEL=${SMOKE_LABEL:-cool8}
DIND_IMAGE=${DIND_IMAGE:-docker:29-dind}
COOLIFY_VERSION=${COOLIFY_VERSION:-4.5.3}
COOLIFY_HELPER=${COOLIFY_HELPER:-1.0.19}
COOLIFY_SENTINEL=${COOLIFY_SENTINEL:-1.1.3}
COOLIFY_SRC=${COOLIFY_SRC:-$HOME/Documents/projects/logical/coolify}
MINIO_IMAGE=${MINIO_IMAGE:-bitnamilegacy/minio:2025.7.23}
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

if [ "${1:-}" != --inside ]; then
	docker rm -f -v "$NAME" >/dev/null 2>&1 || true
	# What Coolify's installer writes into daemon.json; the comma is dockerd's syntax.
	# shellcheck disable=SC2054
	docker run -d --privileged --name "$NAME" --label "logistack.test=$LABEL" -v "$ROOT:/src:ro" "$DIND_IMAGE" \
		--default-address-pool base=10.0.0.0/8,size=24 >/dev/null
	for _ in $(seq 1 60); do docker exec "$NAME" docker info >/dev/null 2>&1 && break; sleep 1; done
	docker exec "$NAME" apk add --no-cache -q bash curl jq openssh-server openssh-client
	# Coolify's compose files at the pinned tag: read from its checkout, never copied into this repo.
	docker exec "$NAME" mkdir -p /data/coolify/source
	for f in docker-compose.yml docker-compose.prod.yml; do
		git -C "$COOLIFY_SRC" show "v$COOLIFY_VERSION:$f" | docker exec -i "$NAME" sh -c "cat > /data/coolify/source/$f"
	done
	# Docker Hub caps anonymous pulls per address: images come from this host's cache instead.
	preload=("coollabsio/coolify:$COOLIFY_VERSION" "coollabsio/coolify-helper:$COOLIFY_HELPER"
		"coollabsio/sentinel:$COOLIFY_SENTINEL" postgres:15-alpine postgres:17-alpine redis:7-alpine
		traefik:v3.7 nginx:alpine alpine:3.22 busybox:1.37 "$MINIO_IMAGE"
		# install.sh --local-build's bases.
		oven/bun:1.4 oven/bun:1.4-slim gcr.io/distroless/cc-debian12 caddy:2.11.7-builder-alpine caddy:2.11.7-alpine)
	for image in "${preload[@]}"; do
		docker image inspect "$image" >/dev/null 2>&1 || docker pull -q "$image" >/dev/null
	done
	docker save "${preload[@]}" | docker exec -i "$NAME" docker load -q >/dev/null
	rc=0
	docker exec -e LOGISTACK_WAIT_TIMEOUT="${LOGISTACK_WAIT_TIMEOUT:-900}" -e COOLIFY_VERSION="$COOLIFY_VERSION" \
		-e MINIO_IMAGE="$MINIO_IMAGE" -e STOP_AFTER="${STOP_AFTER:-}" "$NAME" bash /src/install/smoke-migrate-coolify.sh --inside || rc=$?
	[ "${KEEP:-0}" = 1 ] || docker rm -f -v "$NAME" >/dev/null
	exit "$rc"
fi

# Inside the dind container from here on.
FAILED=0
last=$SECONDS
pass() { printf 'PASS  %-70s %4ss\n' "$1" $((SECONDS - last)); last=$SECONDS; }
fail() {
	printf 'FAIL  %-70s %4ss  %s\n' "$1" $((SECONDS - last)) "$2"
	FAILED=1
	last=$SECONDS
}
die() {
	fail "$1" "$2"
	docker ps -a --format '{{.Names}} {{.Status}} {{.Image}}' | head -40 || true
	exit 1
}
rand() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
# until_ok SECONDS CMD...: retries CMD every 2 s.
until_ok() {
	local deadline=$((SECONDS + $1))
	shift
	until "$@" >/dev/null 2>&1; do
		[ "$SECONDS" -lt "$deadline" ] || return 1
		sleep 2
	done
}
# What a visitor of HOST gets on this server's port 80, whoever holds it.
visit() { curl -s --max-time 3 -H "Host: $1" http://127.0.0.1/ || true; }
# PHP inside Coolify, as its own models see the database; the script comes on stdin.
tinker() { docker exec -i coolify php -d display_errors=stderr; }

ip=$(hostname -i | awk '{ print $1 }')

# ---- 1. Coolify, as its installer leaves it -------------------------------------------------

mkdir -p /data/coolify/{source,ssh/keys,ssh/mux,applications,databases,backups,services,proxy/dynamic,sentinel,images}
app_key="base64:$(head -c 32 /dev/urandom | base64)"
cat >/data/coolify/source/.env <<EOF
APP_ID=$(rand 16)
APP_NAME=Coolify
APP_KEY=$app_key
DB_USERNAME=coolify
DB_PASSWORD=$(rand 16)
REDIS_PASSWORD=$(rand 16)
PUSHER_APP_ID=$(rand 16)
PUSHER_APP_KEY=$(rand 16)
PUSHER_APP_SECRET=$(rand 16)
REGISTRY_URL=docker.io
LATEST_IMAGE=$COOLIFY_VERSION
EOF
chmod 600 /data/coolify/source/.env
# Coolify reaches its own host over SSH as root, with this key.
ssh-keygen -t ed25519 -f /data/coolify/ssh/keys/id.root@host.docker.internal -q -N "" -C coolify
mkdir -p /root/.ssh && chmod 700 /root/.ssh
cat /data/coolify/ssh/keys/id.root@host.docker.internal.pub >>/root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
rm /data/coolify/ssh/keys/id.root@host.docker.internal.pub
chown -R 9999:root /data/coolify/ssh /data/coolify/source /data/coolify/images
chmod -R 700 /data/coolify/ssh /data/coolify/source /data/coolify/images
ssh-keygen -A >/dev/null
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
/usr/sbin/sshd
docker network create --attachable coolify >/dev/null
(cd /data/coolify/source && LATEST_IMAGE=$COOLIFY_VERSION docker compose --env-file .env -f docker-compose.yml \
	-f docker-compose.prod.yml up -d --pull never --wait --wait-timeout 600 >/tmp/coolify-up.log 2>&1) ||
	die "Coolify up" "$(tail -n 20 /tmp/coolify-up.log)"
until_ok 300 curl -fs http://127.0.0.1:8000/api/health || die "Coolify healthy" "no answer on :8000"
pass "Coolify $COOLIFY_VERSION up: coolify, coolify-db, coolify-redis on network coolify ($(docker network inspect coolify -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}'))"

# Root user, team and token through Coolify's own models; the API on, as its settings page would.
root_pw=$(rand 12)
token=$(tinker <<PHP | tail -n1
<?php
require "vendor/autoload.php";
\$app = require "bootstrap/app.php";
\$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
\$team = App\Models\Team::find(0) ?? App\Models\Team::forceCreate(["id" => 0, "name" => "Root Team", "personal_team" => false]);
\$user = App\Models\User::find(0) ?? App\Models\User::forceCreate(["id" => 0, "name" => "Root", "email" => "root@smoke.test", "password" => Illuminate\Support\Facades\Hash::make("$root_pw")]);
if (!\$user->teams()->where("team_id", 0)->exists()) \$user->teams()->attach(0, ["role" => "owner"]);
App\Models\InstanceSettings::get()->update(["is_api_enabled" => true, "is_registration_enabled" => false]);
echo \$user->createToken("smoke", ["root"], null, 0)->plainTextToken, "\n";
PHP
)
[[ $token == *"|"* ]] || die "Coolify root token" "got '$token'"
CF=http://127.0.0.1:8000/api/v1
# cf METHOD PATH [JSON]: a Coolify API call; sets $cf_body. Not for $(...): die would only leave the subshell.
cf() {
	local out
	out=$(curl -sS -w '\n%{http_code}' -X "$1" -H "Authorization: Bearer $token" -H 'content-type: application/json' \
		-H 'accept: application/json' ${3:+--data "$3"} "$CF$2")
	cf_body=${out%$'\n'*}
	[[ ${out##*$'\n'} == 2* ]] || die "Coolify $1 $2" "HTTP ${out##*$'\n'}: $(head -c 400 <<<"$cf_body")"
}
cf GET /servers
server=$(jq -r '.[] | select(.id == 0 or .name == "localhost") | .uuid' <<<"$cf_body" | head -n1)
[ -n "$server" ] || die "Coolify's localhost server" "$(head -c 300 <<<"$cf_body")"
# Coolify validates its own host over SSH, then starts its proxy on 80/443.
reachable() { cf GET "/servers/$server" && [ "$(jq -r '.settings.is_reachable' <<<"$cf_body")" = true ]; }
curl -s -o /dev/null -X POST -H "Authorization: Bearer $token" "$CF/servers/$server/validate" || true
until_ok 300 reachable || die "Coolify reaches its host over SSH" "$(jq -c '.settings | {is_reachable, is_usable}' <<<"$cf_body")"
until_ok 300 sh -c '[ "$(docker inspect -f "{{.State.Running}}" coolify-proxy 2>/dev/null)" = true ]' ||
	die "Coolify starts its proxy" "coolify-proxy not running"
pass "Coolify's own SSH reaches the host; coolify-proxy holds 80/443"
[ "${STOP_AFTER:-}" = coolify ] && exit "$FAILED"

# ---- 2. Seed it through its own API ---------------------------------------------------------

db_pw=$(rand 12)
cf POST /projects '{"name":"Shop"}'
project=$(jq -r .uuid <<<"$cf_body")
where=$(jq -n --arg p "$project" --arg s "$server" '{project_uuid: $p, server_uuid: $s, environment_name: "production"}')
cf POST /databases/postgresql "$(jq -n --argjson w "$where" --arg p "$db_pw" \
	'$w + {name: "shop-db", image: "postgres:17-alpine", postgres_user: "shop", postgres_password: $p, postgres_db: "shop", instant_deploy: true}')"
db=$(jq -r .uuid <<<"$cf_body")

# S3 on a private address: Coolify's API refuses those (SafeWebhookUrl), so the row comes from its model.
s3_secret=$(rand 16)
docker run -d -q --name ls-test-cool8-minio --network coolify -e MINIO_ROOT_USER=smoke -e MINIO_ROOT_PASSWORD="$s3_secret" \
	-e MINIO_DEFAULT_BUCKETS=backups "$MINIO_IMAGE" >/dev/null
s3=$(tinker <<PHP | tail -n1
<?php
require "vendor/autoload.php";
\$app = require "bootstrap/app.php";
\$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
// As Settings > Advanced would: let the backups of Coolify reach this private MinIO.
App\Models\InstanceSettings::get()->update(["webhook_allowed_internal_hosts" => ["ls-test-cool8-minio"]]);
\$s = App\Models\S3Storage::forceCreate(["uuid" => "s3smoke", "name" => "MinIO", "region" => "us-east-1", "key" => "smoke", "secret" => "$s3_secret", "bucket" => "backups", "endpoint" => "http://ls-test-cool8-minio:9000", "team_id" => 0, "is_usable" => true]);
echo \$s->uuid, "\n";
PHP
)
[ "$s3" = s3smoke ] || die "Coolify S3 storage" "got '$s3'"

cf POST /applications/dockerimage "$(jq -n --argjson w "$where" \
	'$w + {name: "web", docker_registry_image_name: "nginx", docker_registry_image_tag: "alpine", ports_exposes: "80", domains: "http://web.smoke.test", instant_deploy: false}')"
web=$(jq -r .uuid <<<"$cf_body")
cf POST "/applications/$web/envs" "$(jq -n --arg u "postgres://shop:$db_pw@$db:5432/shop" '{key: "DATABASE_URL", value: $u}')"
cf POST "/deploy?uuid=$web&force=false"

compose='services:
  web:
    image: nginx:alpine
    environment:
      - SERVICE_FQDN_WEB_80
      - CACHE_URL=redis://cache:6379
      - SECRET=${SERVICE_PASSWORD_WEB}
    depends_on: [cache]
  cache:
    image: redis:7-alpine
    volumes:
      - cache-data:/data
'
cf POST /services "$(jq -n --argjson w "$where" --arg c "$(printf '%s' "$compose" | base64 | tr -d '\n')" \
	'$w + {name: "blog", docker_compose_raw: $c, urls: [{name: "web", url: "http://blog.smoke.test"}], instant_deploy: true}')"
blog=$(jq -r .uuid <<<"$cf_body")
printf "      Coolify uuids: shop-db %s, web %s, blog %s\n" "$db" "$web" "$blog"

running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ]; }
until_ok 300 running "$db" || die "Coolify deploys shop-db" "container $db not running"
row() { docker exec "$db" psql -U shop -d shop -tAc "$1"; }
until_ok 120 row "select 1" || die "shop-db answers" "psql failed"
row "create table orders (id int); insert into orders values (42)" >/dev/null
cf POST "/databases/$db/backups" "$(jq -n '{frequency: "0 3 * * *", enabled: true, save_s3: true, s3_storage_uuid: "s3smoke", database_backup_retention_amount_s3: 5, backup_now: true}')"
answers() { visit "$1" | grep -q nginx; }
until_ok 600 answers web.smoke.test || die "Coolify routes web.smoke.test" "$(visit web.smoke.test | head -c 160)"
until_ok 600 answers blog.smoke.test || die "Coolify routes blog.smoke.test" "$(visit blog.smoke.test | head -c 160)"
backed_up() { docker exec ls-test-cool8-minio sh -c 'find /bitnami/minio/data/backups -type f -name "*.dmp*" -o -type d -name "*.dmp" | grep -q .'; }
until_ok 180 backed_up && pass "Coolify's backup of shop-db is in MinIO" || fail "Coolify backup to S3" "no dump in the bucket"
pass "seeded through Coolify's API: web (DATABASE_URL to $db), shop-db (pg 17, row 42, S3 backup), blog x2"
[ "${STOP_AFTER:-}" = seed ] && exit "$FAILED"

# ---- 3. LogiStack next to it ----------------------------------------------------------------

bash /src/install/install.sh --local-build --yes --advertise-addr "$ip" >/tmp/install.out 2>&1 || {
	tail -n 40 /tmp/install.out
	die "install.sh next to Coolify" "installer failed"
}
grep -q 'Coolify found' /tmp/install.out && pass "install.sh: Coolify found, ingress off, $(grep -o 'address pool [0-9][0-9./]*' /tmp/install.out | head -n1)" ||
	fail "install.sh detection" "no 'Coolify found'"

# Coolify keeps working on a host that now runs a Swarm: its UI, its proxy, and a redeploy.
names() { docker ps --filter "label=com.docker.compose.project=$web" --filter status=running --format '{{.Names}}' | sort | tr '\n' ' '; }
before=$(names)
cf POST "/deploy?uuid=$web&force=true"
redeployed() { now=$(names) && [ -n "$now" ] && [ "$now" != "$before" ]; }
until_ok 300 redeployed && curl -fs http://127.0.0.1:8000/api/health >/dev/null && answers web.smoke.test &&
	pass "Coolify works with Swarm on: UI healthy, web redeployed ($before→ $now), routed" ||
	fail "Coolify after swarm init" "containers '$before' → '$(names)', site '$(visit web.smoke.test | head -c 80)'"

API=http://127.0.0.1:3000
ORIGIN=""
CURL=(curl)
req() {
	local out
	out=$("${CURL[@]}" -sS -w '\n%{http_code}' -X "$1" -b /tmp/jar -c /tmp/jar -H "Origin: $ORIGIN" \
		-H 'content-type: application/json' ${3:+--data "$3"} "$API$2")
	code=${out##*$'\n'}
	body=${out%$'\n'*}
}
PUBLIC_URL=$(docker service inspect logistack_logistack-api --format '{{json .Spec.TaskTemplate.ContainerSpec.Env}}' |
	jq -r '.[] | select(startswith("BETTER_AUTH_URL=")) | sub("^BETTER_AUTH_URL="; "")')
ORIGIN=$PUBLIC_URL
owner=owner@smoke.test
owner_pw=$(rand 12)
req POST /api/setup "$(jq -n --arg e "$owner" --arg p "$owner_pw" --arg u "$PUBLIC_URL" '{
	owner: { name: "Smoke Owner", email: $e, password: $p },
	organization: { name: "Smoke" },
	instance: { publicUrl: $u, generatedDomainBase: "sslip", letsencryptEmail: "ops@smoke.test", localRegistryEnabled: false }
}')"
[[ $code == 2* ]] || die "LogiStack setup" "HTTP $code $body"
docker run -d --name ls-test-cool8-client --network ls-control alpine:3.22 sleep 7200 >/dev/null
docker exec ls-test-cool8-client apk add --no-cache -q curl
CURL=(docker exec ls-test-cool8-client curl)
API=http://logistack-api:3000
ORIGIN=https://${PUBLIC_URL#http://}
req POST /api/auth/sign-in/email "$(jq -n --arg e "$owner" --arg p "$owner_pw" '{ email: $e, password: $p }')"
[ "$code" = 200 ] || die "LogiStack sign-in" "HTTP $code $body"
pass "LogiStack set up next to Coolify, owner signed in"

# ---- 4. The wizard, through the API ---------------------------------------------------------

req POST /api/migrations
[ "$code" = 201 ] || die "plan the migration" "HTTP $code $body"
mig=$(jq -r .id <<<"$body")
jq -r '.items[] | "      \(.status) \(.support) \(.kind) \(.name)\(if (.notes | length) > 0 then ": " + (.notes | join("; ")) else "" end)"' <<<"$body"
jq -e '[.items[].notes[] | select(test("decrypted"))] | length == 0' <<<"$body" >/dev/null &&
	pass "inventory: Coolify's encrypted secrets read with its APP_KEY" || fail "decryption" "notes mention decryption"
unsupported=$(jq '[.items[] | select(.support == "unsupported")] | length' <<<"$body")
[ "$unsupported" = 0 ] && pass "inventory: $(jq '.items | length' <<<"$body") items, none unsupported" ||
	fail "inventory" "$unsupported unsupported"

get_mig() { req GET "/api/migrations/$mig"; }
req POST "/api/migrations/$mig/import"
imported() { get_mig && [ "$(jq -r .status <<<"$body")" = imported ]; }
until_ok 300 imported || die "import" "$(jq -c '[.items[] | {name, status, lastError}]' <<<"$body")"
failed=$(jq -c '[.items[] | select(.status == "failed") | {name, lastError}]' <<<"$body")
[ "$failed" = "[]" ] && pass "import: every item created in LogiStack, nothing deployed" || fail "import" "$failed"

# Databases first, then apps and one-click services, then the settings.
order=$(jq -r '[.items[] | select(.status == "imported")] |
	sort_by(if .kind == "postgres" then 0 elif .kind == "application" then 1 elif .kind == "service" then 2 else 3 end) |
	.[] | "\(.id) \(.name)"' <<<"$body")
status_of() { get_mig && jq -r --arg i "$1" '.items[] | select(.id == $i) | .status' <<<"$body"; }
settled() { s=$(status_of "$1") && [ "$s" = cut_over ] || [ "$s" = rolled_back ]; }
# A probe every 0.2 s on both sites through each cutover: they must keep answering.
: >/tmp/cutover-probe
touch /tmp/probing
(while [ -f /tmp/probing ]; do
	printf '%s %s %s\n' "$(date +%s.%N)" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 -H 'Host: web.smoke.test' http://127.0.0.1/)" \
		"$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 -H 'Host: blog.smoke.test' http://127.0.0.1/)" >>/tmp/cutover-probe
	sleep 0.2
done) &
while read -r id item; do
	req POST "/api/migration-items/$id/cutover"
	[ "$code" = 202 ] || die "cutover $item" "HTTP $code $body"
	until_ok 600 settled "$id" || die "cutover $item" "never settled"
	[ "$(status_of "$id")" = cut_over ] && pass "cutover $item" ||
		fail "cutover $item" "$(jq -r --arg i "$id" '.items[] | select(.id == $i) | .lastError' <<<"$body")"
	for host in web.smoke.test blog.smoke.test; do
		answers "$host" || fail "$host through Coolify's proxy after $item" "$(visit "$host" | head -c 120)"
	done
done <<<"$order"
rm -f /tmp/probing
wait
# web has no volume: it must never miss. blog has one (its cache), so it pauses while Coolify
# hands the volume over, as the wizard says; that pause is measured.
bad=$(awk '$2 != 200' /tmp/cutover-probe | wc -l)
[ "$bad" = 0 ] && pass "web answered through every cutover ($(wc -l </tmp/cutover-probe) probes, none failed)" ||
	fail "web during cutovers" "$bad of $(wc -l </tmp/cutover-probe) probes failed: $(awk '$2 != 200' /tmp/cutover-probe | head -n 3 | tr '\n' ';')"
pause=$(awk '$3 != 200 { if (!s) s = $1; e = $1 } END { if (s) printf "%.1f", e - s + 0.2; else print 0 }' /tmp/cutover-probe)
awk -v p="$pause" 'BEGIN { exit !(p <= 30) }' && pass "blog (with a volume) paused ${pause} s while it moved" ||
	fail "blog pause" "${pause} s"
[ "$(docker inspect -f '{{.State.Running}} {{.HostConfig.RestartPolicy.Name}}' coolify)" = "false no" ] &&
	pass "Coolify's control plane is paused (stopped, restart policy no)" ||
	fail "Coolify paused" "$(docker inspect -f '{{.State.Running}} {{.HostConfig.RestartPolicy.Name}}' coolify)"

get_mig
pg_svc=$(jq -r '.items[] | select(.kind == "postgres") | .targets | to_entries[0].value' <<<"$body")
ls_row() { docker exec "$(docker ps -q --filter "label=logistack.resource=$pg_svc" --filter status=running | head -n1)" \
	psql -U shop -d shop -tAc "select id from orders"; }
[ "$(ls_row)" = 42 ] && pass "shop-db on LogiStack: Coolify's volume adopted, row 42 there" ||
	fail "data after cutover" "got '$(ls_row 2>&1 | head -c 120)'"
web_svc=$(jq -r '.items[] | select(.kind == "application") | .targets | to_entries[0].value' <<<"$body")
web_ctr=$(docker ps -q --filter "label=logistack.resource=$web_svc" --filter status=running | head -n1)
docker exec "$web_ctr" sh -c 'echo "$DATABASE_URL"' | grep -q "@$db:5432/shop" && docker exec "$web_ctr" getent hosts "$db" >/dev/null &&
	pass "web on LogiStack resolves its DATABASE_URL host $db" || fail "web's database host" "$db does not resolve from web"

# The switch, with a probe every 0.2 s on both hosts to measure the gap.
: >/tmp/probe
touch /tmp/probing
(while [ -f /tmp/probing ]; do
	printf '%s %s %s\n' "$(date +%s.%N)" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 -H 'Host: web.smoke.test' http://127.0.0.1/)" \
		"$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 -H 'Host: blog.smoke.test' http://127.0.0.1/)" >>/tmp/probe
	sleep 0.2
done) &
sleep 2
req POST "/api/migrations/$mig/proxy-switch"
[ "$code" = 202 ] || die "proxy switch" "HTTP $code $body"
switched() { get_mig && [ "$(jq -r .proxy.status <<<"$body")" != not_started ]; }
until_ok 300 switched || die "proxy switch" "no result"
sleep 5
rm -f /tmp/probing
wait
[ "$(jq -r .proxy.status <<<"$body")" = switched ] &&
	pass "proxy switch: Caddy holds 80/443, probes $(jq -c '[.proxy.probes[] | "\(.hostname) \(.detail)"]' <<<"$body")" ||
	fail "proxy switch" "$(jq -c .proxy <<<"$body")"
gap=$(awk '$2 != 200 || $3 != 200 { if (!s) s = $1; e = $1 } END { if (s) printf "%.1f", e - s + 0.2; else print 0 }' /tmp/probe)
printf '      HTTP gap during the switch: %s s (%s probes)\n' "$gap" "$(wc -l </tmp/probe)"
# What the gap is made of: runs of the same answer, in order (000 = nothing listening).
printf '      web.smoke.test answers in order: %s\n' "$(awk '{ print $2 }' /tmp/probe | uniq -c | awk '{ printf "%s x%s, ", $2, $1 }')"
for host in web.smoke.test blog.smoke.test; do
	until_ok 60 answers "$host" && pass "$host answers through Caddy" || fail "$host through Caddy" "$(visit "$host" | head -c 120)"
done
[ "$(docker inspect -f '{{.State.Status}} {{.HostConfig.RestartPolicy.Name}}' coolify-proxy)" = "exited no" ] &&
	pass "coolify-proxy stopped for good (restart policy no)" ||
	fail "coolify-proxy after switch" "$(docker inspect -f '{{.State.Status}} {{.HostConfig.RestartPolicy.Name}}' coolify-proxy)"

req POST "/api/migrations/$mig/decommission"
[ "$code" = 202 ] || die "decommission" "HTTP $code $body"
decommissioned() { get_mig && [ "$(jq -r .decommission.status <<<"$body")" != not_started ]; }
until_ok 600 decommissioned || die "decommission" "no result"
[ "$(jq -r .decommission.status <<<"$body")" = "done" ] || die "decommission" "$(jq -c .decommission <<<"$body")"
archive=$(jq -r .decommission.archivePath <<<"$body")
[ -s "$archive/coolify.dump" ] && [ -s "$archive/data-coolify.tar.gz" ] && [ -s "$archive/inventory.json" ] &&
	pass "Coolify archived in $archive" || fail "archive" "$(ls -la "$archive" 2>&1)"
left=$(docker ps -a --format '{{.Names}}' | grep -xE "coolify|coolify-db|coolify-redis|coolify-proxy|$db" || true)
[ -z "$left" ] && pass "Coolify removed: $(jq -c .decommission.removed <<<"$body")" || fail "Coolify removed" "left: $left"
[ "$(ls_row)" = 42 ] && pass "after removal: row 42 still on LogiStack" || fail "data after removal" "$(ls_row 2>&1 | head -c 120)"
for host in web.smoke.test blog.smoke.test; do
	until_ok 60 answers "$host" && pass "after removal: $host answers" || fail "$host after removal" "$(visit "$host" | head -c 120)"
done
docker volume inspect "postgres-data-$db" >/dev/null 2>&1 && pass "Coolify's database volume kept (adopted)" ||
	fail "volume kept" "postgres-data-$db missing"

exit "$FAILED"

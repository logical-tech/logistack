#!/usr/bin/env bash
# `check && pass || fail` is intended: pass only prints, so fail runs only when the check failed.
# shellcheck disable=SC2015
# The Dokploy migration end to end (MIG-8), in a throwaway docker:dind named ls-test-mig8-dind:
#   1. Dokploy v0.30.10 installed the way its installer does (Swarm, dokploy-network, the
#      dokploy_postgres_password secret, Traefik on 80/443), then seeded through its own API by a
#      throwaway admin: an image app with a domain and a DATABASE_URL, a Postgres 18 with a row
#      of data and an S3 backup, and a 3-service compose with a domain. Dokploy deploys them.
#   2. install.sh --local-build next to it, setup, then the migration wizard driven through
#      LogiStack's API: plan, import, cut every item over, switch traffic, remove Dokploy.
#   3. Checks along the way: the row survives, every domain keeps answering (the HTTP gap of the
#      proxy switch is measured), and Dokploy is gone with its archive on disk.
# Touches only the ls-test-mig8-dind container. KEEP=1 leaves it running for inspection.
#   bash install/smoke-migrate.sh
set -euo pipefail

NAME=${SMOKE_NAME:-ls-test-mig8-dind}
LABEL=${SMOKE_LABEL:-mig8}
DIND_IMAGE=${DIND_IMAGE:-docker:29-dind}
DOKPLOY_VERSION=${DOKPLOY_VERSION:-v0.30.10}
TRAEFIK_IMAGE=${TRAEFIK_IMAGE:-traefik:v3.6.25}
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

if [ "${1:-}" != --inside ]; then
	docker rm -f -v "$NAME" >/dev/null 2>&1 || true
	docker run -d --privileged --name "$NAME" --label "logistack.test=$LABEL" -v "$ROOT:/src:ro" "$DIND_IMAGE" >/dev/null
	for _ in $(seq 1 60); do docker exec "$NAME" docker info >/dev/null 2>&1 && break; sleep 1; done
	docker exec "$NAME" apk add --no-cache -q bash curl jq
	# A fresh dind pulls anonymously and Docker Hub caps that per address; images the run needs at
	# runtime come from this host's cache (pulled with its login, if any) instead.
	preload=("dokploy/dokploy:$DOKPLOY_VERSION" postgres:16 postgres:17 postgres:18 redis:7 redis:7-alpine
		nginx:alpine traefik/whoami:v1.10 alpine:3.22 "$TRAEFIK_IMAGE"
		# install.sh --local-build's bases (Dockerfile, install/agent.Dockerfile, docker/caddy/Dockerfile).
		oven/bun:1.4 oven/bun:1.4-slim gcr.io/distroless/cc-debian12 caddy:2.11.7-builder-alpine caddy:2.11.7-alpine)
	for image in "${preload[@]}"; do
		docker image inspect "$image" >/dev/null 2>&1 || docker pull -q "$image" >/dev/null
	done
	docker save "${preload[@]}" | docker exec -i "$NAME" docker load -q >/dev/null
	rc=0
	docker exec -e LOGISTACK_WAIT_TIMEOUT="${LOGISTACK_WAIT_TIMEOUT:-900}" -e DOKPLOY_VERSION="$DOKPLOY_VERSION" \
		-e TRAEFIK_IMAGE="$TRAEFIK_IMAGE" "$NAME" bash /src/install/smoke-migrate.sh --inside || rc=$?
	[ "${KEEP:-0}" = 1 ] || docker rm -f -v "$NAME" >/dev/null
	exit "$rc"
fi

# Inside the dind container from here on.
FAILED=0
last=$SECONDS
pass() { printf 'PASS  %-66s %4ss\n' "$1" $((SECONDS - last)); last=$SECONDS; }
fail() {
	printf 'FAIL  %-66s %4ss  %s\n' "$1" $((SECONDS - last)) "$2"
	FAILED=1
	last=$SECONDS
}
die() {
	fail "$1" "$2"
	docker service ls --format '{{.Name}} {{.Replicas}} {{.Image}}' | head -40 || true
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
running() { docker ps -q --filter "label=com.docker.swarm.service.name=$1" --filter status=running | head -n1; }
# What a visitor of HOST gets on this server's port 80, whoever holds it.
visit() { curl -s --max-time 3 -H "Host: $1" http://127.0.0.1/ || true; }

ip=$(hostname -i | awk '{ print $1 }')

# ---- 1. Dokploy, as its installer leaves it -------------------------------------------------

docker swarm init --advertise-addr "$ip" >/dev/null
docker network create -d overlay --attachable dokploy-network >/dev/null
mkdir -p /etc/dokploy
chmod 777 /etc/dokploy
rand 16 | docker secret create dokploy_postgres_password - >/dev/null
rand 32 | docker secret create dokploy_auth_secret - >/dev/null
docker service create -d -q --name dokploy-postgres --constraint node.role==manager --network dokploy-network \
	--secret source=dokploy_postgres_password,target=/run/secrets/postgres_password \
	-e POSTGRES_USER=dokploy -e POSTGRES_DB=dokploy -e POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password \
	--mount type=volume,source=dokploy-postgres,target=/var/lib/postgresql/data postgres:16 >/dev/null
docker service create -d -q --name dokploy --replicas 1 --constraint node.role==manager --network dokploy-network \
	--mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
	--mount type=bind,source=/etc/dokploy,target=/etc/dokploy \
	--mount type=volume,source=dokploy,target=/root/.docker \
	--secret source=dokploy_postgres_password,target=/run/secrets/postgres_password \
	--secret source=dokploy_auth_secret,target=/run/secrets/dokploy_auth_secret \
	-e POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password -e BETTER_AUTH_SECRET_FILE=/run/secrets/dokploy_auth_secret \
	-e ADVERTISE_ADDR="$ip" -e RELEASE_TAG=latest \
	--publish published=3000,target=3000,mode=host --update-order stop-first \
	"dokploy/dokploy:$DOKPLOY_VERSION" >/dev/null
# Dokploy writes Traefik's static config on its first start; Traefik needs the file, not a directory.
until_ok 600 test -f /etc/dokploy/traefik/traefik.yml || die "Dokploy writes traefik.yml" "not after 10 min"
docker run -d -q --name dokploy-traefik --restart always --network dokploy-network \
	-v /etc/dokploy/traefik/traefik.yml:/etc/traefik/traefik.yml \
	-v /etc/dokploy/traefik/dynamic:/etc/dokploy/traefik/dynamic \
	-v /var/run/docker.sock:/var/run/docker.sock:ro \
	-p 80:80/tcp -p 443:443/tcp -p 443:443/udp "$TRAEFIK_IMAGE" >/dev/null
DK=http://127.0.0.1:3000
until_ok 600 curl -fs "$DK/api/trpc/settings.health" || die "Dokploy healthy" "no answer on :3000"
pass "Dokploy $DOKPLOY_VERSION up: dokploy, dokploy-postgres (secret), dokploy-traefik"

# ---- 2. Seed it through its own API ---------------------------------------------------------

admin=admin@smoke.test
admin_pw=$(rand 12)
curl -fsS -c /tmp/dk -H "Origin: $DK" -H 'content-type: application/json' "$DK/api/auth/sign-up/email" \
	--data "$(jq -n --arg e "$admin" --arg p "$admin_pw" '{email: $e, password: $p, name: "Smoke", lastName: "Admin"}')" \
	>/dev/null || die "Dokploy sign-up" "refused"
# Sign-up creates the organization in a hook; it can lag the response.
org_of() { org=$(curl -fsS -b /tmp/dk -H "Origin: $DK" "$DK/api/organization.all" | jq -r '.[0].id // empty') && [ -n "$org" ]; }
until_ok 60 org_of || die "Dokploy organization" "none after sign-up"
org_of
# Keys are limited to 10 requests a day unless told otherwise; seeding takes more.
key=$(curl -fsS -b /tmp/dk -H "Origin: $DK" -H 'content-type: application/json' "$DK/api/user.createApiKey" \
	--data "$(jq -n --arg o "$org" '{name: "smoke", rateLimitEnabled: false, metadata: {organizationId: $o}}')" | jq -r '.key')
[ -n "$key" ] && [ "$key" != null ] || die "Dokploy API key" "none returned"
# dk PATH JSON: a Dokploy mutation; sets $dk_body. Not for $(...): die would only leave the subshell.
dk() {
	local out
	out=$(curl -sS -w '\n%{http_code}' -H "x-api-key: $key" -H 'content-type: application/json' "$DK/api/$1" --data "$2")
	dk_body=${out%$'\n'*}
	[[ ${out##*$'\n'} == 2* ]] || die "Dokploy $1" "HTTP ${out##*$'\n'}: $(head -c 300 <<<"$dk_body")"
}

db_pw=$(rand 12)
s3_secret=$(rand 16)
dk project.create '{"name":"Shop"}'
env_id=$(jq -r '.environment.environmentId' <<<"$dk_body")
dk postgres.create "$(jq -n --arg e "$env_id" --arg p "$db_pw" \
	'{name: "shop-db", databaseName: "shop", databaseUser: "shop", databasePassword: $p, dockerImage: "postgres:18", environmentId: $e}')"
pg=$dk_body
pg_id=$(jq -r .postgresId <<<"$pg")
pg_app=$(jq -r .appName <<<"$pg")
dk postgres.deploy "$(jq -n --arg i "$pg_id" '{postgresId: $i}')"

dk destination.create "$(jq -n --arg s "$s3_secret" '{name: "Backups", provider: "Other", accessKey: "smoke",
	secretAccessKey: $s, bucket: "backups", region: "us-east-1", endpoint: "http://s3.smoke.test:9000", additionalFlags: []}')"
dest_id=$(jq -r .destinationId <<<"$dk_body")
dk backup.create "$(jq -n --arg d "$dest_id" --arg p "$pg_id" '{schedule: "0 3 * * *", prefix: "shop", destinationId: $d,
	database: "shop", databaseType: "postgres", postgresId: $p, enabled: true, keepLatestCount: 5, backupType: "database"}')"

dk application.create "$(jq -n --arg e "$env_id" '{name: "web", environmentId: $e}')"
web=$dk_body
web_id=$(jq -r .applicationId <<<"$web")
web_app=$(jq -r .appName <<<"$web")
dk application.saveDockerProvider "$(jq -n --arg i "$web_id" \
	'{applicationId: $i, dockerImage: "nginx:alpine", username: null, password: null, registryUrl: null}')"
dk application.saveEnvironment "$(jq -n --arg i "$web_id" --arg u "postgres://shop:$db_pw@$pg_app:5432/shop" \
	'{applicationId: $i, env: ("DATABASE_URL=" + $u), buildArgs: "", buildSecrets: "", createEnvFile: false}')"
dk domain.create "$(jq -n --arg i "$web_id" '{host: "web.smoke.test", path: "/", port: 80, https: false,
	certificateType: "none", applicationId: $i, domainType: "application"}')"
dk application.deploy "$(jq -n --arg i "$web_id" '{applicationId: $i}')"

compose_file='services:
  web:
    image: nginx:alpine
    depends_on: [api, cache]
  api:
    image: traefik/whoami:v1.10
  cache:
    image: redis:7-alpine
'
dk compose.create "$(jq -n --arg e "$env_id" --arg f "$compose_file" \
	'{name: "blog", environmentId: $e, composeType: "docker-compose", sourceType: "raw", composeFile: $f}')"
blog=$dk_body
blog_id=$(jq -r .composeId <<<"$blog")
blog_app=$(jq -r .appName <<<"$blog")
dk compose.update "$(jq -n --arg i "$blog_id" --arg f "$compose_file" '{composeId: $i, sourceType: "raw", composeFile: $f}')"
dk domain.create "$(jq -n --arg i "$blog_id" '{host: "blog.smoke.test", path: "/", port: 80, https: false,
	certificateType: "none", composeId: $i, serviceName: "web", domainType: "compose"}')"
dk compose.deploy "$(jq -n --arg i "$blog_id" '{composeId: $i}')"

until_ok 600 running "$pg_app" || die "Dokploy deploys shop-db" "no running task"
row() { docker exec "$(running "$1")" psql -U shop -d shop -tAc "$2"; }
until_ok 120 row "$pg_app" "select 1" || die "shop-db answers" "psql failed"
row "$pg_app" "create table orders (id int); insert into orders values (42)"
until_ok 600 running "$web_app" || die "Dokploy deploys web" "no running task"
blog_up() { [ "$(docker ps -q --filter "label=com.docker.compose.project=$blog_app" --filter status=running | wc -l)" = 3 ]; }
until_ok 600 blog_up || die "Dokploy deploys blog" "not 3 containers running"
until_ok 120 sh -c 'curl -s -H "Host: web.smoke.test" http://127.0.0.1/ | grep -q nginx' ||
	die "Traefik routes web.smoke.test" "$(visit web.smoke.test | head -c 120)"
until_ok 120 sh -c 'curl -s -H "Host: blog.smoke.test" http://127.0.0.1/ | grep -q nginx' ||
	die "Traefik routes blog.smoke.test" "$(visit blog.smoke.test | head -c 120)"
pass "seeded through Dokploy's API: web, shop-db (pg 18, row 42, S3 backup), blog x3"

# ---- 3. LogiStack next to it ----------------------------------------------------------------

bash /src/install/install.sh --local-build --yes --advertise-addr "$ip" >/tmp/install.out 2>&1 || {
	tail -n 40 /tmp/install.out
	die "install.sh next to Dokploy" "installer failed"
}
grep -q 'Dokploy found' /tmp/install.out && pass "install.sh: Dokploy found, ingress off" ||
	fail "install.sh detection" "no 'Dokploy found'"

API=http://127.0.0.1:3001
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
# After setup the api is reached from a client on ls-control, as in smoke.sh.
docker run -d --name ls-test-mig8-client --network ls-control alpine:3.22 sleep 7200 >/dev/null
docker exec ls-test-mig8-client apk add --no-cache -q curl
CURL=(docker exec ls-test-mig8-client curl)
API=http://logistack-api:3000
ORIGIN=https://${PUBLIC_URL#http://}
req POST /api/auth/sign-in/email "$(jq -n --arg e "$owner" --arg p "$owner_pw" '{ email: $e, password: $p }')"
[ "$code" = 200 ] || die "LogiStack sign-in" "HTTP $code $body"
pass "LogiStack set up next to Dokploy, owner signed in"

# ---- 4. The wizard, through the API ---------------------------------------------------------

req POST /api/migrations
[ "$code" = 201 ] || die "plan the migration" "HTTP $code $body"
mig=$(jq -r .id <<<"$body")
jq -r '.items[] | "      \(.status) \(.support) \(.kind) \(.name)\(if (.notes | length) > 0 then ": " + (.notes | join("; ")) else "" end)"' <<<"$body"
# Dokploy encrypts env at rest; the wizard must have read it with the key install.sh handed over.
jq -e '[.items[].notes[] | select(test("encrypted"))] | length == 0' <<<"$body" >/dev/null &&
	pass "inventory: Dokploy's encrypted env read with its key" || fail "encrypted env" "notes mention encryption"
unsupported=$(jq '[.items[] | select(.support == "unsupported")] | length' <<<"$body")
[ "$unsupported" = 0 ] && pass "inventory: $(jq '.items | length' <<<"$body") items, none unsupported" ||
	fail "inventory" "$unsupported unsupported"

get_mig() { req GET "/api/migrations/$mig"; }
req POST "/api/migrations/$mig/import"
imported() { get_mig && [ "$(jq -r .status <<<"$body")" = imported ]; }
until_ok 300 imported || die "import" "$(jq -c '[.items[] | {name, status, lastError}]' <<<"$body")"
failed=$(jq -c '[.items[] | select(.status == "failed") | {name, lastError}]' <<<"$body")
[ "$failed" = "[]" ] && pass "import: every item created in LogiStack, nothing deployed" || fail "import" "$failed"

# Databases first, then apps and composes, then the settings; GitHub Apps would wait for the switch.
order=$(jq -r '[.items[] | select(.status == "imported")] |
	sort_by(if .kind == "postgres" then 0 elif .kind == "application" then 1 elif .kind == "compose" then 2 else 3 end) |
	.[] | "\(.id) \(.name)"' <<<"$body")
status_of() { get_mig && jq -r --arg i "$1" '.items[] | select(.id == $i) | .status' <<<"$body"; }
settled() { s=$(status_of "$1") && [ "$s" = cut_over ] || [ "$s" = rolled_back ]; }
while read -r id item; do
	req POST "/api/migration-items/$id/cutover"
	[ "$code" = 202 ] || die "cutover $item" "HTTP $code $body"
	until_ok 600 settled "$id" || die "cutover $item" "never settled"
	[ "$(status_of "$id")" = cut_over ] && pass "cutover $item" ||
		fail "cutover $item" "$(jq -r --arg i "$id" '.items[] | select(.id == $i) | .lastError' <<<"$body")"
	# Until the switch Traefik still holds :80; the bridge keeps every site up through each cutover.
	for host in web.smoke.test blog.smoke.test; do
		visit "$host" | grep -q nginx || fail "$host through Traefik after $item" "$(visit "$host" | head -c 120)"
	done
done <<<"$order"

# status_of runs in $(...): read the migration again here.
get_mig
pg_svc=$(jq -r '.items[] | select(.kind == "postgres") | .targets | to_entries[0].value' <<<"$body")
ls_row() { docker exec "$(docker ps -q --filter "label=logistack.resource=$pg_svc" --filter status=running | head -n1)" \
	psql -U shop -d shop -tAc "select id from orders"; }
[ "$(ls_row)" = 42 ] && pass "shop-db on LogiStack: Dokploy's volume adopted, row 42 there" ||
	fail "data after cutover" "got '$(ls_row 2>&1 | head -c 120)'"

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
answers() { visit "$1" | grep -q nginx; }
for host in web.smoke.test blog.smoke.test; do
	until_ok 60 answers "$host" && pass "$host answers through Caddy" || fail "$host through Caddy" "$(visit "$host" | head -c 120)"
done
[ "$(docker inspect -f '{{.State.Status}} {{.HostConfig.RestartPolicy.Name}}' dokploy-traefik)" = "exited no" ] &&
	pass "Traefik stopped for good (restart policy no)" || fail "Traefik after switch" "$(docker inspect -f '{{.State.Status}} {{.HostConfig.RestartPolicy.Name}}' dokploy-traefik)"

req POST "/api/migrations/$mig/decommission"
[ "$code" = 202 ] || die "decommission" "HTTP $code $body"
decommissioned() { get_mig && [ "$(jq -r .decommission.status <<<"$body")" != not_started ]; }
until_ok 600 decommissioned || die "decommission" "no result"
[ "$(jq -r .decommission.status <<<"$body")" = "done" ] || die "decommission" "$(jq -c .decommission <<<"$body")"
archive=$(jq -r .decommission.archivePath <<<"$body")
[ -s "$archive/dokploy.dump" ] && [ -s "$archive/etc-dokploy.tar.gz" ] && [ -s "$archive/inventory.json" ] &&
	pass "Dokploy archived in $archive" || fail "archive" "$(ls -la "$archive" 2>&1)"
left=$(docker service ls --format '{{.Name}}' | grep -xE "dokploy|dokploy-postgres|$pg_app|$web_app" || true)
[ -z "$left" ] && ! docker inspect dokploy-traefik >/dev/null 2>&1 &&
	pass "Dokploy removed: $(jq -c .decommission.removed <<<"$body")" || fail "Dokploy removed" "left: $left"
[ "$(ls_row)" = 42 ] && pass "after removal: row 42 still on LogiStack" || fail "data after removal" "$(ls_row 2>&1 | head -c 120)"
# Detaching the bridge replaces each migrated service's tasks once.
for host in web.smoke.test blog.smoke.test; do
	until_ok 60 answers "$host" && pass "after removal: $host answers" || fail "$host after removal" "$(visit "$host" | head -c 120)"
done
docker volume inspect "$pg_app-data" >/dev/null 2>&1 && pass "Dokploy's database volume kept (adopted)" ||
	fail "volume kept" "$pg_app-data missing"

exit "$FAILED"

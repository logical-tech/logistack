#!/usr/bin/env bash
# `check && pass || fail` is intended: pass only prints, so fail runs only when the check failed.
# shellcheck disable=SC2015
# End-to-end smoke test: install.sh --local-build in a throwaway docker:dind, then setup, sign-in
# and an image deploy through the public API. Touches only the $SMOKE_NAME container.
#   bash install/smoke.sh          KEEP=1 leaves the container running for inspection
#   SMOKE_NAME=ls-test-bridge-dind SMOKE_LABEL=bridge bash install/smoke.sh
#   SMOKE_NO_INGRESS=1 bash install/smoke.sh   first installs --no-ingress, then --enable-ingress
#   SMOKE_UPDATE=1 bash install/smoke.sh       installs 0.0.1, then updates to locally built 0.0.2
#                                              through POST /api/instance/update (ls-test-rel-dind)
#   SMOKE_PUBLIC_SETUP=1 bash install/smoke.sh installs --public-setup: setup through Caddy, with the
#                                              one-time token (ls-test-pubsetup-dind)
#   SMOKE_DOKPLOY=1 bash install/smoke.sh      installs next to a fake Dokploy (and a stopped Coolify's
#                                              /data/coolify): detection, ingress off, the api reads
#                                              Dokploy (ls-test-mig5-dind)
#   SMOKE_COOLIFY=1 bash install/smoke.sh      installs next to a fake Coolify on Coolify's own Docker
#                                              address pool: Swarm on a clear pool, the bridge, the
#                                              api reads Coolify (ls-test-cool4-dind)
set -euo pipefail

UPDATE=${SMOKE_UPDATE:-0}
PUBLIC_SETUP=${SMOKE_PUBLIC_SETUP:-0}
DOKPLOY=${SMOKE_DOKPLOY:-0}
COOLIFY=${SMOKE_COOLIFY:-0}
DIND_ARGS=()
if [ "$COOLIFY" = 1 ]; then
	NAME=${SMOKE_NAME:-ls-test-cool4-dind} LABEL=${SMOKE_LABEL:-cool4}
	# What Coolify's installer writes into daemon.json; the comma is dockerd's syntax.
	# shellcheck disable=SC2054
	DIND_ARGS=(--default-address-pool base=10.0.0.0/8,size=24)
elif [ "$DOKPLOY" = 1 ]; then
	NAME=${SMOKE_NAME:-ls-test-mig5-dind} LABEL=${SMOKE_LABEL:-mig5}
elif [ "$UPDATE" = 1 ]; then
	NAME=${SMOKE_NAME:-ls-test-rel-dind} LABEL=${SMOKE_LABEL:-rel}
elif [ "$PUBLIC_SETUP" = 1 ]; then
	NAME=${SMOKE_NAME:-ls-test-pubsetup-dind} LABEL=${SMOKE_LABEL:-pubsetup}
else
	NAME=${SMOKE_NAME:-ls-test-pkg-dind} LABEL=${SMOKE_LABEL:-pkg}
fi
DIND_IMAGE=${DIND_IMAGE:-docker:29-dind}
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

if [ "${1:-}" != --inside ]; then
	docker rm -f -v "$NAME" >/dev/null 2>&1 || true
	docker run -d --privileged --name "$NAME" --label "logistack.test=$LABEL" -v "$ROOT:/src:ro" "$DIND_IMAGE" ${DIND_ARGS[@]+"${DIND_ARGS[@]}"} >/dev/null
	for _ in $(seq 1 60); do docker exec "$NAME" docker info >/dev/null 2>&1 && break; sleep 1; done
	docker exec "$NAME" apk add --no-cache -q bash curl jq
	rc=0
	# The updater takes images from localhost/: the same path the UI uses, with a local image source.
	docker exec -e LOGISTACK_WAIT_TIMEOUT="${LOGISTACK_WAIT_TIMEOUT:-600}" -e SMOKE_NO_INGRESS="${SMOKE_NO_INGRESS:-0}" \
		-e SMOKE_UPDATE="$UPDATE" -e SMOKE_PUBLIC_SETUP="$PUBLIC_SETUP" -e SMOKE_DOKPLOY="$DOKPLOY" -e SMOKE_COOLIFY="$COOLIFY" -e LOGISTACK_UPDATE_REGISTRY=localhost "$NAME" bash /src/install/smoke.sh --inside || rc=$?
	[ "${KEEP:-0}" = 1 ] || docker rm -f -v "$NAME" >/dev/null
	exit "$rc"
fi

# Inside the dind container from here on. Everything below runs in its own Docker daemon.
FAILED=0
last=$SECONDS

pass() { printf 'PASS  %-62s %4ss\n' "$1" $((SECONDS - last)); last=$SECONDS; }
fail() {
	printf 'FAIL  %-62s %4ss  %s\n' "$1" $((SECONDS - last)) "$2"
	FAILED=1
	last=$SECONDS
}
die() {
	fail "$1" "$2"
	docker stack ps logistack --no-trunc --format '{{.Name}} {{.CurrentState}} {{.Error}}' | head -30 || true
	exit 1
}

# Before setup requests go through the loopback tunnel on :3000, or with --public-setup through
# Caddy's bootstrap catch-all on :80. Setup makes the worker push the real config, which routes
# only the dashboard host and redirects it to https; without a certificate here, later requests go
# straight to the api from a client on ls-control.
API=http://127.0.0.1:3000
FLAGS=()
if [ "$PUBLIC_SETUP" = 1 ]; then API=http://127.0.0.1 FLAGS=(--public-setup); fi
CURL=(curl)
ORIGIN=""
# req METHOD PATH [JSON]: sets $code and $body. Not for $(...): those would be lost in the subshell.
req() {
	local out
	out=$("${CURL[@]}" -sS -w '\n%{http_code}' -X "$1" -b /tmp/jar -c /tmp/jar -H "Origin: $ORIGIN" \
		-H 'content-type: application/json' ${3:+--data "$3"} "$API$2")
	code=${out##*$'\n'}
	body=${out%$'\n'*}
}
container_of() { docker ps -q --filter "label=com.docker.swarm.service.name=logistack_$1" | head -n1; }
# service=task pairs, so a failure says which service restarted.
task_ids() { docker stack ps logistack --filter desired-state=running --format '{{.Name}}={{.ID}}' | sed 's/\.[0-9a-z]*=/=/' | sort | tr '\n' ' '; }

install() {
	local out=$1
	shift
	bash /src/install/install.sh --local-build --yes --advertise-addr "$ip" "$@" 2>&1 |
		while IFS= read -r line; do printf '      [%4ss] %s\n' "$SECONDS" "$line"; done >"$out"
	[ "${PIPESTATUS[0]}" = 0 ] && return 0
	cat "$out"
	tail -n 40 /var/log/logistack-install.log 2>/dev/null || true
	return 1
}

ip=$(hostname -i | awk '{ print $1 }')

# A stand-in for Dokploy, shaped as Dokploy's own install leaves it: Swarm services `dokploy`
# (publishing 3000) and `dokploy-postgres` (password in a Swarm secret) on dokploy-network,
# Traefik holding 80/443, /etc/dokploy. The database carries the columns the reader needs and
# one project. Plus /data/coolify with no Coolify running, which must only be noted.
if [ "$DOKPLOY" = 1 ]; then
	pw="p@ss:w/rd%$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
	docker swarm init --advertise-addr "$ip" >/dev/null
	docker network create -d overlay --attachable dokploy-network >/dev/null
	printf '%s' "$pw" | docker secret create dokploy_postgres_password - >/dev/null
	docker service create -d -q --name dokploy-postgres --network dokploy-network \
		--secret source=dokploy_postgres_password,target=/run/secrets/postgres_password \
		-e POSTGRES_USER=dokploy -e POSTGRES_DB=dokploy -e POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password \
		postgres:17 >/dev/null
	docker service create -d -q --name dokploy --network dokploy-network --publish published=3000,target=3000 \
		alpine:3.22 sleep infinity >/dev/null
	docker run -d -q --name dokploy-traefik -p 80:80 -p 443:443 alpine:3.22 sleep infinity >/dev/null
	mkdir -p /etc/dokploy/compose /data/coolify
	for _ in $(seq 1 90); do
		pg=$(docker ps -q --filter label=com.docker.swarm.service.name=dokploy-postgres | head -n1)
		[ -n "$pg" ] && docker exec "$pg" pg_isready -U dokploy -d dokploy >/dev/null 2>&1 && break
		sleep 2
	done
	sleep 3 # the image's init restarts the server once after pg_isready first answers
	pass "fake Dokploy: dokploy, dokploy-postgres (secret), dokploy-traefik on 80/443, /data/coolify"

	install /tmp/install.out || die "install.sh next to Dokploy" "installer failed"
	grep -E 'Coolify|Dokploy|dokploy|Ingress off|Ports 80|tunnel|migration' /tmp/install.out
	grep -q '/data/coolify exists but Coolify is not running' /tmp/install.out &&
		pass "a stopped Coolify's /data/coolify: noted, Dokploy detection carried on" || fail "Coolify detection" "no notice"
	grep -q 'Dokploy found' /tmp/install.out && grep -q "Ports 80 and 443 left to Dokploy's Traefik" /tmp/install.out &&
		grep -q 'password from secret dokploy_postgres_password' /tmp/install.out &&
		pass "Dokploy detected: plan explained, 80/443 left to Traefik, password from its secret" ||
		fail "Dokploy detection" "see /tmp/install.out"
	[ "$(cat /etc/logistack/migration)" = migration_source=dokploy ] &&
		pass "/etc/logistack/migration: migration_source=dokploy" || fail "migration_source" "$(cat /etc/logistack/migration 2>&1)"
	caddy=$(docker service ls --filter name=logistack_caddy --format '{{.Replicas}}')
	tunnel=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3001/api/health || true)
	[ "$caddy" = 0/0 ] && [ "$tunnel" = 200 ] && [ -n "$(docker node ls -q --filter node.label=logistack.ingress=pending)" ] &&
		pass "ingress off: Caddy 0/0, API through the tunnel on 127.0.0.1:3001 (3000 is Dokploy's)" ||
		fail "ingress off next to Dokploy" "caddy $caddy, tunnel :3001 $tunnel"
	leaks=$(grep -lF -- "$pw" /tmp/install.out /var/log/logistack-install.log /etc/logistack/* 2>/dev/null || true)
	leaks+=$(docker service inspect logistack_logistack-api | grep -cF -- "$pw" || true)
	[ "$leaks" = 0 ] && pass "Dokploy's password is in no output, log, config file or api service spec" ||
		fail "password leak" "found in: $leaks"

	# Dokploy's real schema needs the migrations in a Dokploy checkout; the reader's own column
	# list is enough here. Written from a throwaway container, never from the api.
	url="postgres://dokploy:$(jq -rn --arg p "$pw" '$p | @uri')@dokploy-postgres:5432/dokploy"
	docker run --rm --network dokploy-network -e URL="$url" --entrypoint bun localhost/logistack:build -e '
		const { minimalSchema } = await import("/app/apps/server/test/dokploy-schema.ts");
		await minimalSchema(process.env.URL);
		const sql = new Bun.SQL(process.env.URL, { max: 1 });
		await sql`insert into project ("projectId", name, env) values (${"p1"}, ${"Fake Dokploy project"}, ${""})`;
		await sql.close();' >/tmp/seed 2>&1 || die "seed fake Dokploy schema" "$(tail -n 3 /tmp/seed)"
	read_dokploy='const { loadConfig } = await import("/app/apps/server/src/config.ts");
const { dokploySource } = await import("/app/apps/server/src/migration/dokploy/source.ts");
const { readDokploy } = await import("/app/apps/server/src/migration/dokploy/read.ts");
const source = dokploySource(loadConfig());
if (!source) throw new Error("no Dokploy source in the api config");
const snapshot = await readDokploy(source.url, { composeRoot: source.composeRoot });
console.log(snapshot.projects.map((p) => p.name).join(","));'
	api=$(container_of logistack-api)
	projects=$(docker exec "$api" /app/install/entrypoint.sh bun -e "$read_dokploy" 2>&1 | tail -n1)
	mount=$(docker inspect "$api" --format '{{range .Mounts}}{{if eq .Destination "/etc/dokploy"}}{{.Source}} {{.RW}}{{end}}{{end}}')
	[ "$projects" = "Fake Dokploy project" ] && [ "$mount" = "/etc/dokploy false" ] &&
		pass "api: readDokploy(dokploySource(config)) lists 'Fake Dokploy project'; /etc/dokploy mounted ro" ||
		fail "api reads Dokploy" "projects '$projects', mount '$mount'"

	before=$(task_ids)
	install /tmp/reinstall.out || die "install.sh re-run next to Dokploy" "installer failed"
	[ "$before" = "$(task_ids)" ] && pass "install.sh re-run next to Dokploy: restarts no task" ||
		fail "re-run next to Dokploy" "tasks changed"
	traefik=$(docker inspect -f '{{.State.Running}}' dokploy-traefik)
	dokploy=$(docker service ls --filter name=dokploy --format '{{.Name}} {{.Replicas}}' | sort | tr '\n' ' ')
	[ "$traefik" = true ] && [ "$dokploy" = "dokploy 1/1 dokploy-postgres 1/1 " ] &&
		pass "Dokploy untouched: traefik running, $dokploy" || fail "Dokploy untouched" "traefik $traefik, $dokploy"
	exit "$FAILED"
fi
# A stand-in for Coolify, shaped as Coolify's own install leaves it: plain containers `coolify`,
# `coolify-db` (Postgres, password in /data/coolify/source/.env) and `coolify-proxy` holding 80/443,
# on the local bridge `coolify` that Coolify's address pool (10.0.0.0/8 in /24s) numbers. No Swarm.
if [ "$COOLIFY" = 1 ]; then
	pw="p@ss:w/rd%$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
	key="base64:$(head -c 32 /dev/urandom | base64)"
	mkdir -p /data/coolify/source
	printf 'APP_ID=x\nAPP_KEY=%s\nDB_USERNAME=coolify\nDB_PASSWORD=%s\nREDIS_PASSWORD=r\n' "$key" "$pw" >/data/coolify/source/.env
	chmod 600 /data/coolify/source/.env
	docker network create --attachable coolify >/dev/null
	docker run -d -q --name coolify-db --network coolify -e POSTGRES_USER=coolify -e POSTGRES_DB=coolify \
		-e POSTGRES_PASSWORD="$pw" postgres:15-alpine >/dev/null
	docker run -d -q --name coolify --network coolify --restart always alpine:3.22 sleep infinity >/dev/null
	docker run -d -q --name coolify-proxy --network coolify -p 80:80 -p 443:443 alpine:3.22 sleep infinity >/dev/null
	for _ in $(seq 1 90); do
		docker exec coolify-db pg_isready -U coolify -d coolify >/dev/null 2>&1 && break
		sleep 2
	done
	sleep 3
	bridge_subnet=$(docker network inspect coolify -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}')
	pass "fake Coolify: coolify, coolify-db, coolify-proxy on 80/443, network coolify $bridge_subnet"

	install /tmp/install.out || die "install.sh next to Coolify" "installer failed"
	grep -E 'Coolify|coolify|Swarm|Ingress off|Ports 80|tunnel|migration' /tmp/install.out
	grep -q 'Coolify found' /tmp/install.out && grep -q "Ports 80 and 443 left to Coolify's proxy" /tmp/install.out &&
		pass "Coolify detected: plan explained, 80/443 left to its proxy" || fail "Coolify detection" "see /tmp/install.out"
	[ "$(cat /etc/logistack/migration)" = migration_source=coolify ] &&
		pass "/etc/logistack/migration: migration_source=coolify" || fail "migration_source" "$(cat /etc/logistack/migration 2>&1)"
	ingress=$(docker network inspect ingress -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}')
	overlay=$(docker network inspect ls-coolify-bridge -f '{{.Driver}} {{.Attachable}} {{range .IPAM.Config}}{{.Subnet}}{{end}}')
	[[ $ingress == 10.248.* ]] && [[ $overlay == "overlay true 10.248."* ]] && [[ $bridge_subnet == 10.0.* ]] &&
		pass "Swarm on 10.248.0.0/16: ingress $ingress, bridge ${overlay##* }, clear of coolify $bridge_subnet" ||
		fail "Swarm address pool" "ingress $ingress, bridge $overlay, coolify $bridge_subnet"
	nets=$(docker inspect coolify-db -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}')
	[ "$nets" = "coolify ls-coolify-bridge " ] && pass "coolify-db on coolify and ls-coolify-bridge" || fail "coolify-db networks" "$nets"
	caddy=$(docker service ls --filter name=logistack_caddy --format '{{.Replicas}}')
	tunnel=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/api/health || true)
	[ "$caddy" = 0/0 ] && [ "$tunnel" = 200 ] &&
		pass "ingress off: Caddy 0/0, API through the tunnel on 127.0.0.1:3000" || fail "ingress off next to Coolify" "caddy $caddy, tunnel $tunnel"
	leaks=$(grep -lF -e "$pw" -e "$key" /tmp/install.out /var/log/logistack-install.log /etc/logistack/* 2>/dev/null || true)
	leaks+=$(docker service inspect logistack_logistack-api | grep -cF -e "$pw" -e "$key" || true)
	[ "$leaks" = 0 ] && pass "Coolify's password and APP_KEY are in no output, log, config file or api service spec" ||
		fail "secret leak" "found in: $leaks"

	# Coolify's real schema comes from its own image (COOL-8); the reader's columns are enough here.
	url="postgres://coolify:$(jq -rn --arg p "$pw" '$p | @uri')@coolify-db:5432/coolify"
	docker run --rm --network ls-coolify-bridge -e URL="$url" --entrypoint bun localhost/logistack:build -e '
		const { minimalCoolifySchema } = await import("/app/apps/server/test/coolify-schema.ts");
		await minimalCoolifySchema(process.env.URL);
		const sql = new Bun.SQL(process.env.URL, { max: 1 });
		await sql`insert into teams (id, name) values (0, ${"Root Team"})`;
		await sql`insert into projects (id, uuid, name, team_id) values (1, ${"p1"}, ${"Fake Coolify project"}, 0)`;
		await sql.close();' >/tmp/seed 2>&1 || die "seed fake Coolify schema" "$(tail -n 3 /tmp/seed)"
	read_coolify='const { loadConfig } = await import("/app/apps/server/src/config.ts");
const { coolifySource } = await import("/app/apps/server/src/migration/coolify/source.ts");
const { readCoolify } = await import("/app/apps/server/src/migration/coolify/read.ts");
const source = coolifySource(loadConfig());
if (!source) throw new Error("no Coolify source in the api config");
const snapshot = await readCoolify(source.url, { appKey: source.appKey });
console.log(snapshot.projects.map((p) => p.name).join(","));'
	api=$(container_of logistack-api)
	projects=$(docker exec "$api" /app/install/entrypoint.sh bun -e "$read_coolify" 2>&1 | tail -n1)
	[ "$projects" = "Fake Coolify project" ] &&
		pass "api: readCoolify(coolifySource(config)) over ls-coolify-bridge lists 'Fake Coolify project'" ||
		fail "api reads Coolify" "projects '$projects'"

	before=$(task_ids)
	install /tmp/reinstall.out || die "install.sh re-run next to Coolify" "installer failed"
	[ "$before" = "$(task_ids)" ] && pass "install.sh re-run next to Coolify: restarts no task" ||
		fail "re-run next to Coolify" "tasks changed: $(docker stack ps logistack --format '{{.Name}} {{.DesiredState}} {{.CurrentState}} {{.Error}}' | head -n 20 | tr '\n' ';')"
	running=$(docker ps --format '{{.Names}}' --filter name=coolify | sort | tr '\n' ' ')
	policy=$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' coolify)
	[ "$running" = "coolify coolify-db coolify-proxy " ] && [ "$policy" = always ] &&
		pass "Coolify untouched: $running running, coolify restart policy $policy" || fail "Coolify untouched" "$running $policy"
	exit "$FAILED"
fi
if [ "${SMOKE_NO_INGRESS:-0}" = 1 ]; then
	install /tmp/no-ingress.out --no-ingress || die "install.sh --no-ingress" "installer failed"
	caddy=$(docker service ls --filter name=logistack_caddy --format '{{.Replicas}}')
	tunnel=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/api/health || true)
	[ "$caddy" = 0/0 ] && [ "$tunnel" = 200 ] && ! curl -s -o /dev/null --max-time 3 http://127.0.0.1/ &&
		pass "install.sh --no-ingress: Caddy 0/0, API via tunnel, :80 free" ||
		fail "install.sh --no-ingress" "caddy $caddy, tunnel /api/health $tunnel"
	install /tmp/install.out --enable-ingress || die "install.sh --enable-ingress" "installer failed"
	[ -n "$(docker node ls -q --filter node.label=logistack.ingress=true)" ] &&
		pass "install.sh --enable-ingress: node labelled" ||
		fail "install.sh --enable-ingress" "node not labelled"
else
	version_a=()
	if [ "${SMOKE_UPDATE:-0}" = 1 ]; then version_a=(--version 0.0.1); fi
	install /tmp/install.out "${version_a[@]}" "${FLAGS[@]}" || die "install.sh --local-build ${FLAGS[*]}" "installer failed"
fi
pass "install.sh --local-build: all services n/n, ingress answering"
grep -E 'Build|Tagged|Deploy|✓ (logistack|postgres|redis|caddy|ls-)|API healthy' /tmp/install.out
docker stack services logistack --format '{{.Name}} {{.Replicas}}' | sed 's/^/      /'
for image in logistack logistack-worker logistack-agent logistack-caddy; do
	printf '      %-28s %s\n' "$image" "$(docker image inspect "localhost/$image:build" --format '{{.Size}}' | awk '{ printf "%.0f MB", $1 / 1e6 }')"
done
last=$SECONDS

# A container on the host's bridge stands in for the internet: it reaches the server's address only.
docker rm -f ls-test-pkg-outside >/dev/null 2>&1 || true
docker run -d --name ls-test-pkg-outside --label logistack.test=pkg alpine:3.22 sleep 3600 >/dev/null
docker exec ls-test-pkg-outside apk add --no-cache -q curl
outside() { docker exec ls-test-pkg-outside curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" || true; }
raw=$(outside "http://$ip:3000/api/health")
caddy=$(outside "http://$ip/api/setup/status")
loopback=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/api/health || true)
if [ "$PUBLIC_SETUP" = 1 ]; then
	[ "$raw" = 000 ] && [ "$caddy" = 200 ] && [ "$loopback" = 000 ] && ! docker inspect logistack-api-tunnel >/dev/null 2>&1 &&
		pass "--public-setup: setup public through Caddy, no tunnel, :3000 closed" ||
		fail "--public-setup exposure" "$ip:3000 $raw, $ip:80 $caddy, loopback:3000 $loopback"
else
	[ "$raw" = 000 ] && [ "$caddy" = 404 ] && [ "$loopback" = 200 ] &&
		pass "private setup: $ip:3000 closed, $ip:80 404, 127.0.0.1:3000 200" ||
		fail "private setup exposure" "$ip:3000 $raw, $ip:80 $caddy, loopback:3000 $loopback"
fi
docker rm -f ls-test-pkg-outside >/dev/null
last=$SECONDS

PUBLIC_URL=$(docker service inspect logistack_logistack-api --format '{{json .Spec.TaskTemplate.ContainerSpec.Env}}' |
	jq -r '.[] | select(startswith("BETTER_AUTH_URL=")) | sub("^BETTER_AUTH_URL="; "")')
HOST=${PUBLIC_URL#http://}
ORIGIN=$PUBLIC_URL

req GET /api/health
[ "$code" = 200 ] && pass "GET $API/api/health -> 200" || fail "GET /api/health" "HTTP $code"

req GET /api/setup/status
[ "$code" = 200 ] && [ "$(jq -r .setupCompleted <<<"$body")" = false ] &&
	[ "$(jq -r .setupTokenRequired <<<"$body")" = "$([ "$PUBLIC_SETUP" = 1 ] && echo true || echo false)" ] &&
	pass "GET /api/setup/status -> setupCompleted=false, setupTokenRequired=$(jq -r .setupTokenRequired <<<"$body")" ||
	fail "GET /api/setup/status" "HTTP $code $body"

email=owner@smoke.test
password=$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')
# Let's Encrypt rejects a .test contact at account registration, so the dashboard's ACME attempt
# fails before any certificate order and spends none of sslip.io's shared rate limit.
setup=$(jq -n --arg e "$email" --arg p "$password" --arg u "$PUBLIC_URL" '{
	owner: { name: "Smoke Owner", email: $e, password: $p },
	organization: { name: "Smoke" },
	instance: { publicUrl: $u, generatedDomainBase: "sslip", letsencryptEmail: "ops@smoke.test", localRegistryEnabled: false }
}')
if [ "$PUBLIC_SETUP" = 1 ]; then
	req POST /api/setup "$setup"
	[ "$code" = 401 ] && pass "POST /api/setup without the setup token -> 401" || die "setup without token" "HTTP $code $body"
	CURL=(curl -H "x-setup-token: $(sed -n 's/^LOGISTACK_SETUP_TOKEN=//p' /etc/logistack/credentials)")
fi
req POST /api/setup "$setup"
[[ $code == 2* ]] && pass "POST /api/setup (sslip quick start) -> $code" || die "POST /api/setup" "HTTP $code $body"
if [ "$PUBLIC_SETUP" = 1 ]; then
	req POST /api/setup "$setup"
	[ "$code" = 409 ] && pass "POST /api/setup again with the token -> 409, token retired" || fail "token retired" "HTTP $code $body"
fi

docker rm -f ls-test-pkg-client >/dev/null 2>&1 || true
docker run -d --name ls-test-pkg-client --label logistack.test=pkg --network ls-control alpine:3.22 sleep 3600 >/dev/null
docker exec ls-test-pkg-client apk add --no-cache -q curl
CURL=(docker exec ls-test-pkg-client curl)
API=http://logistack-api:3000
# What a browser sends once Caddy has moved the dashboard to https.
ORIGIN=https://$HOST

req POST /api/auth/sign-in/email "$(jq -n --arg e "$email" --arg p "$password" '{ email: $e, password: $p }')"
[ "$code" = 200 ] && docker exec ls-test-pkg-client grep -q session_token /tmp/jar &&
	pass "POST /api/auth/sign-in/email (Origin https) -> 200, session cookie" || die "sign-in" "HTTP $code $body"

req POST /api/projects '{"name":"Smoke"}'
[ "$code" = 201 ] || die "POST /api/projects" "HTTP $code $body"
req GET "/api/projects/$(jq -r .id <<<"$body")/environments"
env_id=$(jq -r '.[0].id' <<<"$body")
[ "$code" = 200 ] && [ -n "$env_id" ] && [ "$env_id" != null ] || die "GET environments" "HTTP $code $body"
pass "POST /api/projects -> 201, default environment listed"

spec='{"name":"web","spec":{"kind":"application","source":{"type":"image","image":"nginx:alpine"},"build":{"type":"image"},"ports":[],"replicas":1,"resources":{},"placement":[]}}'
req POST "/api/environments/$env_id/services" "$spec"
svc_id=$(jq -r .id <<<"$body")
[ "$code" = 201 ] && pass "POST /api/environments/{id}/services (nginx:alpine) -> 201" || die "create service" "HTTP $code $body"

req POST "/api/services/$svc_id/deploy"
dep_id=$(jq -r .id <<<"$body")
[ "$code" = 202 ] && pass "POST /api/services/{id}/deploy -> 202" || die "deploy" "HTTP $code $body"

state=""
for _ in $(seq 1 150); do
	req GET "/api/deployments/$dep_id"
	state=$(jq -r .status <<<"$body")
	case "$state" in healthy | failed | cancelled | superseded) break ;; esac
	sleep 2
done
[ "$state" = healthy ] && pass "deployment reached healthy" ||
	fail "deployment reached healthy" "status=$state error=$(jq -r .error <<<"$body")"

labels=$(docker service ls -q --filter "label=logistack.resource=$svc_id" | head -n1 |
	xargs -r docker service inspect --format '{{.Spec.Name}} {{json .Spec.Labels}}')
if [ -n "$labels" ] && jq -e '.["logistack.managed"] == "true" and .["logistack.org"] != null and .["logistack.kind"] != null' \
	<<<"${labels#* }" >/dev/null; then
	pass "Swarm service ${labels%% *} exists with logistack.* labels"
else
	fail "Swarm service with labels" "found: ${labels:-none}"
fi

redirect=""
for _ in $(seq 1 30); do
	# Caddy drops port 80 for a moment while it loads the config; a refused curl is one more try.
	redirect=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -H "Host: $HOST" http://127.0.0.1/api/health || true)
	[[ $redirect == 308* ]] && break
	sleep 2
done
[[ $redirect == "308 https://$HOST/api/health" ]] && pass "worker pushed the Caddy config: dashboard host -> 308 https" ||
	fail "Caddy dashboard route" "got '$redirect'"

worker=$(container_of logistack-worker)
uid=$(docker exec "$worker" awk '/^Uid:/ { print $2 }' /proc/1/status)
[ "$uid" != 0 ] && pass "worker runs as uid $uid with the docker socket group" || fail "worker non-root" "uid=$uid"
# The worker's own ensureBuildkit (placeholder URLs: only the Docker client is used), then a real RUN step.
ensure='const { loadConfig } = await import("/app/apps/worker/src/config.ts");
const { ensureBuildkit } = await import("/app/apps/worker/src/build.ts");
const { createDockerClient } = await import("/app/packages/docker/src/index.ts");
const cfg = loadConfig();
await ensureBuildkit({ cfg, docker: createDockerClient({ socketPath: cfg.DOCKER_SOCKET }) });'
build='set -e; git --version; railpack --version; mkdir -p /tmp/ctx
printf "FROM alpine:3.22\nRUN echo built-by-ls-buildkit\n" >/tmp/ctx/Dockerfile
buildctl --addr tcp://ls-buildkit:1234 build --progress plain --frontend dockerfile.v0 \
	--local context=/tmp/ctx --local dockerfile=/tmp/ctx --output type=docker,name=ls-test-pkg-build:1 >/tmp/image.tar
tar -tf /tmp/image.tar >/dev/null'
if docker exec -e DATABASE_URL=postgres://u@h/d -e REDIS_URL=redis://h -e LOGISTACK_MASTER_KEY=unused "$worker" bun -e "$ensure" >/tmp/tools 2>&1 &&
	docker exec "$worker" sh -c "$build" >>/tmp/tools 2>&1 && grep -Eq "^#[0-9]+ [0-9.]+ built-by-ls-buildkit$" /tmp/tools; then
	pass "worker: ensureBuildkit + buildctl Dockerfile RUN build, git, railpack"
else
	fail "worker build tools / buildkit" "$(tail -n 4 /tmp/tools | tr '\n' ' ' | cut -c1-200)"
fi

pg=$(container_of postgres)
psql() { docker exec "$pg" psql -U logistack -d logistack -tAc "$1"; }
[ "$(psql "select count(*) from information_schema.columns where table_name = 'node_token' and column_name = 'organization_id'")" = 1 ] &&
	pass "migrations applied: node_token.organization_id exists" || fail "node_token migration" "missing"

# Before setup the gateway refuses enrollment (503), so the agent is backing off for up to 30 s.
redis=$(container_of redis)
swarm_node=$(docker info --format '{{.Swarm.NodeID}}')
agent_state=""
for _ in $(seq 1 45); do
	key=$(docker exec "$redis" sh -c 'REDISCLI_AUTH="$(cat /run/secrets/redis_password)" redis-cli exists "ls:nodes:'"$swarm_node"'"')
	row=$(psql "select n.status || ' ' || n.role || ' ' || count(t.id) from node n left join node_token t on t.node_id = n.id and t.revoked_at is null where n.swarm_node_id = '$swarm_node' group by n.id")
	agent_state="redis=$key node=${row:-none}"
	[ "$key" = 1 ] && [ "$row" = "ready manager 1" ] && break
	sleep 2
done
agent=$(container_of logistack-agent)
agent_logs() { docker logs "$(container_of logistack-agent)" 2>&1; }
token_file=$(docker volume inspect logistack_agentdata --format '{{.Mountpoint}}')/node-token
token_hash() { psql "select t.token_hash from node_token t join node n on n.id = t.node_id where n.swarm_node_id = '$swarm_node' and t.revoked_at is null"; }
if [ "$key" = 1 ] && [ "$row" = "ready manager 1" ] && [ -s "$token_file" ] &&
	[ "$(sha256sum "$token_file" | cut -d' ' -f1)" = "$(token_hash)" ]; then
	pass "agent enrolled: ls:nodes:<id>, node row, hashed node token = agentdata file"
else
	hint=$(agent_logs | tail -n 5 | tr '\n' ' ' | cut -c1-240)
	fail "agent connected" "$agent_state; agent logs: '$hint'"
fi
# The api comes up after the agent, so it fails at least once; a 503 shows only if it retried between api start and setup.
failures=$(agent_logs | grep -c '"msg":"connection failed".*"backoffMs":' || true)
refusals=$(agent_logs | grep -c '"msg":"connection failed".*"status":503' || true)
connects=$(agent_logs | grep -c '"msg":"connected".*"enrolled":true' || true)
[ "$failures" -gt 0 ] && [ "$connects" = 1 ] &&
	pass "agent log: $failures failed attempt(s) with backoff ($refusals 503), one enrolled connect" ||
	fail "agent log" "failures=$failures enrolled connects=$connects"

hash_before=$(token_hash)
docker service update --force --detach=false -q logistack_logistack-agent >/dev/null
reconnected=0
for _ in $(seq 1 30); do
	[ "$agent" != "$(container_of logistack-agent)" ] && grep -q '"msg":"connected".*"enrolled":false' <<<"$(agent_logs)" && reconnected=1 && break
	sleep 1
done
hash_after=$(token_hash)
[ "$reconnected" = 1 ] && [ "$hash_after" = "$hash_before" ] &&
	pass "agent task restarted: reconnects with its kept node token, no re-enrollment" ||
	fail "agent restart" "reconnected=$reconnected token hash $hash_before -> $hash_after"

before=$(task_ids)
install /tmp/reinstall.out "${FLAGS[@]}" || die "install.sh re-run after setup" "installer failed"
after=$(task_ids)
[ "$before" = "$after" ] && pass "install.sh re-run after setup: passes, restarts no task" ||
	fail "install.sh re-run is a no-op" "tasks changed: $before -> $after"

if [ "${SMOKE_UPDATE:-0}" = 1 ]; then
	B=0.0.2
	build=(docker build -q --provenance=false --build-arg "LOGISTACK_VERSION=$B" --build-arg LOGISTACK_COMMIT=smoke)
	"${build[@]}" --target api -t "localhost/logistack:$B" /src >/dev/null &&
		"${build[@]}" --target worker -t "localhost/logistack-worker:$B" /src >/dev/null &&
		"${build[@]}" -f /src/install/agent.Dockerfile -t "localhost/logistack-agent:$B" /src >/dev/null &&
		"${build[@]}" -t "localhost/logistack-caddy:$B" /src/docker/caddy >/dev/null &&
		pass "built localhost/logistack*:$B (cached layers, new version)" || die "build $B" "docker build failed"

	req GET /api/instance/update
	[ "$code" = 200 ] && [ "$(jq -r .current.version <<<"$body")" = 0.0.1 ] &&
		pass "GET /api/instance/update: current version 0.0.1" || fail "update status" "HTTP $code $body"

	req POST /api/instance/update "{\"version\":\"$B\"}"
	run_id=$(jq -r .id <<<"$body")
	[ "$code" = 202 ] && pass "POST /api/instance/update $B -> 202" || die "start update" "HTTP $code $body"

	# A /ws client outside the stack, so it survives the update (the api image has bun). Like the
	# dashboard it reconnects when the old api task stops. Frames go to a file, synchronously.
	cookie=$(docker exec ls-test-pkg-client awk '{ sub(/^#HttpOnly_/, "") } !/^#/ && NF == 7 { printf "%s%s=%s", sep, $6, $7; sep = "; " }' /tmp/jar)
	docker run -d --name ls-test-rel-ws --network ls-control -e COOKIE="$cookie" -e ORIGIN="$ORIGIN" \
		-e CHANNEL="instance-update:$run_id" --entrypoint bun localhost/logistack:build -e '
		const { appendFileSync } = await import("node:fs");
		const open = () => {
			const ws = new WebSocket("ws://logistack-api:3000/ws", { headers: { cookie: process.env.COOKIE, origin: process.env.ORIGIN } });
			ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", channel: process.env.CHANNEL }));
			ws.onmessage = (e) => appendFileSync("/tmp/frames", e.data + "\n");
			ws.onclose = () => { appendFileSync("/tmp/frames", "closed\n"); setTimeout(open, 1000); };
		};
		open();
		setInterval(() => {}, 60000);' >/dev/null

	state=""
	for _ in $(seq 1 300); do
		# The api itself restarts mid-update; a refused request just means try again.
		code=000
		req GET /api/instance/update || true
		[ "$code" = 200 ] && state=$(jq -r '.run.state // empty' <<<"$body")
		case "$state" in succeeded | failed) break ;; esac
		sleep 2
	done
	[ "$state" = succeeded ] && pass "update run succeeded: $(jq -c .run.steps <<<"$body")" ||
		fail "update run" "state=$state error=$(jq -r .run.error <<<"$body") log=$(jq -c '.run.log[-5:]' <<<"$body")"

	images=""
	for svc in logistack-api logistack-worker logistack-agent caddy; do
		image=$(docker service inspect "logistack_$svc" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}')
		# The updater pins the digest when the engine knows one (the containerd store does).
		images+="${image%%@*} "
	done
	[ "$images" = "localhost/logistack:$B localhost/logistack-worker:$B localhost/logistack-agent:$B localhost/logistack-caddy:$B " ] &&
		pass "every service runs $B" || fail "services on $B" "images: $images"

	req GET /api/version
	[ "$code" = 200 ] && [ "$(jq -r .version <<<"$body")" = "$B" ] &&
		pass "GET /api/version -> $B from the new api" || fail "api version" "HTTP $code $body"
	req GET /api/health
	applied=$(psql "select count(*) from drizzle.__drizzle_migrations")
	journal=$(jq '.entries | length' /src/packages/db/drizzle/meta/_journal.json)
	# The api entrypoint migrates under the advisory lock before it serves, so serving proves it ran.
	[ "$code" = 200 ] && [ "$applied" = "$journal" ] &&
		pass "healthy after the update, $applied/$journal migrations applied" ||
		fail "health and migrations" "HTTP $code, $applied of $journal migrations"

	frames=$(docker exec ls-test-rel-ws cat /tmp/frames 2>&1 || true)
	grep -q '"kind":"update"' <<<"$frames" && grep -q '"logistack-worker":"done"' <<<"$frames" &&
		pass "/ws streamed instance-update:<id> progress ($(grep -c '"kind":"update"' <<<"$frames") frames)" ||
		fail "/ws progress" "$(head -c 300 <<<"$frames")"
	docker rm -f ls-test-rel-ws >/dev/null
fi

docker rm -f ls-test-pkg-client >/dev/null
printf 'total %ss\n' "$SECONDS"
exit "$FAILED"

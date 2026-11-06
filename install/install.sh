#!/usr/bin/env bash
# LogiStack installer. Idempotent: re-run it to repair or upgrade.
#   curl -fsSL <url>/install.sh | sudo bash -s -- [--version X] [--advertise-addr IP] [--yes] [--dry-run]
#   sudo bash install/install.sh --local-build    (from a checkout: build the images here, pull nothing)
#
# Private setup (the default): until setup is done the dashboard is reachable only through an SSH
# tunnel to 127.0.0.1:$TUNNEL_PORT, served by a plain container (Swarm cannot publish on loopback).
# Caddy's bootstrap catch-all answers 404 instead of proxying to the api; after setup the worker
# routes the dashboard's own domain over https. --public-setup keeps the catch-all proxy and
# requires a one-time setup token instead. It is not persisted: a re-run without it is private.
#
# Ingress off (--no-ingress): Caddy is a global service constrained to node.labels.logistack.ingress
# == true, so labelling the node logistack.ingress=pending leaves it at 0 tasks and 80/443 free for
# the proxy being migrated away from. The label is the persisted choice: a plain re-run keeps ingress
# off, and --enable-ingress relabels the node true (Swarm then schedules Caddy) and redeploys.
#
# On a Dokploy server (Swarm service `dokploy`, or /etc/dokploy) the install is --no-ingress and
# private, Dokploy's Traefik keeps 80/443, and stack.dokploy.yml lets the api read Dokploy's database
# and /etc/dokploy for the migration wizard. On a Coolify server (a running `coolify` container) the
# install is likewise --no-ingress and private, Coolify's proxy keeps 80/443, Swarm starts with an
# address pool clear of Coolify's networks, and stack.coolify.yml lets the api read Coolify's
# database over the ls-coolify-bridge overlay, with its password and APP_KEY as Swarm secrets.
set -euo pipefail

# Empty on main: a fresh install asks GitHub for the latest release. The copy attached to a
# release pins its own version here.
DEFAULT_VERSION=""
RELEASES_API="https://api.github.com/repos/logical-tech/logistack/releases/latest"
STACK_NAME="logistack"
CONF_DIR="/etc/logistack"
CREDENTIALS_FILE="$CONF_DIR/credentials"
LOG_FILE="/var/log/logistack-install.log"
STACK_URL_BASE="${LOGISTACK_STACK_URL_BASE:-https://raw.githubusercontent.com/logical-tech/logistack}"
WAIT_TIMEOUT="${LOGISTACK_WAIT_TIMEOUT:-300}"
MIN_RAM_MB=1800
MIN_DISK_GB=10
MIN_DOCKER_MAJOR=26

VERSION=""
RUNNING_VERSION=""
ADVERTISE_ADDR=""
ASSUME_YES=0
DRY_RUN=0
LOCAL_BUILD=0
NO_INGRESS=0
ENABLE_INGRESS=0
PUBLIC_SETUP=0
REGISTRY="ghcr.io/logical-tech"
CONTROL_SUBNET="10.247.0.0/16"
TUNNEL_NAME="logistack-api-tunnel"
MOTD_FILE="/etc/update-motd.d/99-logistack"
TUNNEL_PORT=${LOGISTACK_TUNNEL_PORT:-3000}
MIGRATION_FILE="$CONF_DIR/migration"
MIGRATION_ARCHIVE_DIR=/var/lib/logistack/migration
DOKPLOY_STACK=stack.dokploy.yml
# Made from the dokploy-postgres env when Dokploy predates its own secret.
DOKPLOY_PG_COPY=logistack-dokploy-postgres-password
# Dokploy encrypts env at rest with ENCRYPTION_KEY, else BETTER_AUTH_SECRET, else a fixed default.
DOKPLOY_KEY_COPY=logistack-dokploy-key
DOKPLOY_LEGACY_SECRET=better-auth-secret-123456789
COOLIFY_STACK=stack.coolify.yml
COOLIFY_ENV=/data/coolify/source/.env
COOLIFY_DB_SECRET=logistack-coolify-db-password
COOLIFY_KEY_SECRET=logistack-coolify-app-key
# LogiStack's overlay on a Coolify server: coolify-db joins it for the wizard, and during the
# migration Coolify's proxy and containers do too (the bridge, COOL-1).
COOLIFY_BRIDGE=ls-coolify-bridge
# Overlay address pools tried in order on a Coolify server; Coolify gives Docker 10.0.0.0/8 in /24s
# from the bottom, which a default `swarm init` (10.0.0.0/8 too) collides with.
SWARM_POOLS="10.248.0.0/16 10.249.0.0/16 172.29.0.0/16 192.168.248.0/21"

OS_ID=""
OS_VERSION=""
OS_CODENAME=""
DOCKER_READY=0
SWARM_STATE="inactive"
PUBLIC_IP=""
PUBLIC_URL=""
IMAGE_TAG=""
DOKPLOY=0
DOKPLOY_PG_SECRET=""
DOKPLOY_KEY_SECRET=""
DOKPLOY_KEY_SOURCE=""
DOKPLOY_PG_USER=""
DOKPLOY_PG_DB=""
COOLIFY=0
COOLIFY_DB_USER=""
COOLIFY_DB_NAME=""

if [ -t 1 ]; then
	BOLD=$'\033[1m' DIM=$'\033[2m' GREEN=$'\033[32m' RED=$'\033[31m' YELLOW=$'\033[33m' RESET=$'\033[0m'
else
	BOLD="" DIM="" GREEN="" RED="" YELLOW="" RESET=""
fi

step() { printf '\n%s%s%s\n' "$BOLD" "$*" "$RESET"; }
ok() { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
note() { printf '    %s%s%s\n' "$DIM" "$*" "$RESET"; }
plan() { printf '  %s→%s would %s\n' "$DIM" "$RESET" "$*"; }
fail() {
	printf '  %s✗%s %s\n' "$RED" "$RESET" "$*" >&2
	exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
	cat <<EOF
Usage: install.sh [options]

  --version X          Release to install or upgrade to, such as 0.2.0, v0.2.0 or latest
                       (default: the running release, else ${DEFAULT_VERSION:-the latest release})
  --advertise-addr IP  Address other Swarm nodes reach this one on (default: auto-detected)
  --yes, -y            Do not ask for confirmation
  --dry-run            Print the plan and change nothing
  --local-build        Build the images from this checkout instead of pulling them (single node)
  --no-ingress         Leave Caddy off and ports 80/443 to another proxy; reach the API through
                       an SSH tunnel to 127.0.0.1:$TUNNEL_PORT. Kept on re-runs until --enable-ingress
  --enable-ingress     Turn Caddy on after --no-ingress (80/443 must be free by then)
  --public-setup       Serve the setup wizard on the public address before setup, guarded by a
                       one-time setup token printed at the end (default: only through an SSH
                       tunnel to 127.0.0.1:$TUNNEL_PORT)
  --help, -h           Show this help
EOF
}

# act "<what>" command...: runs quietly into the log, or only prints the plan on --dry-run.
act() {
	local what=$1
	shift
	if [ "$DRY_RUN" = 1 ]; then
		plan "$what"
		return 0
	fi
	if "$@" >>"$LOG_FILE" 2>&1; then
		ok "$what"
	else
		printf '  %s✗%s %s\n' "$RED" "$RESET" "$what" >&2
		tail -n 15 "$LOG_FILE" | sed 's/^/    /' >&2
		fail "Full log: $LOG_FILE"
	fi
}

http_get() {
	if have curl; then
		curl -fsS --max-time 5 "$1"
	else
		wget -qO- -T 5 "$1"
	fi
}

is_ipv4() { [[ $1 =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; }

is_private_ipv4() {
	[[ $1 =~ ^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.) ]]
}

parse_args() {
	while [ $# -gt 0 ]; do
		case "$1" in
		--version) VERSION=${2:?--version needs a value}; shift ;;
		--version=*) VERSION=${1#*=} ;;
		--advertise-addr) ADVERTISE_ADDR=${2:?--advertise-addr needs a value}; shift ;;
		--advertise-addr=*) ADVERTISE_ADDR=${1#*=} ;;
		--yes | -y) ASSUME_YES=1 ;;
		--dry-run) DRY_RUN=1 ;;
		--local-build) LOCAL_BUILD=1 REGISTRY=localhost ;;
		--no-ingress) NO_INGRESS=1 ;;
		--enable-ingress) ENABLE_INGRESS=1 ;;
		--public-setup) PUBLIC_SETUP=1 ;;
		--help | -h) usage; exit 0 ;;
		*) usage >&2; fail "Unknown option: $1" ;;
		esac
		shift
	done
	[ "$NO_INGRESS" = 0 ] || [ "$ENABLE_INGRESS" = 0 ] || fail "--no-ingress and --enable-ingress are mutually exclusive"
	[[ $VERSION =~ ^v[0-9] ]] && VERSION=${VERSION#v}
	if [ -n "$VERSION" ] && [[ ! $VERSION =~ ^[0-9A-Za-z][0-9A-Za-z._-]*$ ]]; then
		fail "--version must be a release such as 0.2.0, or latest"
	fi
	if [ -n "$ADVERTISE_ADDR" ]; then
		# shortcut: IPv4 only; add IPv6 (and sslip's dashed IPv6 form) when someone needs it.
		is_ipv4 "$ADVERTISE_ADDR" || fail "--advertise-addr must be an IPv4 address"
		[[ $ADVERTISE_ADDR != 127.* ]] || fail "--advertise-addr cannot be a loopback address"
	fi
}

check_root() {
	if [ "$(id -u)" -eq 0 ]; then
		ok "Running as root"
	elif [ "$DRY_RUN" = 1 ]; then
		warn "Not root; the dry run may miss details that need root"
	else
		fail "Run as root, for example: sudo bash install.sh"
	fi
}

check_os() {
	if [ -r /etc/os-release ]; then
		# shellcheck disable=SC1091
		OS_ID=$(. /etc/os-release && printf '%s' "${ID:-}")
		# shellcheck disable=SC1091
		OS_VERSION=$(. /etc/os-release && printf '%s' "${VERSION_ID:-}")
		# shellcheck disable=SC1091
		OS_CODENAME=$(. /etc/os-release && printf '%s' "${VERSION_CODENAME:-}")
	fi
	local major=${OS_VERSION%%.*}
	case "$OS_ID" in
	ubuntu) [[ $major =~ ^[0-9]+$ ]] && [ "$major" -ge 22 ] && { ok "Ubuntu $OS_VERSION"; return; } ;;
	debian) [[ $major =~ ^[0-9]+$ ]] && [ "$major" -ge 12 ] && { ok "Debian $OS_VERSION"; return; } ;;
	esac
	warn "${OS_ID:-unknown} ${OS_VERSION} is untested; supported are Ubuntu 22.04+ and Debian 12+"
}

check_arch() {
	case "$(uname -m)" in
	x86_64 | amd64) ok "Architecture amd64" ;;
	aarch64 | arm64) ok "Architecture arm64" ;;
	*) fail "Unsupported architecture $(uname -m); LogiStack images exist for amd64 and arm64" ;;
	esac
}

check_resources() {
	local ram_mb disk_gb path=/var/lib/docker
	ram_mb=$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo)
	[ "$ram_mb" -ge "$MIN_RAM_MB" ] || fail "${ram_mb} MB of RAM; LogiStack needs at least 2 GB"
	[ -d "$path" ] || path=/
	disk_gb=$(df -Pk "$path" | awk 'NR == 2 { print int($4 / 1048576) }')
	[ "$disk_gb" -ge "$MIN_DISK_GB" ] || fail "${disk_gb} GB free on $path; LogiStack needs at least ${MIN_DISK_GB} GB"
	ok "${ram_mb} MB RAM, ${disk_gb} GB free disk"
}

port_busy() {
	local proto=$1 port=$2
	if have ss; then
		[ -n "$(ss -Hln"${proto:0:1}" "sport = :$port" 2>/dev/null)" ]
	elif have netstat; then
		grep -Eq "[:.]$port\$" <<<"$(netstat -ln"${proto:0:1}" 2>/dev/null | awk '{ print $4 }')"
	else
		return 1
	fi
}

nodes_labelled() {
	[ "$SWARM_STATE" = active ] || return 0
	docker node ls -q --filter "node.label=logistack.ingress=$1"
}

# The dokploy-postgres env, one variable per line. Holds the password on old Dokploy releases:
# pipe it, never keep it in a variable or pass it as an argument.
dokploy_pg_env() {
	docker service inspect dokploy-postgres --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}'
}

# Dokploy keeps no database credentials under /etc/dokploy: the password is a Swarm secret the
# dokploy-postgres service reads through POSTGRES_PASSWORD_FILE, or, on releases before 0.26.6,
# a plain POSTGRES_PASSWORD in that service's env.
dokploy_env() {
	docker service inspect dokploy --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' 2>/dev/null || true
}

# The key Dokploy encrypts env with, for the wizard to read it: the same Swarm secret when Dokploy
# reads it from a file, else a copy of its env value or of Dokploy's own default into our secret.
read_dokploy_key() {
	local var file name target
	DOKPLOY_KEY_SOURCE=""
	for var in ENCRYPTION_KEY BETTER_AUTH_SECRET; do
		file=$(dokploy_env | sed -n "s/^${var}_FILE=//p" | head -n1)
		if [ -n "$file" ]; then
			while read -r name target; do
				[ "${target##*/}" != "${file##*/}" ] || DOKPLOY_KEY_SECRET=$name
			done < <(docker service inspect dokploy \
				--format '{{range .Spec.TaskTemplate.ContainerSpec.Secrets}}{{.SecretName}} {{.File.Name}}{{println}}{{end}}')
			[ -n "$DOKPLOY_KEY_SECRET" ] || fail "dokploy reads $var from $file, but no Swarm secret is mounted there"
			ok "Dokploy's encryption key: $var from secret $DOKPLOY_KEY_SECRET"
			return 0
		fi
		if dokploy_env | grep -q "^${var}="; then
			DOKPLOY_KEY_SECRET=$DOKPLOY_KEY_COPY DOKPLOY_KEY_SOURCE=$var
			ok "Dokploy's encryption key: $var from its service env, copied into secret $DOKPLOY_KEY_COPY"
			return 0
		fi
	done
	DOKPLOY_KEY_SECRET=$DOKPLOY_KEY_COPY DOKPLOY_KEY_SOURCE=legacy
	ok "Dokploy's encryption key: its built-in default (no secret configured)"
}

copy_dokploy_key() {
	if [ "$DOKPLOY_KEY_SOURCE" = legacy ]; then
		printf '%s' "$DOKPLOY_LEGACY_SECRET"
	else
		dokploy_env | sed -n "s/^${DOKPLOY_KEY_SOURCE}=//p" | head -n1 | tr -d '\n'
	fi | secret_create_stdin "$DOKPLOY_KEY_COPY"
}

read_dokploy_db() {
	local file name target
	DOKPLOY_PG_USER=$(dokploy_pg_env | sed -n 's/^POSTGRES_USER=//p' | head -n1)
	DOKPLOY_PG_USER=${DOKPLOY_PG_USER:-postgres}
	DOKPLOY_PG_DB=$(dokploy_pg_env | sed -n 's/^POSTGRES_DB=//p' | head -n1)
	DOKPLOY_PG_DB=${DOKPLOY_PG_DB:-$DOKPLOY_PG_USER}
	file=$(dokploy_pg_env | sed -n 's/^POSTGRES_PASSWORD_FILE=//p' | head -n1)
	if [ -n "$file" ]; then
		while read -r name target; do
			[ "${target##*/}" != "${file##*/}" ] || DOKPLOY_PG_SECRET=$name
		done < <(docker service inspect dokploy-postgres \
			--format '{{range .Spec.TaskTemplate.ContainerSpec.Secrets}}{{.SecretName}} {{.File.Name}}{{println}}{{end}}')
		[ -n "$DOKPLOY_PG_SECRET" ] || fail "dokploy-postgres reads its password from $file, but no Swarm secret is mounted there"
	elif dokploy_pg_env | grep -q '^POSTGRES_PASSWORD='; then
		DOKPLOY_PG_SECRET=$DOKPLOY_PG_COPY
	else
		fail "Could not find the password of Dokploy's database in the dokploy-postgres service"
	fi
	docker network inspect dokploy-network >/dev/null 2>&1 || fail "Dokploy found, but its network dokploy-network is missing"
	ok "Dokploy database: user $DOKPLOY_PG_USER, database $DOKPLOY_PG_DB, password from secret $DOKPLOY_PG_SECRET"
}

# One value of Coolify's .env, quotes stripped; never printed.
coolify_env() {
	sed -n "s/^$1=//p" "$COOLIFY_ENV" | head -n1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/" | tr -d '\r\n'
}

detect_coolify() {
	[ "$(docker container inspect -f '{{.State.Running}}' coolify-db 2>/dev/null)" = true ] ||
		fail "Coolify found, but its database container coolify-db is not running; start Coolify and re-run"
	[ -r "$COOLIFY_ENV" ] || fail "Coolify found, but $COOLIFY_ENV is not readable; run the installer as root"
	[ -n "$(coolify_env DB_PASSWORD)" ] || fail "Coolify found, but $COOLIFY_ENV has no DB_PASSWORD"
	[ -n "$(coolify_env APP_KEY)" ] || fail "Coolify found, but $COOLIFY_ENV has no APP_KEY"
	COOLIFY=1
	COOLIFY_DB_USER=$(coolify_env DB_USERNAME)
	COOLIFY_DB_USER=${COOLIFY_DB_USER:-coolify}
	COOLIFY_DB_NAME=$(coolify_env DB_DATABASE)
	COOLIFY_DB_NAME=${COOLIFY_DB_NAME:-coolify}
	ok "Coolify found"
	note "LogiStack installs next to Coolify and changes nothing of it:"
	note "  - Caddy stays off, so Coolify's proxy keeps ports 80 and 443 and your sites stay up."
	note "  - Until setup is done the dashboard is reachable only through an SSH tunnel."
	note "  - The api reads Coolify's database, read-only, over LogiStack's own network $COOLIFY_BRIDGE."
	note "  - Swarm starts with an address pool clear of Coolify's networks; Coolify does not use Swarm."
	note "After setup, the wizard imports your Coolify projects and moves each service over to LogiStack."
	ok "Coolify database: user $COOLIFY_DB_USER, database $COOLIFY_DB_NAME; its password and APP_KEY go into Swarm secrets"
}

detect_migration_source() {
	if [ "$DOCKER_READY" = 1 ] && [ "$(docker container inspect -f '{{.State.Running}}' coolify 2>/dev/null)" = true ]; then
		detect_coolify
		return 0
	fi
	[ ! -d /data/coolify ] || note "/data/coolify exists but Coolify is not running; installing as usual"
	local service=0 database=0
	if [ "$DOCKER_READY" = 1 ]; then
		docker service inspect dokploy >/dev/null 2>&1 && service=1
		docker service inspect dokploy-postgres >/dev/null 2>&1 && database=1
	fi
	[ "$service" = 1 ] || [ -d /etc/dokploy ] || return 0
	if [ "$service" = 0 ] && [ "$database" = 0 ]; then
		note "/etc/dokploy exists but Dokploy is not running; installing as usual"
		return 0
	fi
	[ "$database" = 1 ] || fail "Dokploy found, but its database service dokploy-postgres is missing; start Dokploy and re-run"
	DOKPLOY=1
	ok "Dokploy found"
	note "LogiStack installs next to Dokploy and changes nothing of it:"
	note "  - Caddy stays off, so Dokploy's Traefik keeps ports 80 and 443 and your sites stay up."
	note "  - Until setup is done the dashboard is reachable only through an SSH tunnel."
	note "  - The api reads Dokploy's database and /etc/dokploy, read-only, for the migration wizard."
	note "After setup, the wizard imports your Dokploy projects and moves each service over to LogiStack."
	read_dokploy_db
	read_dokploy_key
	# Dokploy publishes its own dashboard on 3000.
	[ -n "${LOGISTACK_TUNNEL_PORT:-}" ] || TUNNEL_PORT=3001
}

# A node labelled pending records an earlier --no-ingress; keep it unless --enable-ingress.
# Next to Dokploy ingress starts off, unless it is already on (a re-run after cutover).
detect_ingress_mode() {
	[ "$DOCKER_READY" = 1 ] || return 0
	if [ -n "$(nodes_labelled true)" ]; then
		[ "$NO_INGRESS" = 0 ] || fail "Ingress is already on in this Swarm; --no-ingress only applies before Caddy is enabled"
	elif [ "$ENABLE_INGRESS" = 0 ] && { [ -n "$(nodes_labelled pending)" ] || [ "$DOKPLOY" = 1 ] || [ "$COOLIFY" = 1 ]; }; then
		NO_INGRESS=1
	fi
	[ "$NO_INGRESS" = 0 ] || [ "$PUBLIC_SETUP" = 0 ] || fail "--public-setup needs ingress: without Caddy setup is reachable only through the tunnel"
	if [ "$NO_INGRESS" = 1 ]; then ok "Ingress off: Caddy stays at 0 tasks (--enable-ingress turns it on)"; fi
}

check_ports() {
	if [ "$NO_INGRESS" = 1 ]; then
		if [ "$DOKPLOY" = 1 ]; then
			ok "Ports 80 and 443 left to Dokploy's Traefik"
		elif [ "$COOLIFY" = 1 ]; then
			ok "Ports 80 and 443 left to Coolify's proxy"
		else ok "Ports 80 and 443 left to the existing proxy"; fi
		return
	fi
	if [ "$DOCKER_READY" = 1 ] && [ -n "$(nodes_labelled true)" ] &&
		docker service inspect "${STACK_NAME}_caddy" >/dev/null 2>&1; then
		ok "Ports 80 and 443 belong to the LogiStack Caddy"
		return
	fi
	local busy=()
	port_busy tcp 80 && busy+=("80/tcp")
	port_busy tcp 443 && busy+=("443/tcp")
	port_busy udp 443 && busy+=("443/udp")
	[ ${#busy[@]} -eq 0 ] || fail "Ports in use: ${busy[*]}. Stop the web server holding them and re-run."
	ok "Ports 80 and 443 are free"
}

ipv4_int() {
	local a b c d
	IFS=. read -r a b c d <<<"$1"
	printf '%s' $(((a << 24) + (b << 16) + (c << 8) + d))
}

# Two IPv4 CIDRs overlap when they agree on the shorter prefix.
cidr_overlap() {
	local len=$((${1#*/} < ${2#*/} ? ${1#*/} : ${2#*/})) mask
	mask=$(((0xFFFFFFFF << (32 - len)) & 0xFFFFFFFF))
	[ $(($(ipv4_int "${1%/*}") & mask)) -eq $(($(ipv4_int "${2%/*}") & mask)) ]
}

# The stack pins ls-control to $CONTROL_SUBNET; an existing network on that range, or a foreign
# network already named ls-control, ls-ingress, ls-storage, ls-db or ls-game, makes `docker stack deploy` fail halfway.
check_networks() {
	[ "$DOCKER_READY" = 1 ] || return 0
	local listing name stack subnets subnet
	listing=$(docker network ls -q | xargs docker network inspect --format \
		'{{.Name}} {{with index .Labels "com.docker.stack.namespace"}}{{.}}{{else}}-{{end}} {{range .IPAM.Config}}{{.Subnet}} {{end}}') ||
		fail "Could not inspect the Docker networks"
	while read -r name stack subnets; do
		if [ "$name" = ls-control ] || [ "$name" = ls-ingress ] || [ "$name" = ls-storage ] || [ "$name" = ls-db ] || [ "$name" = ls-game ]; then
			[ "$stack" = "$STACK_NAME" ] ||
				fail "A network named $name exists outside the $STACK_NAME stack; remove or rename it and re-run"
			continue
		fi
		for subnet in $subnets; do
			[[ $subnet =~ ^[0-9.]+/[0-9]+$ ]] || continue
			! cidr_overlap "$subnet" "$CONTROL_SUBNET" ||
				fail "Network $name uses $subnet, which overlaps ls-control's fixed $CONTROL_SUBNET; move that network to another range and re-run"
		done
	done <<<"$listing"
	ok "No network overlaps ls-control ($CONTROL_SUBNET)"
	[ "$COOLIFY" = 1 ] && [ "$SWARM_STATE" = active ] || return 0
	# An overlay on a subnet a local bridge already routes breaks containers on both: the bridge.
	local scoped local_subnets swarm_subnets a b
	scoped=$(docker network ls -q | xargs docker network inspect --format '{{.Scope}} {{range .IPAM.Config}}{{.Subnet}} {{end}}')
	local_subnets=$(awk '$1 == "local" { $1 = ""; print }' <<<"$scoped")
	swarm_subnets=$(awk '$1 == "swarm" { $1 = ""; print }' <<<"$scoped")
	for a in $swarm_subnets; do
		[[ $a =~ ^[0-9.]+/[0-9]+$ ]] || continue
		for b in $local_subnets; do
			[[ $b =~ ^[0-9.]+/[0-9]+$ ]] || continue
			! cidr_overlap "$a" "$b" ||
				fail "This Swarm's overlay $a overlaps the local network $b next to Coolify; the bridge would break. Re-create the Swarm with --default-addr-pool outside Coolify's networks"
		done
	done
	ok "No Swarm overlay overlaps Coolify's networks"
}

# The first of SWARM_POOLS that overlaps no Docker network and no host route.
free_swarm_pool() {
	local taken pool t clash
	taken="$(docker network ls -q | xargs docker network inspect --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}') $(ip -4 route 2>/dev/null | awk '{ print $1 }')"
	for pool in $SWARM_POOLS; do
		clash=0
		for t in $taken; do
			[[ $t =~ ^[0-9.]+/[0-9]+$ ]] || continue
			if cidr_overlap "$pool" "$t"; then clash=1; break; fi
		done
		[ "$clash" = 1 ] || { printf '%s' "$pool"; return 0; }
	done
	return 1
}

check_docker() {
	if ! have docker; then
		DOCKER_READY=0
		return
	fi
	if ! docker info >/dev/null 2>&1; then
		DOCKER_READY=0
		return
	fi
	DOCKER_READY=1
	SWARM_STATE=$(docker info --format '{{.Swarm.LocalNodeState}}')
}

detect_addresses() {
	if [ "$SWARM_STATE" = active ]; then
		local existing
		existing=$(docker info --format '{{.Swarm.NodeAddr}}')
		if [ -n "$ADVERTISE_ADDR" ] && [ "$ADVERTISE_ADDR" != "$existing" ]; then
			warn "Swarm already advertises $existing; ignoring --advertise-addr $ADVERTISE_ADDR"
		fi
		ADVERTISE_ADDR=$existing
	fi
	if [ -z "$ADVERTISE_ADDR" ]; then
		if have ip; then
			ADVERTISE_ADDR=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n1)
		fi
		if [ -z "$ADVERTISE_ADDR" ] && have hostname; then
			ADVERTISE_ADDR=$(hostname -I 2>/dev/null | awk '{ print $1 }')
		fi
	fi
	is_ipv4 "${ADVERTISE_ADDR:-}" || fail "Could not detect this server's address; pass --advertise-addr <ip>"
	[[ $ADVERTISE_ADDR != 127.* ]] || fail "Detected loopback $ADVERTISE_ADDR; pass --advertise-addr <ip>"

	PUBLIC_IP=$ADVERTISE_ADDR
	if is_private_ipv4 "$ADVERTISE_ADDR"; then
		local seen
		seen=$(http_get https://api.ipify.org 2>/dev/null || true)
		if is_ipv4 "$seen"; then PUBLIC_IP=$seen; fi
	fi
	PUBLIC_URL="http://${PUBLIC_IP//./-}.sslip.io"
	# Without Caddy the dashboard is reached through the SSH tunnel, so that is the origin to trust.
	[ "$NO_INGRESS" = 0 ] || PUBLIC_URL="http://localhost:$TUNNEL_PORT"
	ok "Swarm address $ADVERTISE_ADDR"
	ok "Public address $PUBLIC_IP"
}

# The release the api runs, from its image tag: ghcr.io/.../logistack:0.2.0@sha256:... or
# localhost/logistack:0.1.0-local.<hash>. In-app updates change it without touching $CONF_DIR.
running_version() {
	have docker || return 0
	local image
	image=$(docker service inspect "${STACK_NAME}_logistack-api" \
		--format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' 2>/dev/null) || return 0
	image=${image%%@*}
	image=${image##*:}
	printf '%s' "${image%%-local.*}"
}

# Unauthenticated: GitHub allows 60 requests an hour per IP. `releases/latest` skips prereleases.
latest_version() {
	local tag
	tag=$(http_get "$RELEASES_API" 2>/dev/null | grep -o '"tag_name": *"[^"]*"' | head -n1 | sed 's/.*"v\{0,1\}\([^"]*\)"$/\1/') || true
	[ -n "$tag" ] || fail "Could not get the latest release from GitHub; pass --version X"
	printf '%s' "$tag"
}

resolve_version() {
	RUNNING_VERSION=$(running_version)
	if [ "$VERSION" = latest ]; then
		VERSION=$(latest_version)
	elif [ -z "$VERSION" ]; then
		# A plain re-run repairs what runs; it never upgrades on its own.
		VERSION=$RUNNING_VERSION
		if [ -z "$VERSION" ] && [ -r "$CONF_DIR/version" ]; then VERSION=$(cat "$CONF_DIR/version"); fi
		VERSION=${VERSION:-$DEFAULT_VERSION}
		if [ -z "$VERSION" ]; then
			# A checkout's own build has no release to be; 0.0.0 sorts before every real one.
			if [ "$LOCAL_BUILD" = 1 ]; then VERSION=0.0.0; else VERSION=$(latest_version); fi
		fi
	fi
	IMAGE_TAG=$VERSION
}

confirm() {
	if [ "$ASSUME_YES" = 1 ] || [ "$DRY_RUN" = 1 ]; then return 0; fi
	if ! { : </dev/tty; } 2>/dev/null; then
		fail "No terminal to confirm on; re-run with --yes"
	fi
	local answer what="Install LogiStack $VERSION"
	if [ -n "$RUNNING_VERSION" ] && [ "$RUNNING_VERSION" != "$VERSION" ]; then
		what="Upgrade LogiStack $RUNNING_VERSION to $VERSION"
	fi
	printf '\n  %s on %s? [Y/n] ' "$what" "$ADVERTISE_ADDR" >/dev/tty
	read -r answer </dev/tty
	case "$answer" in
	"" | y | Y | yes | YES) ;;
	*) fail "Aborted, nothing changed" ;;
	esac
}

install_docker_apt() {
	export DEBIAN_FRONTEND=noninteractive
	apt-get update -q
	apt-get install -y -q ca-certificates curl
	install -m 0755 -d /etc/apt/keyrings
	curl -fsSL "https://download.docker.com/linux/$OS_ID/gpg" -o /etc/apt/keyrings/docker.asc
	chmod a+r /etc/apt/keyrings/docker.asc
	printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
		"$(dpkg --print-architecture)" "$OS_ID" "$OS_CODENAME" >/etc/apt/sources.list.d/docker.list
	apt-get update -q
	apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
	systemctl enable --now docker
}

ensure_docker() {
	if [ "$DOCKER_READY" = 1 ]; then
		local version
		version=$(docker version --format '{{.Server.Version}}')
		[ "${version%%.*}" -ge "$MIN_DOCKER_MAJOR" ] || fail "Docker $version is too old; upgrade to $MIN_DOCKER_MAJOR or newer"
		ok "Docker $version"
		return
	fi
	if have docker && have systemctl; then
		act "Start Docker" systemctl enable --now docker
	else
		case "$OS_ID" in
		ubuntu | debian) act "Install Docker from download.docker.com" install_docker_apt ;;
		*) fail "Docker is missing. Install it (https://docs.docker.com/engine/install/) and re-run." ;;
		esac
	fi
	[ "$DRY_RUN" = 1 ] || check_docker
}

# Ubuntu 23.10+ refuses user namespaces to unconfined programs. Rootless BuildKit needs one: without
# it rootlesskit dies with "fork/exec /proc/self/exe: permission denied" and no Dockerfile builds.
USERNS_SYSCTL=/etc/sysctl.d/60-logistack-userns.conf

allow_userns() {
	printf '%s\n' "# LogiStack: rootless BuildKit needs unprivileged user namespaces (Ubuntu 23.10+ restricts them)." \
		"kernel.apparmor_restrict_unprivileged_userns = 0" >"$USERNS_SYSCTL"
	sysctl -p "$USERNS_SYSCTL"
}

ensure_rootless_buildkit() {
	[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ] || return 0
	act "Allow unprivileged user namespaces for rootless BuildKit ($USERNS_SYSCTL)" allow_userns
}

ensure_swarm() {
	case "$SWARM_STATE" in
	active)
		[ "$(docker info --format '{{.Swarm.ControlAvailable}}')" = true ] ||
			fail "This node is a Swarm worker; run the installer on a manager"
		ok "Swarm active, this node is a manager"
		;;
	inactive)
		if [ "$COOLIFY" = 1 ]; then
			local pool
			pool=$(free_swarm_pool) || fail "No overlay address pool is free of this server's networks (tried $SWARM_POOLS)"
			act "Initialise Swarm on $ADVERTISE_ADDR with address pool $pool (clear of Coolify's networks)" \
				docker swarm init --advertise-addr "$ADVERTISE_ADDR" --default-addr-pool "$pool"
		else
			act "Initialise Swarm on $ADVERTISE_ADDR" docker swarm init --advertise-addr "$ADVERTISE_ADDR"
		fi
		[ "$DRY_RUN" = 1 ] || SWARM_STATE=active
		;;
	locked) fail "Swarm is locked; run 'docker swarm unlock' first" ;;
	*) fail "Swarm is in state '$SWARM_STATE'; fix it and re-run" ;;
	esac

	# Only label when no node has it yet, so a re-run never adds a second data node.
	if [ "$SWARM_STATE" = active ] && [ -n "$(docker node ls -q --filter "node.label=logistack.data=true")" ]; then
		ok "Node label logistack.data already set"
	else
		act "Label this node logistack.data=true" label_node logistack.data=true
	fi
	ensure_ingress_label
}

ensure_ingress_label() {
	local pending node
	pending=$(nodes_labelled pending)
	if [ -n "$(nodes_labelled true)" ]; then
		ok "Node label logistack.ingress already set"
	elif [ "$NO_INGRESS" = 1 ]; then
		if [ -n "$pending" ]; then
			ok "Node label logistack.ingress=pending already set"
		else
			act "Label this node logistack.ingress=pending" label_node logistack.ingress=pending
		fi
	elif [ -n "$pending" ]; then
		for node in $pending; do act "Enable ingress on node $node" label_node logistack.ingress=true "$node"; done
	else
		act "Label this node logistack.ingress=true" label_node logistack.ingress=true
	fi
}

label_node() {
	docker node update --label-add "$1" "${2:-$(docker info --format '{{.Swarm.NodeID}}')}"
}

credential_get() {
	[ -r "$CREDENTIALS_FILE" ] || return 0
	sed -n "s/^$1=//p" "$CREDENTIALS_FILE" | head -n1
}

credential_put() {
	install -d -m 0700 "$CONF_DIR"
	(umask 077 && printf '%s=%s\n' "$1" "$2" >>"$CREDENTIALS_FILE")
}

secret_create() {
	printf '%s' "$2" | secret_create_stdin "$1"
}

secret_create_stdin() {
	docker secret create --label logistack.managed=true --label logistack.kind=platform-secret "$1" - >/dev/null
}

copy_dokploy_password() {
	dokploy_pg_env | sed -n 's/^POSTGRES_PASSWORD=//p' | head -n1 | tr -d '\n' | secret_create_stdin "$DOKPLOY_PG_COPY"
}

ensure_dokploy_secret() {
	[ "$DOKPLOY" = 1 ] || return 0
	if [ "$DOKPLOY_KEY_SECRET" = "$DOKPLOY_KEY_COPY" ]; then
		if [ "$DRY_RUN" = 0 ] && docker secret inspect "$DOKPLOY_KEY_COPY" >/dev/null 2>&1; then
			ok "Secret $DOKPLOY_KEY_COPY exists, kept"
		else
			act "Copy Dokploy's encryption key into secret $DOKPLOY_KEY_COPY" copy_dokploy_key
		fi
	fi
	[ "$DOKPLOY_PG_SECRET" = "$DOKPLOY_PG_COPY" ] || return 0
	if [ "$DRY_RUN" = 0 ] && docker secret inspect "$DOKPLOY_PG_COPY" >/dev/null 2>&1; then
		ok "Secret $DOKPLOY_PG_COPY exists, kept"
	else
		act "Copy Dokploy's database password into secret $DOKPLOY_PG_COPY" copy_dokploy_password
	fi
}

copy_coolify_value() {
	coolify_env "$1" | secret_create_stdin "$2"
}

ensure_coolify_secrets() {
	[ "$COOLIFY" = 1 ] || return 0
	local pair
	for pair in "DB_PASSWORD:$COOLIFY_DB_SECRET" "APP_KEY:$COOLIFY_KEY_SECRET"; do
		if [ "$DRY_RUN" = 0 ] && docker secret inspect "${pair#*:}" >/dev/null 2>&1; then
			ok "Secret ${pair#*:} exists, kept"
		else
			act "Copy Coolify's ${pair%%:*} into secret ${pair#*:}" copy_coolify_value "${pair%%:*}" "${pair#*:}"
		fi
	done
}

create_coolify_bridge() {
	docker network create --driver overlay --attachable \
		--label logistack.managed=true --label logistack.kind=migration-bridge --label logistack.resource=coolify \
		"$COOLIFY_BRIDGE" >/dev/null
}

# The api reads coolify-db over the bridge; Coolify's upgrade recreates coolify-db, so re-runs reattach it.
ensure_coolify_bridge() {
	[ "$COOLIFY" = 1 ] || return 0
	if [ "$DRY_RUN" = 0 ] && docker network inspect "$COOLIFY_BRIDGE" >/dev/null 2>&1; then
		ok "Network $COOLIFY_BRIDGE exists"
	else
		act "Create the overlay $COOLIFY_BRIDGE" create_coolify_bridge
	fi
	if [ "$DRY_RUN" = 0 ] && docker container inspect coolify-db --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' | grep -qw "$COOLIFY_BRIDGE"; then
		ok "coolify-db is on $COOLIFY_BRIDGE"
	else
		act "Connect coolify-db to $COOLIFY_BRIDGE (read-only access for the wizard)" docker network connect "$COOLIFY_BRIDGE" coolify-db
	fi
}

random_hex() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }
random_base64() { head -c 32 /dev/urandom | base64 | tr -d '\n'; }

ensure_secrets() {
	local entry name key format value
	for entry in master-key:LOGISTACK_MASTER_KEY:base64 postgres-password:POSTGRES_PASSWORD:hex \
		better-auth-secret:BETTER_AUTH_SECRET:hex redis-password:REDIS_PASSWORD:hex \
		agent-token:LOGISTACK_AGENT_TOKEN:hex setup-token:LOGISTACK_SETUP_TOKEN:hex; do
		IFS=: read -r name key format <<<"$entry"
		name="logistack-$name"
		value=$(credential_get "$key")
		if [ "$DOCKER_READY" = 1 ] && docker secret inspect "$name" >/dev/null 2>&1; then
			ok "Secret $name exists, kept"
			[ -n "$value" ] || warn "$key is missing from $CREDENTIALS_FILE; keep your own copy of it"
			continue
		fi
		if [ -z "$value" ]; then
			if [ "$DRY_RUN" = 0 ]; then
				if [ "$format" = base64 ]; then value=$(random_base64); else value=$(random_hex); fi
			fi
			act "Generate $key into $CREDENTIALS_FILE" credential_put "$key" "$value"
		fi
		act "Create secret $name" secret_create "$name" "$value"
	done
}

# stack_source <file>: next to this script in a checkout, else from the release.
stack_source() {
	local here
	if [ -f "${BASH_SOURCE[0]:-}" ]; then
		here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
		if [ -f "$here/$1" ]; then
			printf '%s' "$here/$1"
			return
		fi
	fi
	printf '%s' "$STACK_URL_BASE/v$VERSION/install/$1"
}

copy_stack_file() {
	local source
	source=$(stack_source "$1")
	if [ -f "$source" ]; then
		cp "$source" "$CONF_DIR/$1.new"
	else
		http_get "$source" >"$CONF_DIR/$1.new"
	fi
	mv "$CONF_DIR/$1.new" "$CONF_DIR/$1"
}

write_config() {
	install -d -m 0700 "$CONF_DIR"
	copy_stack_file stack.yml
	printf '%s\n' "$VERSION" >"$CONF_DIR/version"
	if [ "$COOLIFY" = 1 ]; then
		copy_stack_file "$COOLIFY_STACK"
		printf 'migration_source=coolify\n' >"$MIGRATION_FILE"
		install -d -m 0700 "$MIGRATION_ARCHIVE_DIR"
		return 0
	fi
	[ "$DOKPLOY" = 1 ] || return 0
	copy_stack_file "$DOKPLOY_STACK"
	printf 'migration_source=dokploy\n' >"$MIGRATION_FILE"
	# Where the wizard archives Dokploy before removing it; a Swarm bind mount needs it to exist.
	install -d -m 0700 "$MIGRATION_ARCHIVE_DIR"
}

firewall_advice() {
	step "Firewall"
	local tool=""
	if have ufw && grep -q '^Status: active' <<<"$(ufw status 2>/dev/null)"; then
		tool=ufw
	elif have firewall-cmd && firewall-cmd --state >/dev/null 2>&1; then
		tool=firewalld
	fi
	if [ -n "$tool" ]; then
		warn "$tool is active. Docker-published ports bypass its rules, so 80/443 are open regardless."
	else
		ok "No host firewall detected; check your provider's firewall allows 80/tcp, 443/tcp, 443/udp"
	fi
	note "Never publish a database port unless you mean it to be public."
	note "When you add servers, open these only between LogiStack nodes:"
	case "$tool" in
	firewalld)
		note "  firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=<node-ip> port port=2377 protocol=tcp accept'"
		note "  firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=<node-ip> port port=7946 protocol=tcp accept'"
		note "  firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=<node-ip> port port=7946 protocol=udp accept'"
		note "  firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=<node-ip> port port=4789 protocol=udp accept'"
		note "  firewall-cmd --reload"
		;;
	*)
		note "  ufw allow from <node-ip> to any port 2377 proto tcp"
		note "  ufw allow from <node-ip> to any port 7946"
		note "  ufw allow from <node-ip> to any port 4789 proto udp"
		;;
	esac
}

checkout_root() {
	local here
	here=$(cd "$(dirname "${BASH_SOURCE[0]:-}")" 2>/dev/null && pwd) || true
	if [ -z "$here" ] || [ ! -f "$here/../Dockerfile" ] || [ ! -f "$here/agent.Dockerfile" ]; then
		fail "--local-build needs a LogiStack checkout: run install/install.sh from the repository"
	fi
	(cd "$here/.." && pwd)
}

# Images are tagged localhost/<name>: no registry serves that name, so Swarm uses the local copy.
# No provenance attestation: it embeds a timestamp, so an unchanged build would get a new image id.
build_images() {
	local root
	root=$(checkout_root)
	[ "$DRY_RUN" = 1 ] || docker buildx version >/dev/null 2>&1 ||
		fail "--local-build needs Docker's buildx plugin (docker-buildx-plugin)"
	if [ "$DRY_RUN" = 0 ] && [ "$(docker node ls -q | wc -l)" -gt 1 ]; then
		warn "Locally built images exist only on this node; services placed elsewhere will not start"
	fi
	# safe.directory: the installer runs as root over a checkout someone else owns.
	local commit build
	commit=$(git -c safe.directory="$root" -C "$root" rev-parse --short HEAD 2>/dev/null || true)
	build=(docker build --provenance=false --build-arg "LOGISTACK_VERSION=$VERSION" --build-arg "LOGISTACK_COMMIT=$commit")
	act "Build $REGISTRY/logistack" "${build[@]}" --target api -t "$REGISTRY/logistack:build" "$root"
	act "Build $REGISTRY/logistack-worker" "${build[@]}" --target worker -t "$REGISTRY/logistack-worker:build" "$root"
	act "Build $REGISTRY/logistack-agent" "${build[@]}" -f "$root/install/agent.Dockerfile" -t "$REGISTRY/logistack-agent:build" "$root"
	act "Build $REGISTRY/logistack-caddy" "${build[@]}" -t "$REGISTRY/logistack-caddy:build" "$root/docker/caddy"
	[ "$DRY_RUN" = 0 ] || return 0
	# Swarm cannot see new content behind an unchanged tag, so the tag carries the image ids:
	# a re-run without code changes restarts nothing, any change rolls the services.
	local ids name
	ids=$(docker image inspect -f '{{.Id}}' "$REGISTRY"/logistack{,-worker,-agent,-caddy}:build)
	IMAGE_TAG="$VERSION-local.$(printf '%s' "$ids" | sha256sum | cut -c1-12)"
	for name in logistack logistack-worker logistack-agent logistack-caddy; do
		docker tag "$REGISTRY/$name:build" "$REGISTRY/$name:$IMAGE_TAG"
	done
	ok "Tagged the images $IMAGE_TAG"
}

deploy() {
	local flags=(--with-registry-auth)
	# Local images have no registry digest to resolve.
	[ "$LOCAL_BUILD" = 0 ] || flags=(--resolve-image never)
	# After setup Caddy serves the dashboard over https, so browsers send an https Origin;
	# BETTER_AUTH_URL keeps the http bootstrap URL and better-auth trusts both.
	local public=false token_file="" tunnel_origin=""
	if [ "$PUBLIC_SETUP" = 1 ]; then public=true token_file=/run/secrets/setup_token; fi
	if tunnel_wanted; then tunnel_origin="http://localhost:$TUNNEL_PORT"; fi
	local files=(-c "$CONF_DIR/stack.yml")
	[ "$DOKPLOY" = 0 ] || files+=(-c "$CONF_DIR/$DOKPLOY_STACK")
	[ "$COOLIFY" = 0 ] || files+=(-c "$CONF_DIR/$COOLIFY_STACK")
	act "Deploy stack $STACK_NAME $IMAGE_TAG" env LOGISTACK_VERSION="$VERSION" LOGISTACK_IMAGE_TAG="$IMAGE_TAG" \
		LOGISTACK_REGISTRY="$REGISTRY" LOGISTACK_PUBLIC_URL="$PUBLIC_URL" LOGISTACK_WEB_ORIGIN="https://${PUBLIC_URL#http://}" \
		LOGISTACK_PUBLIC_SETUP="$public" LOGISTACK_SETUP_TOKEN_FILE="$token_file" LOGISTACK_TUNNEL_ORIGIN="$tunnel_origin" \
		LOGISTACK_DOKPLOY_PG_SECRET="$DOKPLOY_PG_SECRET" LOGISTACK_DOKPLOY_PG_USER="$DOKPLOY_PG_USER" \
		LOGISTACK_DOKPLOY_PG_DB="$DOKPLOY_PG_DB" LOGISTACK_DOKPLOY_KEY_SECRET="${DOKPLOY_KEY_SECRET:-}" \
		LOGISTACK_COOLIFY_DB_USER="$COOLIFY_DB_USER" LOGISTACK_COOLIFY_DB_NAME="$COOLIFY_DB_NAME" docker stack deploy "${flags[@]}" --detach=true "${files[@]}" "$STACK_NAME"
}

# The SSH tunnel's target: without Caddy, or unless setup is public. Loopback only, never public.
tunnel_wanted() { [ "$NO_INGRESS" = 1 ] || [ "$PUBLIC_SETUP" = 0 ]; }

# A container on ls-control forwards 127.0.0.1:$TUNNEL_PORT on the host to the API. It reuses the
# Caddy image, so no extra image is pulled; with --public-setup, remove_tunnel drops it.
ensure_tunnel() {
	tunnel_wanted || return 0
	local image="$REGISTRY/logistack-caddy:$IMAGE_TAG" current
	current=$(docker inspect -f '{{.Config.Image}} {{.State.Running}} {{.Config.Cmd}}' "$TUNNEL_NAME" 2>/dev/null || true)
	if [ "$current" = "$image true [reverse-proxy --from :$TUNNEL_PORT --to logistack-api:3000]" ]; then
		ok "API tunnel on 127.0.0.1:$TUNNEL_PORT"
		return 0
	fi
	[ -z "$current" ] || act "Remove the old API tunnel" docker rm -f "$TUNNEL_NAME"
	! port_busy tcp "$TUNNEL_PORT" ||
		fail "Port $TUNNEL_PORT is taken; pick another with LOGISTACK_TUNNEL_PORT=<port>"
	act "Start the API tunnel on 127.0.0.1:$TUNNEL_PORT" docker run -d --name "$TUNNEL_NAME" \
		--restart unless-stopped --label logistack.managed=true --label logistack.kind=platform-tunnel \
		--network ls-control -p "127.0.0.1:$TUNNEL_PORT:$TUNNEL_PORT" --entrypoint caddy "$image" \
		reverse-proxy --from ":$TUNNEL_PORT" --to logistack-api:3000
}

# Runs only after wait_healthy saw Caddy answer, so a failed --public-setup keeps the way in.
remove_tunnel() {
	! tunnel_wanted && docker inspect "$TUNNEL_NAME" >/dev/null 2>&1 || return 0
	act "Remove the API tunnel $TUNNEL_NAME" docker rm -f "$TUNNEL_NAME"
}

# SSH login banner with the way into the setup wizard, for installs nobody watched (cloud-init,
# provider images). It asks the api on each login and goes quiet once setup is done.
write_motd() {
	[ -d /etc/update-motd.d ] || return 0
	local url
	if [ "$PUBLIC_SETUP" = 1 ]; then
		# Before setup Caddy's catch-all proxies :80 to the api; after setup it answers 404.
		url="http://127.0.0.1/api/setup/status"
	else
		url="http://127.0.0.1:$TUNNEL_PORT/api/setup/status"
	fi
	cat >"$MOTD_FILE" <<EOF
#!/bin/sh
# Written by the LogiStack installer; uninstall.sh removes it.
curl -fsS --max-time 2 "$url" 2>/dev/null | grep -q '"setupCompleted":false' || exit 0
printf '\nLogiStack is installed. Finish the guided setup in your browser:\n'
EOF
	if [ "$PUBLIC_SETUP" = 1 ]; then
		cat >>"$MOTD_FILE" <<EOF
token=\$(sed -n 's/^LOGISTACK_SETUP_TOKEN=//p' "$CREDENTIALS_FILE" 2>/dev/null | head -n1)
[ -n "\$token" ] || exit 0
printf '  $PUBLIC_URL/setup#token=%s\n' "\$token"
printf '  Until setup is done, anyone holding this link can claim the server.\n\n'
EOF
	else
		cat >>"$MOTD_FILE" <<EOF
printf '  From your machine: ssh -L $TUNNEL_PORT:127.0.0.1:$TUNNEL_PORT root@$PUBLIC_IP\n'
printf '  then open http://localhost:$TUNNEL_PORT\n\n'
EOF
	fi
	chmod 0755 "$MOTD_FILE"
}

tunnel_ready() {
	local code
	code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$TUNNEL_PORT/api/health" || true)
	[ "$code" = 200 ]
}

# 200 through the bootstrap catch-all. After setup the worker's config routes only the dashboard
# host, so a bare 127.0.0.1 gets 404 or a redirect; the api's own healthcheck already gated n/n.
ingress_ready() {
	local code
	have curl || { http_get "http://127.0.0.1/api/health" >/dev/null 2>&1; return; }
	code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1/api/health" || true)
	[[ $code =~ ^(200|30[78]|404)$ ]]
}

wait_healthy() {
	[ "$DRY_RUN" = 0 ] || { plan "wait up to ${WAIT_TIMEOUT}s for every service and $PUBLIC_URL/api/health"; return 0; }
	local deadline=$((SECONDS + WAIT_TIMEOUT)) next_note=$((SECONDS + 15))
	local -A ready=()
	local name replicas pending=()
	while :; do
		pending=()
		# A worker from before the label fix pushes its DB copy (pending) back until it is replaced.
		if [ "$NO_INGRESS" = 0 ] && [ -z "$(nodes_labelled true)" ]; then
			for name in $(nodes_labelled pending); do label_node logistack.ingress=true "$name" >/dev/null 2>&1 || true; done
		fi
		while read -r name replicas; do
			name=${name#"${STACK_NAME}_"}
			# Global with no node labelled logistack.ingress=true: 0/0 is the intended state.
			if [ "$NO_INGRESS" = 1 ] && [ "$name" = caddy ]; then continue; fi
			if [[ $replicas =~ ^([0-9]+)/([0-9]+) ]] && [ "${BASH_REMATCH[2]}" -gt 0 ] &&
				[ "${BASH_REMATCH[1]}" = "${BASH_REMATCH[2]}" ]; then
				[ -n "${ready[$name]:-}" ] || ok "$name $replicas"
				ready[$name]=1
			else
				pending+=("$name")
			fi
		done < <(docker stack services "$STACK_NAME" --format '{{.Name}} {{.Replicas}}' | sort)
		if [ ${#pending[@]} -eq 0 ] && { ! tunnel_wanted || tunnel_ready; } && { [ "$NO_INGRESS" = 1 ] || ingress_ready; }; then
			if tunnel_wanted; then ok "API healthy through the tunnel on 127.0.0.1:$TUNNEL_PORT"; else ok "API healthy through Caddy"; fi
			[ "$NO_INGRESS" = 1 ] || ok "Caddy answering on port 80"
			return 0
		fi
		if [ "$SECONDS" -ge "$deadline" ]; then
			[ ${#pending[@]} -gt 0 ] || pending=("logistack-api (/api/health)")
			printf '  %s✗%s Not ready after %ss: %s\n' "$RED" "$RESET" "$WAIT_TIMEOUT" "${pending[*]}" >&2
			for name in "${pending[@]}"; do
				local error
				error=$(grep -m1 . <<<"$(docker service ps "${STACK_NAME}_${name%% *}" --no-trunc --format '{{.Error}}' 2>/dev/null)" || true)
				[ -z "$error" ] || note "$name: $error"
			done
			fail "Inspect with: docker stack ps $STACK_NAME   (re-running the installer is safe)"
		fi
		if [ "$SECONDS" -ge "$next_note" ]; then
			note "waiting for ${pending[*]:-api health}"
			next_note=$((SECONDS + 15))
		fi
		sleep 3
	done
}

main() {
	parse_args "$@"
	[ "$LOCAL_BUILD" = 0 ] || checkout_root >/dev/null
	resolve_version
	printf '%sLogiStack installer%s %s%s%s\n' "$BOLD" "$RESET" "$DIM" "$VERSION$([ "$DRY_RUN" = 1 ] && printf ' (dry run, nothing will change)')" "$RESET"

	step "Checking this server"
	check_root
	check_os
	check_arch
	check_resources
	check_docker
	detect_migration_source
	detect_ingress_mode
	check_ports
	check_networks
	detect_addresses
	confirm

	# The log holds swarm join tokens, so only root may read it.
	[ "$DRY_RUN" = 1 ] || (umask 077 && : >>"$LOG_FILE" && chmod 0600 "$LOG_FILE")

	step "Docker"
	ensure_docker
	ensure_rootless_buildkit
	step "Swarm"
	ensure_swarm
	ensure_coolify_bridge
	step "Secrets"
	ensure_secrets
	ensure_dokploy_secret
	ensure_coolify_secrets
	step "Configuration"
	act "Write $CONF_DIR/stack.yml and version $VERSION$([ "$DOKPLOY" = 0 ] || printf ', migration_source=dokploy')$([ "$COOLIFY" = 0 ] || printf ', migration_source=coolify')" write_config
	firewall_advice
	if [ "$LOCAL_BUILD" = 1 ]; then
		step "Building images from the checkout"
		build_images
	fi
	step "Deploying"
	deploy
	ensure_tunnel
	wait_healthy
	remove_tunnel
	[ ! -d /etc/update-motd.d ] || act "Write the login banner $MOTD_FILE" write_motd

	if [ "$DRY_RUN" = 1 ]; then
		printf '\n%sDry run complete.%s Re-run without --dry-run to install.\n' "$BOLD" "$RESET"
		return
	fi
	printf '\n%sLogiStack %s is running.%s\n' "$BOLD" "$VERSION" "$RESET"
	if [ "$PUBLIC_SETUP" = 1 ]; then
		local token
		token=$(credential_get LOGISTACK_SETUP_TOKEN)
		printf '  Open %s%s/setup#token=%s%s to finish the guided setup in your browser.\n' "$BOLD" "$PUBLIC_URL" "$token" "$RESET"
		printf '  Setup token: %s%s%s\n' "$BOLD" "${token:-(missing from $CREDENTIALS_FILE)}" "$RESET"
		note "Until setup is done, anyone holding this token can claim the server; it stops working after."
	else
		printf '  Until setup is done the dashboard is reachable only on 127.0.0.1:%s. From your machine: %sssh -L %s:127.0.0.1:%s root@%s%s\n' "$TUNNEL_PORT" "$BOLD" "$TUNNEL_PORT" "$TUNNEL_PORT" "$PUBLIC_IP" "$RESET"
		printf '  then open %shttp://localhost:%s%s to finish the guided setup.\n' "$BOLD" "$TUNNEL_PORT" "$RESET"
		if [ "$NO_INGRESS" = 1 ]; then
			if [ "$DOKPLOY" = 1 ]; then
				note "Dokploy keeps serving your sites until the migration wizard moves each one over."
			elif [ "$COOLIFY" = 1 ]; then
				note "Coolify keeps serving your sites until the migration wizard moves each one over."
			else
				note "Ingress is off. When 80/443 are free, run: install.sh --enable-ingress"
			fi
		else
			note "After setup the dashboard is served over https on the domain you choose there."
		fi
	fi
	note "Back up $CREDENTIALS_FILE: it holds the master key that encrypts your secrets."
}

main "$@"

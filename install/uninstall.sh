#!/usr/bin/env bash
# Removes the LogiStack stack. Data volumes, secrets and /etc/logistack stay
# unless --purge is given, so a later install.sh picks up where it left off.
set -euo pipefail

STACK_NAME="logistack"
CONF_DIR="/etc/logistack"
SECRETS=(logistack-master-key logistack-postgres-password logistack-better-auth-secret logistack-redis-password logistack-agent-token logistack-setup-token)
VOLUMES=("${STACK_NAME}_pgdata" "${STACK_NAME}_redisdata" "${STACK_NAME}_workerdata" "${STACK_NAME}_agentdata" ls-buildkit-cache)

PURGE=0
ASSUME_YES=0

if [ -t 1 ]; then
	BOLD=$'\033[1m' DIM=$'\033[2m' GREEN=$'\033[32m' RED=$'\033[31m' RESET=$'\033[0m'
else
	BOLD="" DIM="" GREEN="" RED="" RESET=""
fi
ok() { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
note() { printf '    %s%s%s\n' "$DIM" "$*" "$RESET"; }
fail() {
	printf '  %s✗%s %s\n' "$RED" "$RESET" "$*" >&2
	exit 1
}

while [ $# -gt 0 ]; do
	case "$1" in
	--purge) PURGE=1 ;;
	--yes | -y) ASSUME_YES=1 ;;
	--help | -h)
		printf 'Usage: uninstall.sh [--purge] [--yes]\n  --purge  also delete the database, Redis data, secrets and %s\n' "$CONF_DIR"
		exit 0
		;;
	*) fail "Unknown option: $1" ;;
	esac
	shift
done

[ "$(id -u)" -eq 0 ] || fail "Run as root, for example: sudo bash uninstall.sh"
docker info >/dev/null 2>&1 || fail "Docker is not reachable"

if [ "$PURGE" = 1 ] && [ "$ASSUME_YES" = 0 ]; then
	{ : </dev/tty; } 2>/dev/null || fail "No terminal to confirm on; pass --yes to purge"
	printf '\n%sThis permanently deletes the LogiStack database, Redis data, secrets and %s.%s\n' "$BOLD" "$CONF_DIR" "$RESET" >/dev/tty
	printf '  Type "purge" to continue: ' >/dev/tty
	read -r answer </dev/tty
	[ "$answer" = purge ] || fail "Aborted, nothing changed"
fi

printf '%sRemoving LogiStack%s\n' "$BOLD" "$RESET"

if [ -n "$(docker stack ls --format '{{.Name}}' | grep -x "$STACK_NAME" || true)" ]; then
	docker stack rm "$STACK_NAME" >/dev/null
	for _ in $(seq 1 60); do
		[ -z "$(docker ps -aq --filter "label=com.docker.stack.namespace=$STACK_NAME")" ] && break
		sleep 2
	done
	ok "Stack $STACK_NAME removed"
else
	ok "Stack $STACK_NAME is not deployed"
fi
# The worker creates the BuildKit services itself (the instance's and one per organization), so the stack removal leaves them.
for svc in $(docker service ls -q --filter label=logistack.managed=true --filter label=logistack.resource=buildkit); do
	name=$(docker service inspect "$svc" --format '{{.Spec.Name}}')
	docker service rm "$svc" >/dev/null && ok "Service $name removed"
done
docker network rm ls-build >/dev/null 2>&1 && ok "Network ls-build removed"
# install.sh runs the loopback API tunnel as a plain container on ls-control.
if [ "$(docker inspect logistack-api-tunnel --format '{{index .Config.Labels "logistack.managed"}}' 2>/dev/null)" = true ]; then
	docker rm -f logistack-api-tunnel >/dev/null && ok "Container logistack-api-tunnel removed"
fi
# install.sh writes an SSH login banner pointing at the setup wizard.
if [ -f /etc/update-motd.d/99-logistack ]; then
	rm -f /etc/update-motd.d/99-logistack && ok "Login banner removed"
fi
for network in ls-control ls-ingress; do
	if docker network inspect "$network" >/dev/null 2>&1; then
		if docker network rm "$network" >/dev/null 2>&1; then
			ok "Network $network removed"
		else
			note "Network $network is still used by app services; remove them to free it"
		fi
	fi
done

if [ "$PURGE" = 0 ]; then
	note "Kept volumes, secrets and $CONF_DIR. Re-run install.sh to bring LogiStack back,"
	note "or uninstall.sh --purge to delete them."
	exit 0
fi

for volume in "${VOLUMES[@]}"; do
	if docker volume inspect "$volume" >/dev/null 2>&1; then
		docker volume rm "$volume" >/dev/null && ok "Volume $volume deleted"
	fi
done
# Each organization's BuildKit cache.
for volume in $(docker volume ls -q --filter label=logistack.managed=true --filter label=logistack.resource=buildkit); do
	docker volume rm "$volume" >/dev/null && ok "Volume $volume deleted"
done
for secret in "${SECRETS[@]}"; do
	if docker secret inspect "$secret" >/dev/null 2>&1; then
		docker secret rm "$secret" >/dev/null && ok "Secret $secret deleted"
	fi
done
if [ "$(docker info --format '{{.Swarm.LocalNodeState}}')" = active ]; then
	docker node update --label-rm logistack.ingress --label-rm logistack.data \
		"$(docker info --format '{{.Swarm.NodeID}}')" >/dev/null 2>&1 || true
	ok "Node labels removed"
fi
rm -rf "$CONF_DIR"
ok "$CONF_DIR deleted"
note "Volumes live on the node that ran them; on other nodes remove them by hand."
note "Docker and Swarm stay installed. Leave the swarm with: docker swarm leave --force"

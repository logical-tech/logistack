#!/bin/sh
# Entrypoint of the logistack images. Dispatches on ROLE=api|worker|dbgateway|egressproxy.
set -eu

# Docker secrets arrive as files (FOO_FILE=/run/secrets/...); the apps read plain FOO.
for name in LOGISTACK_MASTER_KEY BETTER_AUTH_SECRET POSTGRES_PASSWORD REDIS_PASSWORD LOGISTACK_AGENT_TOKEN; do
	eval "file=\${${name}_FILE:-}"
	if [ -n "$file" ]; then
		value=$(cat "$file")
		export "$name=$value"
	fi
done

# Generated passwords are hex, so they are safe inside a URL without encoding.
if [ -z "${DATABASE_URL:-}" ] && [ -n "${POSTGRES_PASSWORD:-}" ]; then
	export DATABASE_URL="postgres://${POSTGRES_USER:-logistack}:${POSTGRES_PASSWORD}@${POSTGRES_HOST:-postgres}:5432/${POSTGRES_DB:-logistack}"
fi
if [ -z "${REDIS_URL:-}" ] && [ -n "${REDIS_PASSWORD:-}" ]; then
	export REDIS_URL="redis://:${REDIS_PASSWORD}@${REDIS_HOST:-redis}:6379"
fi

# One-off commands with the service's environment, e.g. `docker exec <api> /app/install/entrypoint.sh bun apps/server/scripts/import-dokploy.ts ...`.
[ "$#" -eq 0 ] || exec "$@"

case "${ROLE:-}" in
api)
	bun install/migrate.ts
	exec bun apps/server/src/index.ts
	;;
worker)
	socket=${DOCKER_SOCKET:-/var/run/docker.sock}
	if [ "$(id -u)" = 0 ] && [ -S "$socket" ]; then
		# Drop root, keeping only the socket's group: its id differs per host.
		exec env HOME=/home/bun setpriv --reuid=bun --regid=bun --groups="$(stat -c %g "$socket")" --inh-caps=-all \
			bun apps/worker/src/index.ts
	fi
	exec bun apps/worker/src/index.ts
	;;
dbgateway)
	# A database's public port or port forward: no secrets, no socket, nothing to drop.
	exec bun apps/worker/src/db-gateway.ts
	;;
egressproxy)
	# The plugins' only route out: declared hosts only, no socket, no secrets but its HMAC key.
	exec bun apps/worker/src/egress-proxy.ts
	;;
*)
	echo "logistack: ROLE must be 'api', 'worker', 'dbgateway' or 'egressproxy' (got '${ROLE:-}')" >&2
	exit 64
	;;
esac

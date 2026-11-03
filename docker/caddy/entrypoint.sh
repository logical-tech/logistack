#!/bin/sh
# Boots Caddy with the admin API bound to this task's ls-control address only,
# Redis certificate storage, and a catch-all route to the api. The worker later
# pushes the full config per task (compileProxy with adminListen = this task's
# ls-control IP, storage key_prefix "caddy"); until then the api catch-all serves.
set -eu

prefix=${LS_CONTROL_SUBNET_PREFIX:?LS_CONTROL_SUBNET_PREFIX is required}
admin_ip=$(ip -4 -o addr show | awk '{ sub("/.*", "", $4); print $4 }' | grep -m1 "^${prefix}" || true)
if [ -z "$admin_ip" ]; then
	echo "logistack-caddy: no address starting with ${prefix}; is the task attached to ls-control?" >&2
	exit 1
fi
redis_password=$(cat "${REDIS_PASSWORD_FILE:?REDIS_PASSWORD_FILE is required}")

umask 077
cat >/tmp/bootstrap.json <<JSON
{
  "admin": { "listen": "${admin_ip}:2019" },
  "storage": {
    "module": "redis",
    "address": ["${REDIS_HOST:-redis}:6379"],
    "password": "${redis_password}",
    "db": 0,
    "key_prefix": "caddy",
    "tls_enabled": false
  },
  "apps": {
    "http": {
      "servers": {
        "bootstrap": {
          "listen": [":80"],
          "routes": [
            { "handle": [{ "handler": "reverse_proxy", "upstreams": [{ "dial": "${LOGISTACK_API_UPSTREAM:-logistack-api:3000}" }] }] }
          ]
        }
      }
    }
  }
}
JSON

exec caddy run --config /tmp/bootstrap.json

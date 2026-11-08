---
title: "What is Caddy? A practical guide to the Caddy reverse proxy"
description: "What is Caddy and how do you use it as a reverse proxy? Install it, write a Caddyfile, get automatic HTTPS and drive it through the admin API."
date: 2026-11-08
category: Networking
keywords: what is caddy, caddy reverse proxy, caddyfile, caddy automatic https, caddy docker
---

You want an app on `app.example.com` with a valid certificate, and you do not want to spend the evening wiring Certbot, cron and a web server config together. That is the problem Caddy solves. So what is Caddy? It is an open-source web server and reverse proxy, written in Go and licensed under Apache 2.0, that gets and renews TLS certificates for every site you give it, with no extra configuration.

This guide is practical. You install Caddy, put an app behind it, add a wildcard certificate, run it in Docker, and drive it through its API. Along the way you see where it fits and where it does not.

## What Caddy does

Caddy is a single static binary. Out of the box it can:

- Serve static files and act as a reverse proxy, with load balancing, health checks and retries.
- Obtain certificates from Let's Encrypt or ZeroSSL over ACME, renew them before they expire, and redirect HTTP to HTTPS.
- Speak HTTP/1.1, HTTP/2 and HTTP/3.
- Accept configuration as a short Caddyfile or as JSON, and change it at runtime through an admin API.
- Load extra functionality (DNS providers, storage backends, auth handlers) as modules compiled into the binary.

The feature people notice first is automatic HTTPS. Any site block with a public hostname gets a certificate with no `tls` line at all.

## Install Caddy

On Debian or Ubuntu, use the official package repository so you get updates through `apt`:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

The package installs a systemd unit that reads `/etc/caddy/Caddyfile`. Check it runs:

```bash
systemctl status caddy
caddy version
```

Before you continue, make sure the hostname you want to serve points at the server, and that ports 80 and 443 are open in your provider's firewall. Let's Encrypt validates over port 80 by default.

## Use Caddy as a reverse proxy

Say your app listens on port 3000 on the same machine. Replace the contents of `/etc/caddy/Caddyfile` with this:

```caddyfile
app.example.com {
	reverse_proxy localhost:3000
}
```

Then reload:

```bash
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

That is the whole setup. On the first request Caddy asks Let's Encrypt for a certificate, answers the challenge itself, and serves `https://app.example.com`. Requests on port 80 are redirected to HTTPS. Caddy passes `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` upstream and handles WebSocket upgrades without extra directives.

### Several apps on one server

Each hostname gets its own block:

```caddyfile
app.example.com {
	reverse_proxy localhost:3000
}

api.example.com {
	reverse_proxy localhost:8080
}

www.example.com {
	redir https://example.com{uri} permanent
}

example.com {
	root * /var/www/site
	file_server
}
```

### Route by path

Matchers send part of a site to a different upstream. `handle_path` strips the prefix before forwarding:

```caddyfile
example.com {
	handle_path /api/* {
		reverse_proxy localhost:8080
	}
	handle {
		reverse_proxy localhost:3000
	}
}
```

### Load balancing and health checks

Give `reverse_proxy` several upstreams and a health check:

```caddyfile
app.example.com {
	reverse_proxy 10.0.0.11:3000 10.0.0.12:3000 {
		lb_policy round_robin
		health_uri /healthz
		health_interval 10s
	}
}
```

### Basic auth

Generate a hash, then protect a site:

```bash
caddy hash-password --plaintext 'a-long-passphrase'
```

```caddyfile
admin.example.com {
	basic_auth {
		ops $2a$14$REPLACE_WITH_THE_HASH
	}
	reverse_proxy localhost:9000
}
```

## How Caddy's automatic HTTPS works

When Caddy loads a site with a qualifying hostname, it:

1. Checks its storage for a valid certificate for that name.
2. If none exists, creates an ACME account and orders one, solving the HTTP-01 or TLS-ALPN-01 challenge on its own listeners.
3. Stores the certificate and key, serves it, and schedules renewal well before expiry.

Storage defaults to a data directory on disk (`/var/lib/caddy/.local/share/caddy` for the packaged service). Keep that directory. If you lose it, Caddy orders new certificates on restart, and repeated loss can run into Let's Encrypt's limits. Our article on [Let's Encrypt rate limits](/blog/lets-encrypt-rate-limits/) explains which ones bite in practice.

For local names such as `app.localhost` or private IPs, Caddy issues certificates from its own internal CA instead of a public one. Run `caddy trust` to add that root to your machine's trust store during development.

## Wildcard certificates with a DNS challenge

Let's Encrypt issues wildcard certificates only over the DNS-01 challenge, which proves control by writing a TXT record. Caddy needs a DNS provider module for that, so build a custom binary with `xcaddy`:

```bash
go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest
xcaddy build --with github.com/caddy-dns/cloudflare
sudo mv caddy /usr/bin/caddy
```

Then reference the provider in a `tls` block, reading the token from the environment:

```caddyfile
*.example.com {
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}

	@app host app.example.com
	handle @app {
		reverse_proxy localhost:3000
	}

	@grafana host grafana.example.com
	handle @grafana {
		reverse_proxy localhost:3001
	}

	handle {
		abort
	}
}
```

One certificate now covers every subdomain. Adding a tenth app issues nothing new. Set `CF_API_TOKEN` in the systemd unit's environment, never in the Caddyfile itself.

## Run Caddy in Docker

The official image works well alongside Docker Compose. Persist `/data`, which holds certificates, and `/config`:

```yaml
services:
  caddy:
    image: caddy:2.11
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

  app:
    image: ghcr.io/acme/app:1.4.2
    expose:
      - "3000"

volumes:
  caddy_data:
  caddy_config:
```

Inside the compose network, point the Caddyfile at the service name:

```caddyfile
app.example.com {
	reverse_proxy app:3000
}
```

Publish `443/udp` too, or HTTP/3 will not reach Caddy. After editing the Caddyfile, reload without restarting the container:

```bash
docker compose exec -w /etc/caddy caddy caddy reload
```

## The admin API and JSON config

The Caddyfile is an adapter. Caddy converts it to JSON, which is its native configuration. You can see the result:

```bash
caddy adapt --config /etc/caddy/Caddyfile --pretty
```

A running Caddy exposes an admin API on `localhost:2019` by default. With it, a program can read and replace the whole config without touching files:

```bash
# Read the running config
curl -s localhost:2019/config/ | jq .

# Replace it with a new one
curl -s -X POST localhost:2019/load \
  -H "Content-Type: application/json" \
  -d @caddy.json
```

If the new config fails to load, Caddy returns an error and keeps serving the previous one. That property makes Caddy a good target for tools that generate proxy config, rather than humans who edit it.

Keep the admin API private. It has no authentication of its own, and `GET /config/` returns everything in the config, including DNS tokens.

## Useful commands

| Command | What it does |
| --- | --- |
| `caddy run` | Run in the foreground with the Caddyfile in the current directory |
| `caddy reload` | Apply a changed config without downtime |
| `caddy fmt --overwrite` | Normalize Caddyfile formatting |
| `caddy validate` | Check a config without starting the server |
| `caddy adapt --pretty` | Print the JSON a Caddyfile produces |
| `caddy list-modules` | Show the modules compiled into this binary |
| `caddy hash-password` | Produce a hash for `basic_auth` |
| `caddy trust` | Install the internal CA root locally |

## Where Caddy is not the best fit

Caddy is a good default, not the answer to everything.

- **Route discovery from containers.** Caddy has no built-in Docker or Kubernetes provider. If you want routes to come from container labels, Traefik does that natively. See [Caddy vs Traefik vs Nginx](/blog/caddy-vs-traefik-vs-nginx/).
- **Maximum efficiency at very high request rates.** Nginx usually uses less memory per connection.
- **Plugins without rebuilding.** Caddy modules are compiled in. That is predictable, but you maintain a custom build when you need one.

## How LogiStack uses Caddy

LogiStack, an open-source self-hosted PaaS, runs Caddy as the only thing listening on ports 80 and 443 of its ingress nodes. You never write a Caddyfile. You add a [domain](/docs/networking/domains/) in the dashboard, and the worker compiles every active domain into one JSON config and pushes it to each Caddy instance through the admin API. The admin API listens only on an internal network that apps cannot join.

A few details that build on what you read above:

- Certificates are stored in Redis, so every Caddy instance serves the same certificate and only one requests it.
- The Caddy image includes DNS modules for Cloudflare, Route 53, Hetzner DNS, DigitalOcean, OVHcloud and Porkbun, so [wildcard certificates](/docs/networking/wildcard-dns/) over DNS-01 work from a wizard.
- You can switch the certificate authority to Let's Encrypt staging, ZeroSSL or Caddy's internal CA from **Settings**. See [HTTPS certificates](/docs/networking/https-certificates/).

![LogiStack's Certificates settings page listing automatically issued and uploaded certificates with issuer and expiry](/docs/screens/settings-certificates.webp)

## FAQ

### Is Caddy free for commercial use?

Yes. Caddy is open source under the Apache 2.0 license, and every feature described here is in the free binary. Companies can buy support from the maintainers, but there is no paid edition of the server.

### Is Caddy a web server or a reverse proxy?

Both. It serves static files with `file_server` and forwards requests with `reverse_proxy`, often in the same site block. Most self-hosters use it mainly as a reverse proxy with automatic HTTPS.

### Where does Caddy store certificates?

In its data directory by default: `/data` in the Docker image, or under the `caddy` user's home for the system package. Storage modules can move them to Redis, Postgres, S3 and others, which lets several instances share one set.

### Does Caddy support HTTP/3?

Yes, HTTP/3 is on by default for HTTPS sites. It runs over UDP on port 443, so open `443/udp` in your firewall and publish it in Docker.

### How do I see Caddy's logs?

With the system package, run `journalctl -u caddy -f`. In Docker, run `docker compose logs -f caddy`. Add a `log` directive to a site block to get JSON access logs for that site.

If you like what Caddy does but would rather not maintain its config, certificates and DNS modules yourself, LogiStack runs it for you on your own server. [Install LogiStack](/#install) with one command and add your first domain from the dashboard.

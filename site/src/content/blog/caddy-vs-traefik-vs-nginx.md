---
title: "Caddy vs Traefik vs Nginx: which reverse proxy to run"
description: "Caddy vs Traefik vs Nginx compared on HTTPS, configuration, containers and scale, with clear advice on which reverse proxy fits your setup."
date: 2026-11-08
category: Networking
keywords: caddy vs traefik vs nginx, reverse proxy comparison, caddy vs nginx, traefik vs caddy, best reverse proxy for docker
---

You have a few apps in containers and one public IP. Something has to sit on ports 80 and 443, terminate TLS, and send each hostname to the right container. The three names that come up every time are Caddy, Traefik and Nginx. All three are mature, free and fast enough for almost any self-hosted workload, so the choice of Caddy vs Traefik vs Nginx comes down to how you want to configure the proxy, where certificates live, and who or what writes the routes.

This guide compares them on the questions that matter in practice. It also explains why LogiStack, the self-hosted PaaS we build, runs Caddy, and where the other two are the better pick.

## The short answer

- **Caddy** if you want HTTPS by default with the least configuration, or you generate the proxy config from another program through an API.
- **Traefik** if your routes should follow your containers automatically through Docker labels or Kubernetes resources.
- **Nginx** if you need the widest ecosystem, the most documentation, fine-grained control over every buffer and timeout, or you already run it everywhere.

The rest of this article explains the reasoning, so you can check it against your own constraints.

## Caddy vs Traefik vs Nginx at a glance

| | Caddy | Traefik | Nginx |
| --- | --- | --- | --- |
| Language | Go | Go | C |
| License | Apache 2.0 | MIT | BSD 2-clause |
| Commercial edition | No paid edition of the server | Traefik Enterprise and Traefik Hub | NGINX Plus (F5) |
| Automatic HTTPS | On by default for every site with a hostname | Built in, opt-in per router through a certificate resolver | Through Certbot or the newer ACME module |
| Main config formats | Caddyfile, JSON | YAML or TOML static config, plus labels, CRDs or files for routes | `nginx.conf` directives |
| Live config changes | Admin API (`/load`, `/config/`) | Watches providers and applies changes | `nginx -s reload` |
| Route discovery from Docker | Not built in (community plugin) | Built in | Not built in (templating tools) |
| Extending it | Compile modules in with `xcaddy` | Middlewares, plugins | Modules, Lua through OpenResty, njs |
| Typical home | Single servers, platforms that drive it by API | Docker and Kubernetes clusters | Everywhere, from static hosting to CDNs |

## How each one gets certificates

HTTPS is the reason most people look beyond a plain Nginx install, so start there.

### Caddy

Caddy turns HTTPS on for any site block with a hostname. It gets a certificate from Let's Encrypt (ZeroSSL can serve as a second issuer), redirects HTTP to HTTPS and renews in the background. You do not write a TLS block unless you want something different, such as a DNS challenge for a wildcard.

```caddyfile
app.example.com {
	reverse_proxy app:3000
}
```

That file is a complete, production-ready HTTPS reverse proxy. Certificates live in a storage backend that defaults to the local filesystem, and modules exist for Redis, Postgres, S3 and others, so several Caddy instances can share one set of certificates and one ACME lock.

### Traefik

Traefik also speaks ACME natively. You declare a certificate resolver once in the static configuration, then reference it from each router. It supports HTTP-01, TLS-ALPN-01 and DNS-01 with a long list of DNS providers.

```yaml
# traefik.yml (static configuration)
entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"
certificatesResolvers:
  le:
    acme:
      email: ops@example.com
      storage: /letsencrypt/acme.json
      httpChallenge:
        entryPoint: web
```

The open-source edition stores certificates in a local `acme.json` file. That is fine on one node. If you run several Traefik instances behind a load balancer, each one manages its own certificates unless you move to the commercial edition or put certificate management somewhere else.

### Nginx

Classic Nginx has no ACME client. Most setups pair it with Certbot, which edits or reads the server blocks, solves the challenge and installs a renewal timer.

```bash
sudo apt install nginx certbot python3-certbot-nginx
sudo certbot --nginx -d app.example.com
```

Recent Nginx releases add an official ACME module, which closes part of the gap. Even so, most guides and existing installs still use Certbot, and you remain responsible for the redirect, the renewal hook and the reload. None of this is hard. It is just more pieces to keep working.

## Configuration style

The bigger difference between the three is who writes the configuration.

**Nginx is written by a human.** You edit files, run `nginx -t`, then reload. The configuration language is precise and old enough that every problem has an answer somewhere. It is also easy to get subtly wrong: `proxy_pass` with or without a trailing slash, missing `Upgrade` headers for WebSockets, forgotten `X-Forwarded-Proto`.

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name app.example.com;

    ssl_certificate     /etc/letsencrypt/live/app.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/app.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

**Traefik is written by your containers.** The proxy watches Docker, Swarm or Kubernetes and builds routes from labels or resources attached to each workload. Deploy a container with the right labels and it gets a route. Remove it and the route disappears. The trade-off is that routing rules are scattered across every compose file, and a typo in a label fails quietly.

**Caddy is written by either.** A human writes a short Caddyfile. A program writes JSON and pushes it to the admin API on `localhost:2019`. The Caddyfile is converted to the same JSON internally, so both paths reach the same engine. If the new config is invalid, Caddy rejects it and keeps serving the old one.

## Containers and service discovery

If you run plain `docker compose` on one server and want each new service to appear on a hostname without touching the proxy, Traefik is built for that. Its Docker provider is first-class, and the Kubernetes integration (Ingress, Gateway API and its own CRDs) is widely used.

Caddy has no built-in Docker provider. The community `caddy-docker-proxy` plugin reads labels in a similar way, but it is a separate build. Nginx needs a generator such as docker-gen, or a wrapper project, to reach the same result.

That said, label-based discovery matters less once something else owns the routing table. A platform that knows every domain in its database can generate the proxy config directly, and then the proxy only needs a reliable way to accept it. That is the case where Caddy's admin API fits well.

## Performance and resource use

All three handle far more traffic than a typical self-hosted server will see. Published benchmarks vary with TLS settings, keep-alive, payload size and hardware, so treat any single number with care.

General patterns you can rely on:

- **Nginx** has the smallest memory footprint and the longest track record at very high request rates. It is the safe choice for serving large volumes of static files.
- **Caddy and Traefik** are Go programs with garbage collection. They use more memory per connection than Nginx but are rarely the bottleneck in front of an application server.
- **Reloads** differ. Nginx starts new workers and lets old ones finish. Caddy replaces its config in place. Traefik applies route changes without a restart.

When we measured Caddy for LogiStack, loading a full config of 5,000 routes through the admin API took about 120 ms per instance, and 20 rapid reloads under load dropped a handful of brand-new connections (0.23%) while keep-alive requests saw no failures. We batch config pushes into one reload per second to keep that number low. Your numbers will differ, but the scale is not a concern for one server or a small cluster.

## Extending the proxy

- **Nginx** has the largest module ecosystem, plus OpenResty for Lua and njs for JavaScript. Some modules require a rebuild; distribution packages cover the common ones.
- **Traefik** ships many middlewares (rate limiting, headers, basic auth, forward auth, retries, circuit breakers) and loads plugins at runtime.
- **Caddy** compiles modules into the binary with `xcaddy`. That means a custom build, but every module, including DNS providers for wildcard certificates, is a typed, versioned Go package.

```bash
xcaddy build v2.11.7 \
  --with github.com/caddy-dns/cloudflare \
  --with github.com/pberkel/caddy-storage-redis
```

## When each proxy is the better choice

### Choose Nginx when

- You already operate Nginx and have tooling, monitoring and people who know it.
- You serve a lot of static content or need detailed control over caching, buffering and timeouts.
- You want the configuration format with the most examples on the internet.

### Choose Traefik when

- You run Docker or Kubernetes and want routes to come from the workloads themselves.
- You want a built-in dashboard that shows routers, services and middlewares.
- Your team prefers declaring routing next to each service rather than in a central file.

For a deeper look at these two, read [Traefik vs Nginx](/blog/traefik-vs-nginx/).

### Choose Caddy when

- You want HTTPS to work on the first try with almost no config.
- Another program generates the routing table and needs a clean API to push it.
- You run several proxy instances and want them to share certificates through a storage backend.

Our [practical guide to Caddy](/blog/what-is-caddy/) covers installation, the Caddyfile and the admin API.

## Why LogiStack runs Caddy

LogiStack keeps desired state in Postgres and has a reconciler converge Docker Swarm and the proxy to it. Domains are rows in a database, not labels on containers. So the proxy does not need service discovery. It needs to accept a complete, generated configuration, reject bad input without dropping traffic, and handle certificates on its own.

Caddy fits that shape:

- The worker compiles every active domain into one JSON config and loads it through the admin API. If Caddy rejects it, the previous config keeps serving and the error appears on the domain. See [Architecture](/docs/reference/architecture/).
- Certificates are stored in Redis, so every Caddy instance on every ingress node serves the same certificate and only one of them asks Let's Encrypt for it.
- DNS provider modules are compiled in, so wildcard certificates over DNS-01 work with Cloudflare, Route 53, Hetzner DNS, DigitalOcean, OVHcloud and Porkbun. See [HTTPS certificates](/docs/networking/https-certificates/).
- You never edit the proxy by hand. You add a [domain](/docs/networking/domains/) in a wizard, and the route is live within a few seconds.

The honest trade-off: if you want to hand-tune proxy directives for one service, LogiStack does not expose raw Caddy config. It covers path prefixes, redirects, basic auth, IP allow lists and forward auth, and stops there.

## FAQ

### Is Caddy faster than Nginx?

Not in raw throughput or memory per connection, where Nginx usually leads. For an application server behind the proxy, the difference rarely shows up in response times. Pick on configuration and certificate handling first.

### Can Traefik replace Nginx?

For reverse proxying containers, yes, and many teams do exactly that. Nginx remains stronger as a static file server and for fine-grained caching. Some setups run both: Traefik in front, Nginx serving static assets behind it.

### Which reverse proxy is best for Docker Compose?

Traefik if you want labels on each service to define routes. Caddy if you prefer one short Caddyfile next to the compose file. Both handle HTTPS without extra containers, which Nginx needs Certbot for.

### Do I need a reverse proxy for a single app?

If the app should be on a hostname with HTTPS, yes. The proxy terminates TLS, renews certificates and lets you add a second app later without changing ports. It also keeps the app's own port off the public internet.

### Which one has the best Let's Encrypt support?

Caddy and Traefik both handle issuance and renewal natively. Caddy does it with no config at all and can share certificates across instances through its storage modules. Read [Let's Encrypt rate limits](/blog/lets-encrypt-rate-limits/) before you put many hostnames behind any of them.

If you would rather not choose, configure or maintain a proxy at all, LogiStack runs Caddy for you, issues certificates on its own and routes every service from a wizard. [Install it](/#install) on a server with one command, or browse the [features](/features/) first.

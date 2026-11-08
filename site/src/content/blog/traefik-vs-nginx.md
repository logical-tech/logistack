---
title: "Traefik vs Nginx: choosing a reverse proxy for containers"
description: "Traefik vs Nginx compared on configuration, HTTPS, Docker and Kubernetes, observability and performance, so you can pick the right reverse proxy."
date: 2026-11-08
category: Networking
keywords: traefik vs nginx, nginx vs traefik, reverse proxy for docker, kubernetes ingress controller, traefik docker labels
---

You are moving apps into containers and the old Nginx config on the host no longer fits. Containers come and go, ports change, and every new service means another server block and another Certbot run. Traefik promises routes that follow your containers on their own. Nginx promises the stability and control you already know. The Traefik vs Nginx question is really about where you want routing decisions to live and how much the proxy should do without you.

This article compares the two on the things you deal with day to day, then gives a plain recommendation for common setups.

## Two different design goals

**Nginx** started in 2004 as a fast, event-driven web server written in C. Reverse proxying, load balancing and caching came with it. Its configuration is a static file that a human writes and the server reloads. It is distributed under a BSD 2-clause license, and F5 sells a commercial edition, NGINX Plus, with an API for dynamic upstreams, active health checks and a live dashboard.

**Traefik** started in 2015 as a reverse proxy built for dynamic environments. It is written in Go and licensed under MIT. It watches a source of truth (Docker, Swarm, Kubernetes, Consul, a file) and rebuilds its routing table whenever that source changes. Traefik Labs offers commercial products on top, but the proxy itself is fully usable on its own.

So Nginx is a general-purpose server you configure. Traefik is an edge router that configures itself from your platform.

## Traefik vs Nginx at a glance

| | Traefik | Nginx |
| --- | --- | --- |
| Written in | Go | C |
| License | MIT | BSD 2-clause |
| Config source | Providers: Docker labels, Kubernetes resources, files, KV stores | `nginx.conf` and included files |
| Applying changes | Automatic when a provider changes | `nginx -t` then `nginx -s reload` |
| HTTPS | Built-in ACME (HTTP-01, TLS-ALPN-01, DNS-01) | Certbot, or the newer ACME module |
| Dashboard | Built in, read-only | Basic status page; full dashboard in NGINX Plus |
| Metrics and tracing | Prometheus, OpenTelemetry and others built in | `stub_status`; richer metrics through exporters or Plus |
| Static file serving | Not a goal | A core strength |
| Caching | Not built in (plugins exist) | Mature proxy cache |
| Kubernetes | Ingress, Gateway API, own CRDs | Several Ingress controllers built on Nginx |

## How configuration works

### Nginx: one file you own

With Nginx you describe every route in a file. A typical reverse proxy block for a container published on port 3000 looks like this:

```nginx
upstream shop {
    server 127.0.0.1:3000;
    keepalive 32;
}

server {
    listen 80;
    server_name shop.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name shop.example.com;

    ssl_certificate     /etc/letsencrypt/live/shop.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/shop.example.com/privkey.pem;

    location / {
        proxy_pass http://shop;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

The upside is that everything is in one place and nothing changes unless you change it. The downside is that the file knows nothing about your containers. If a container moves to another port, Nginx keeps sending traffic to the old one until you edit and reload.

### Traefik: routes declared next to the workload

Traefik reads routes from labels on the containers themselves. The same app in Docker Compose:

```yaml
services:
  traefik:
    image: traefik:v3.5
    command:
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --entrypoints.web.address=:80
      - --entrypoints.web.http.redirections.entrypoint.to=websecure
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.le.acme.email=ops@example.com
      - --certificatesresolvers.le.acme.storage=/letsencrypt/acme.json
      - --certificatesresolvers.le.acme.httpchallenge.entrypoint=web
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - letsencrypt:/letsencrypt

  shop:
    image: ghcr.io/acme/shop:2.3.0
    labels:
      - traefik.enable=true
      - traefik.http.routers.shop.rule=Host(`shop.example.com`)
      - traefik.http.routers.shop.entrypoints=websecure
      - traefik.http.routers.shop.tls.certresolver=le
      - traefik.http.services.shop.loadbalancer.server.port=3000

volumes:
  letsencrypt:
```

Start a new container with labels and it is routed within seconds. Scale it to three replicas and Traefik balances across them. Stop it and the route is gone.

Two things to keep in mind. First, Traefik needs access to the Docker API to watch containers, and the socket grants root-equivalent control of the host. Mount it read-only, consider a socket proxy that exposes only the read endpoints, and keep the Traefik container patched. Second, routing rules are now spread over many compose files. A misspelled label does not raise an error, the route just never appears.

## HTTPS and certificates

Traefik includes an ACME client. You define a certificate resolver once and attach it to routers. DNS-01 is available for a long list of providers, which lets you issue wildcard certificates. In the open-source edition, certificates are kept in a local `acme.json` file, so each Traefik instance manages its own unless you add the commercial edition or another layer.

Nginx traditionally relies on Certbot:

```bash
sudo certbot --nginx -d shop.example.com
sudo systemctl list-timers | grep certbot
```

Certbot edits your server block, installs the certificate and sets up a renewal timer that reloads Nginx. Newer Nginx versions also ship an official ACME module, which brings issuance into the server itself. Either way it works well. It is just a second tool in the chain.

Whichever proxy you pick, watch how many certificates you ask for. Our guide to [Let's Encrypt rate limits](/blog/lets-encrypt-rate-limits/) explains the per-domain budget and why wildcard certificates help.

## Docker, Swarm and Kubernetes

For plain Docker and Swarm, Traefik is the more natural fit. The Swarm provider reads labels from service definitions, so a [Docker Swarm](/blog/docker-swarm/) stack can carry its own routing.

In Kubernetes, both are common:

- **Traefik** acts as an Ingress controller, supports the Gateway API, and adds its own `IngressRoute` and `Middleware` resources. Several lightweight distributions install it by default.
- **Nginx** powers multiple Ingress controllers, both community and vendor-maintained. They translate Ingress resources and annotations into Nginx config. Check which one you are reading docs for, because their annotations differ.

If your team already standardized on one in Kubernetes, that is usually the right answer for the cluster.

## Middleware and features

Traefik's middlewares are composable building blocks you attach to a router: headers, redirects, path stripping, basic auth, forward auth, rate limiting, IP allow lists, retries, circuit breakers and compression. They are configured the same way as routes.

Nginx covers the same ground through directives (`limit_req`, `auth_basic`, `auth_request`, `allow`/`deny`, `gzip`) and goes further in a few areas:

- **Caching.** `proxy_cache` is mature and fine-grained.
- **Static files.** Nginx is one of the best static servers available.
- **Scripting.** njs (JavaScript) or OpenResty (Lua) for custom logic at the edge.
- **Protocols.** The `stream` module proxies raw TCP and UDP. Traefik supports TCP and UDP routers too.

## Performance

Both handle more traffic than most self-hosted servers will see. Nginx generally uses less memory per connection and leads in raw throughput, especially for static content and very high connection counts. Traefik's overhead is real but rarely the limit when it sits in front of an application server doing database queries.

Avoid choosing on a benchmark you did not run. TLS settings, keep-alive, HTTP version and payload size change results a lot. If performance matters, test both with your own traffic shape.

## Observability

Traefik exposes Prometheus metrics, OpenTelemetry traces and structured access logs with a few flags, and its dashboard shows every router, service and middleware it built. That is helpful when a route is missing: you can see what Traefik thinks the configuration is.

Open-source Nginx offers `stub_status` with a handful of counters and detailed access logs you can format as JSON. For per-upstream metrics, teams add an exporter or parse logs. NGINX Plus adds a full API and dashboard.

## Which one should you choose?

**Pick Nginx if:**

- You serve static sites or need a strong cache.
- Your routes rarely change and you prefer one explicit file.
- Your team already runs Nginx and has the tooling for it.

**Pick Traefik if:**

- You run many containers on Docker, Swarm or Kubernetes and routes change often.
- You want HTTPS and service discovery in one component.
- You value a built-in dashboard and metrics.

**Consider a third option.** Caddy sits between the two: automatic HTTPS like Traefik, a single readable config like Nginx, and an admin API for programs that generate config. Our [Caddy vs Traefik vs Nginx](/blog/caddy-vs-traefik-vs-nginx/) comparison covers it, and [What is Caddy](/blog/what-is-caddy/) shows how to use it.

## Where LogiStack fits

LogiStack is an open-source, self-hosted PaaS on Docker Swarm. It uses neither Traefik nor Nginx. It runs Caddy and generates the whole proxy config from its database, so you never write labels or server blocks. You add a [domain](/docs/networking/domains/) to a service in a wizard, pick HTTP-01 or DNS-01, and the route is live within seconds. Basic auth, IP allow lists and forward auth are set per domain in [access control](/docs/networking/access-control/).

If you are deciding on a proxy because you are building your own small platform, it may be worth checking whether you need to build it at all. The [features page](/features/) lists what LogiStack already handles.

## FAQ

### Is Traefik better than Nginx?

Neither is better in general. Traefik is better at following containers and managing certificates without extra tools. Nginx is better at static content, caching and raw efficiency, and it has the larger ecosystem.

### Can I use Traefik and Nginx together?

Yes. A common pattern puts Traefik at the edge for routing and TLS, and Nginx behind it inside a container to serve static assets or a PHP app. Just make sure only one of them terminates TLS and the other trusts the forwarded headers.

### Does Traefik need access to the Docker socket?

The Docker provider reads container labels through the Docker API, so it needs the socket or a proxy in front of it. Mount it read-only and prefer a socket proxy that allows only read requests. You can avoid it entirely by using the file provider.

### Is Nginx still a good choice for Docker?

Yes, especially for a handful of stable services. You will maintain the routes and certificate renewals yourself, or use a generator that watches Docker. For many frequently changing services, a proxy with built-in discovery saves work.

If you want routing, certificates and deployments handled for you on your own server, [install LogiStack](/#install) and add your first domain in a few minutes.

# LogiStack ingress: Caddy with DNS-01 providers, shared Redis certificate storage and per-domain
# rate limiting (mholt/caddy-ratelimit: stock Caddy has no rate limiter; pinned to a commit, it has no
# release newer than 2024).
# Bump CADDY_VERSION and the module versions together, then rebuild and check `caddy list-modules`.
ARG CADDY_VERSION=2.11.7

FROM caddy:${CADDY_VERSION}-builder-alpine AS builder
ARG CADDY_VERSION
RUN xcaddy build v${CADDY_VERSION} \
	--with github.com/caddy-dns/cloudflare@v0.2.4 \
	--with github.com/caddy-dns/route53@v1.6.2 \
	--with github.com/caddy-dns/hetzner/v2@v2.0.1 \
	--with github.com/caddy-dns/digitalocean@04bde2867106aa1b44c2f9da41a285fa02e629c5 \
	--with github.com/caddy-dns/ovh@v1.1.0 \
	--with github.com/caddy-dns/porkbun@v0.3.1 \
	--with github.com/pberkel/caddy-storage-redis@v1.9.0 \
	--with github.com/mholt/caddy-ratelimit@5625512f24f6f59d6f64fb3aafe5eecff0b286db

FROM caddy:${CADDY_VERSION}-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
# No --resume: a restarted task gets a new ls-control IP, so the entrypoint rebuilds the bootstrap
# (admin bound to that IP) and the worker re-syncs the real config when it sees the new task.
COPY --chmod=0755 entrypoint.sh /usr/local/bin/logistack-caddy
ENTRYPOINT ["/usr/local/bin/logistack-caddy"]
ARG LOGISTACK_VERSION=dev
ARG LOGISTACK_COMMIT=
ENV LOGISTACK_VERSION=$LOGISTACK_VERSION \
	LOGISTACK_COMMIT=$LOGISTACK_COMMIT

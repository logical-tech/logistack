# syntax=docker/dockerfile:1.7
# The marketing site: a static Next.js export served by Caddy on :80.
# Build from the repository root, because the page counts the template catalog at build time:
#   docker build -f site/Dockerfile -t logistack-site .

FROM oven/bun:1.4-slim AS build
WORKDIR /repo/site
COPY site/package.json site/bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY site/ ./
COPY packages/templates/catalog/ /repo/packages/templates/catalog/
ARG NEXT_PUBLIC_SITE_URL=https://stack.logicaltech.it
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL NEXT_TELEMETRY_DISABLED=1
RUN bunx --bun next build

FROM caddy:2.10-alpine
COPY site/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/site/out /srv
# The page tells visitors to pipe this into bash, so it ships with every build of the site.
COPY install/install.sh /srv/install.sh
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO /dev/null http://127.0.0.1/ || exit 1

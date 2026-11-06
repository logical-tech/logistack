# syntax=docker/dockerfile:1.7
# The docs: a static Next.js export served by Caddy on :80 under /docs.
# Build from the repository root, like the site:
#   docker build -f docs-site/Dockerfile -t logistack-docs .

FROM oven/bun:1.4-slim AS build
# fumadocs reads page dates from git and fails without the binary; with no .git in the context it just finds none.
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /repo/docs-site
COPY docs-site/package.json docs-site/bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY docs-site/ ./
ARG NEXT_PUBLIC_SITE_URL=https://stack.logicaltech.it
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL NEXT_TELEMETRY_DISABLED=1
RUN bunx --bun next build

FROM caddy:2.10-alpine
COPY docs-site/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/docs-site/out /srv
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO /dev/null http://127.0.0.1/docs/ || exit 1

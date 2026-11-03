# syntax=docker/dockerfile:1
# Per-node agent. Build from the repo root: docker build -f install/agent.Dockerfile .
ARG BUN_VERSION=1.4

FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun build --compile --minify apps/agent/src/index.ts --outfile /out/logistack-agent

FROM gcr.io/distroless/cc-debian12
COPY --from=build /out/logistack-agent /usr/local/bin/logistack-agent
# Runs as root: it talks to /var/run/docker.sock, whose group id differs per host.
ENTRYPOINT ["/usr/local/bin/logistack-agent"]
ARG LOGISTACK_VERSION=dev
ARG LOGISTACK_COMMIT=
ENV LOGISTACK_VERSION=$LOGISTACK_VERSION \
	LOGISTACK_COMMIT=$LOGISTACK_COMMIT

# syntax=docker/dockerfile:1
# LogiStack control plane images, from one build:
#   docker build --target api    -t ghcr.io/logical-tech/logistack:<v> .         ROLE=api: API + apps/web/dist
#   docker build --target worker -t ghcr.io/logical-tech/logistack-worker:<v> .  ROLE=worker: jobs, builds
ARG BUN_VERSION=1.4

FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app
# shortcut: copies the whole context before install, so any source change re-runs install; split out package.json files if builds get slow.
COPY . .
RUN bun install --frozen-lockfile
RUN cd apps/web && bunx --bun vite build
# Runtime keeps only server and worker dependencies; web is static files by now.
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules \
	&& bun install --frozen-lockfile --production --filter @logistack/server --filter @logistack/worker

# Build tools for the worker, pinned and checksum-verified. To bump: change the version, then
# replace each sha256 with `sha256sum` of the release asset (railpack also ships checksums.txt).
FROM alpine:3.22 AS tools
ARG TARGETARCH
ARG BUILDKIT_VERSION=v0.34.1
ARG BUILDKIT_SHA256_AMD64=a59539daf547fe0958efe2d07e41c0a6944e1112a66d7e519ec1cf5b673ef15b
ARG BUILDKIT_SHA256_ARM64=c8c97b84baf89dfe0ea85063ac24ad88eb909979ea476ce3ef9e8e11e60ebef8
ARG RAILPACK_VERSION=v0.43.0
ARG RAILPACK_SHA256_AMD64=248a8f60f36854aabed6124113631078a802de3461660855fc4de9c26065c1fb
ARG RAILPACK_SHA256_ARM64=732ece14eb4f4676a43ebba19431f954edf7b130acb76159ef0f2ff86ac42ac9
RUN set -eu; \
	case "$TARGETARCH" in \
	amd64) bk=$BUILDKIT_SHA256_AMD64 rp=$RAILPACK_SHA256_AMD64 rparch=x86_64 ;; \
	arm64) bk=$BUILDKIT_SHA256_ARM64 rp=$RAILPACK_SHA256_ARM64 rparch=arm64 ;; \
	*) echo "unsupported TARGETARCH '$TARGETARCH'" >&2; exit 1 ;; \
	esac; \
	wget -qO /tmp/buildkit.tgz "https://github.com/moby/buildkit/releases/download/${BUILDKIT_VERSION}/buildkit-${BUILDKIT_VERSION}.linux-${TARGETARCH}.tar.gz"; \
	echo "$bk  /tmp/buildkit.tgz" | sha256sum -c -; \
	wget -qO /tmp/railpack.tgz "https://github.com/railwayapp/railpack/releases/download/${RAILPACK_VERSION}/railpack-${RAILPACK_VERSION}-${rparch}-unknown-linux-musl.tar.gz"; \
	echo "$rp  /tmp/railpack.tgz" | sha256sum -c -; \
	mkdir -p /out; \
	tar -xzf /tmp/buildkit.tgz -C /out --strip-components=1 bin/buildctl; \
	tar -xzf /tmp/railpack.tgz -C /out railpack; \
	/out/buildctl --version; /out/railpack --version

FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
	PORT=3000
COPY --from=build /app /app
RUN chmod 0755 /app/install/entrypoint.sh
ENTRYPOINT ["/app/install/entrypoint.sh"]

# Not built on top of api, so the api's version ARGs never invalidate this apt layer.
FROM runtime AS worker
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git openssh-client ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& install -d -o bun -g bun /var/lib/logistack
COPY --from=tools /out/ /usr/local/bin/
# Starts as root only so the entrypoint can read the socket's group, then drops to bun with it:
# the docker group id differs per host and `docker stack deploy` has no group_add.
ENV ROLE=worker
# Healthy once the worker has booted and keeps beating (apps/worker/src/index.ts), so a rolling
# update only retires the old worker for one that came up.
# Plain sh + stat: booting a Bun runtime per probe cost more CPU than the worker at idle.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=2s --retries=3 \
	CMD ["sh", "-c", "test $(( $(date +%s) - $(stat -c %Y /tmp/logistack-worker.alive 2>/dev/null || echo 0) )) -lt 30"]
# Last, so a new version rebuilds metadata only. Read by GET /api/version and the updater.
ARG LOGISTACK_VERSION=dev
ARG LOGISTACK_COMMIT=
ENV LOGISTACK_VERSION=$LOGISTACK_VERSION \
	LOGISTACK_COMMIT=$LOGISTACK_COMMIT

FROM runtime AS api
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --start-interval=2s --retries=3 \
	CMD ["bun", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ARG LOGISTACK_VERSION=dev
ARG LOGISTACK_COMMIT=
ENV LOGISTACK_VERSION=$LOGISTACK_VERSION \
	LOGISTACK_COMMIT=$LOGISTACK_COMMIT

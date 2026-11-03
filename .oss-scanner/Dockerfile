# Image for Anthropic's OSS Scanner. Build from the repository root:
#   docker build -f .oss-scanner/Dockerfile -t logistack-scan .
# Everything is fetched here; the audit then runs with no network. Integration tests skip
# themselves when `docker info` fails, and packages/db tests when TEST_DATABASE_URL is unset.
ARG BUN_VERSION=1.4
FROM oven/bun:${BUN_VERSION}

RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile
RUN bun run typecheck

CMD ["bun", "test"]

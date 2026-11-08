# Built from the repository root: docker build -f examples/plugins/deploy-notifier/Dockerfile .
# `logistack-plugin build` adds the io.logistack.plugin.manifest label.
FROM oven/bun:1.4-alpine
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/contracts packages/contracts
COPY packages/plugin-sdk packages/plugin-sdk
COPY examples/plugins/deploy-notifier examples/plugins/deploy-notifier
RUN bun install --production --filter deploy-notifier
WORKDIR /app/examples/plugins/deploy-notifier
# LogiStack mounts a volume at /data; a new volume takes this directory's owner.
RUN mkdir /data && chown bun:bun /data
USER bun
ENV DATA_DIR=/data
CMD ["bun", "src/main.ts"]

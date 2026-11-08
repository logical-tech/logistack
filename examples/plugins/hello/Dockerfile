# Built from the repository root: docker build -f examples/plugins/hello/Dockerfile .
# `logistack-plugin build` adds the io.logistack.plugin.manifest label.
FROM oven/bun:1.4-alpine
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/contracts packages/contracts
COPY packages/plugin-sdk packages/plugin-sdk
COPY examples/plugins/hello examples/plugins/hello
RUN bun install --production --filter hello
WORKDIR /app/examples/plugins/hello
# LogiStack mounts a volume at /data; a new volume takes this directory's owner.
RUN mkdir /data && chown bun:bun /data
USER bun
ENV DATA_DIR=/data
CMD ["bun", "src/main.ts"]

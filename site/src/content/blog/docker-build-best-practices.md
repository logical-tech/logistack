---
title: "Docker build best practices: faster, smaller, safer images"
description: "Docker build best practices that pay off: layer caching, multi-stage builds, BuildKit cache mounts and secrets, small base images and reproducible tags."
date: 2026-11-08
category: Docker
keywords: docker build best practices, dockerfile best practices, docker layer caching, multi-stage builds, buildkit cache mount
---

A slow Docker build is rarely slow because of the work it does. It is slow because it redoes work it already did: reinstalling every dependency after a one-line code change, re-uploading a gigabyte of context, or shipping a compiler to production. Following a few Docker build best practices fixes most of that. This guide covers the ones with the biggest return, in the order they matter: caching, multi-stage builds, BuildKit features, image size and reproducibility.

## How the layer cache actually works

Each instruction in a Dockerfile produces a layer. Before running an instruction, the builder checks whether it has a cached layer for the same parent and the same input:

- For `RUN`, the input is the command string.
- For `COPY` and `ADD`, the input is the content of the copied files.
- For `ARG` and `ENV`, the value changes the cache key of everything after it.

The first instruction whose input changed is a cache miss, and **every instruction after it runs again**. That single rule drives most of what follows: put things that change rarely near the top, and things that change often near the bottom.

## 1. Copy the dependency manifest before the source

The most common mistake looks like this:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY . .
RUN npm ci
RUN npm run build
```

Any change to any file invalidates `COPY . .`, so `npm ci` runs on every build. Split the copy:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
```

Now dependencies install only when the manifest or the lockfile changes. The same pattern works everywhere:

| Ecosystem | Copy first | Then install |
|---|---|---|
| Node.js | `package.json`, lockfile | `npm ci`, `pnpm install --frozen-lockfile` |
| Python | `requirements.txt` or `pyproject.toml` and `uv.lock` | `pip install -r`, `uv sync --frozen` |
| Go | `go.mod`, `go.sum` | `go mod download` |
| Ruby | `Gemfile`, `Gemfile.lock` | `bundle install` |
| PHP | `composer.json`, `composer.lock` | `composer install --no-scripts` |
| Rust | `Cargo.toml`, `Cargo.lock` | a dummy `main.rs` build, or `cargo-chef` |

## 2. Write a .dockerignore

The build context is everything you send to the builder. Without a `.dockerignore`, that includes `node_modules`, `.git`, local `.env` files and build output. It slows the upload, and worse, a `COPY . .` then changes whenever any of those files change, breaking the cache for nothing.

```text
# .dockerignore
.git
**/node_modules
**/dist
**/.next
**/__pycache__
.env
.env.*
*.log
Dockerfile*
```

Excluding `.env` files also keeps local secrets out of the image by accident.

## 3. Use multi-stage builds

A multi-stage build uses one stage to compile and another, minimal stage to run. Only the files you explicitly copy cross the boundary:

```dockerfile
# syntax=docker/dockerfile:1
FROM golang:1.23 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api

FROM gcr.io/distroless/static-debian12 AS runtime
COPY --from=build /out/api /api
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/api"]
```

The build stage holds the Go toolchain and module cache, close to a gigabyte. The runtime image is the binary plus a few megabytes. Smaller images pull faster on every node, start faster when scaling, and carry fewer packages for a scanner to flag.

Multi-stage builds help in three more ways:

- **Parallel stages.** BuildKit builds independent stages at the same time, for example a frontend and a backend in one Dockerfile.
- **Test stages.** Add a `test` stage that runs your suite, and build it in CI with `--target test`. Production builds skip it.
- **Stage targets per environment.** A `dev` stage with hot reload and a `runtime` stage for production can share the dependency layers.

## 4. Use BuildKit cache mounts

The layer cache is all or nothing: if the lockfile changes by one package, the whole install runs from scratch. Cache mounts keep a package manager's download cache between builds, even when the layer itself is rebuilt:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
```

Common targets:

- npm: `/root/.npm`
- pnpm: `/root/.local/share/pnpm/store`
- pip: `/root/.cache/pip`
- uv: `/root/.cache/uv`
- Go: `/go/pkg/mod` and `/root/.cache/go-build`
- apt: `/var/cache/apt` and `/var/lib/apt` with `sharing=locked`

The cache mount never ends up in the image, so you do not need to clean it in the same `RUN`. It lives with the builder, so it helps on a persistent builder and does nothing on a fresh CI machine unless you keep the builder around.

## 5. Keep secrets out of layers

Never pass a token as `ARG` or `ENV`. Both are recorded in the image metadata and visible to anyone who can pull it. A secret that is copied into a layer and deleted in a later one is still in the earlier layer.

Use a BuildKit secret mount instead. The value is available to one `RUN` and never written to a layer:

```dockerfile
RUN --mount=type=secret,id=npm_token,env=NPM_TOKEN \
    pnpm install --frozen-lockfile
```

```bash
docker build --secret id=npm_token,env=NPM_TOKEN -t api .
```

For private Git dependencies, `RUN --mount=type=ssh` forwards your SSH agent for one step. The [container security best practices](/blog/container-security-best-practices/) checklist covers the rest of the image hardening.

## 6. Pick base images on purpose

- **Pin versions.** `node:22.11-alpine` instead of `node:latest`. For strict reproducibility, pin by digest (`node@sha256:...`) and let a bot such as Renovate update it.
- **Start small.** `-slim` Debian images are a safe default. Alpine is smaller but uses musl, which breaks some native modules and changes DNS behaviour. Distroless and `scratch` suit static binaries.
- **Match the runtime to the build.** Native modules compiled on Debian will not load on Alpine. Use the same family in both stages.
- **Rebuild regularly.** A pinned base image stops receiving security fixes. Rebuild weekly, even without code changes, so patched base layers reach production.

## 7. Run as a non-root user

Add a user, or use the one the base image provides (`node`, `nobody`, `65532` on distroless), and switch to it at the end:

```dockerfile
COPY --chown=node:node --from=build /app/dist ./dist
USER node
```

Use `COPY --chown` rather than a separate `RUN chown -R`, which duplicates every file into a new layer.

## 8. Make builds reproducible and traceable

- **Commit the lockfile** and install with the frozen flag (`npm ci`, `--frozen-lockfile`, `uv sync --frozen`).
- **Tag images immutably**, with the commit SHA or a deployment id, never with `latest` alone. A rollback must pull exactly the image that ran before. The [Docker image vs container](/blog/docker-image-vs-container/) post explains tags and digests.
- **Bake the revision in** with a build argument, so a running container can tell you what it is:

```dockerfile
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.revision=$GIT_SHA
ENV APP_REVISION=$GIT_SHA
```

Put this near the end of the Dockerfile: an `ARG` that changes on every commit invalidates the cache of everything after it.

## 9. Keep the cache across CI runs

A hosted CI runner starts empty, so local cache and cache mounts are gone on every run. Export the cache somewhere persistent:

```bash
docker buildx build \
  --cache-from type=registry,ref=ghcr.io/acme/api:buildcache \
  --cache-to type=registry,ref=ghcr.io/acme/api:buildcache,mode=max \
  -t ghcr.io/acme/api:$GIT_SHA --push .
```

`mode=max` also stores intermediate stages, which matters for multi-stage builds. On GitHub Actions, `type=gha` stores the cache in the Actions cache instead. A persistent builder, such as a [self-hosted runner](/blog/self-hosted-github-actions-runners/) or a build service on your own server, keeps the cache with no export at all.

## 10. Let the linter catch the rest

Recent BuildKit versions ship build checks that flag common Dockerfile problems, such as `ENV` keys that should be `ARG`, inconsistent casing, or a `JSON` form `CMD` written as a string. Run them without building:

```bash
docker build --check .
```

Hadolint is a long-standing alternative that also checks the shell inside `RUN` lines.

## A checklist to review your Dockerfile

| Practice | Speed | Size | Security |
|---|---|---|---|
| Manifest before source | Yes | | |
| `.dockerignore` | Yes | Yes | Yes |
| Multi-stage build | Yes | Yes | Yes |
| Cache mounts | Yes | | |
| Secret mounts, no secret `ARG` | | | Yes |
| Pinned, small base image | | Yes | Yes |
| Non-root user | | | Yes |
| Immutable tags, frozen lockfile | | | Yes |
| Persistent or exported cache | Yes | | |

## How LogiStack builds your Dockerfile

LogiStack builds Git services with a rootless BuildKit that runs as a service on your servers and keeps its cache in a Docker volume, so layer caching works between deployments without exporting anything. A few settings map directly to the practices above:

- **Target stage** builds a named stage of a multi-stage Dockerfile, such as `runtime`.
- **Build variables** marked as secret reach the build as BuildKit secrets, not build arguments, so they stay out of the image history. Mount them with `RUN --mount=type=secret,id=NAME`.
- **`LOGISTACK_COMMIT_SHA`** and the other deployment variables are passed as build arguments, available to any Dockerfile that declares them with `ARG`.
- **Immutable tags**: each image is tagged `<registry>/<org>/<service>:<deploymentId>`, never `latest`, so a rollback runs the exact image again without a rebuild.

The details and example Dockerfiles are in [build types](/docs/deploy/build-types/). When the build cache grows, a node's **Clean up** action removes unused images and build cache; see [nodes](/docs/operations/nodes/). For images that run on both amd64 and arm64 servers, read [multi-arch Docker images](/blog/multi-arch-docker-images/).

## FAQ

### Why does my Docker build reinstall dependencies every time?

You copy the full source before the install step, so any file change invalidates the install layer. Copy only the manifest and lockfile first, install, then copy the rest. Check that `.dockerignore` excludes `node_modules` and build output.

### Is Alpine always the best base image?

No. It is small, but musl libc breaks some native modules and prebuilt wheels. `-slim` Debian images are a safer default, and distroless suits static binaries.

### What is the difference between the layer cache and a cache mount?

The layer cache reuses a whole instruction's result when its inputs have not changed. A cache mount keeps a directory, like a package manager's download cache, between builds, so even a rebuilt layer runs faster.

### How do I pass a secret to docker build safely?

Use `docker build --secret` and `RUN --mount=type=secret` in the Dockerfile. Never use `ARG` or `ENV` for secrets, because both are saved in the image metadata.

### Do I need BuildKit?

You already use it: BuildKit has been the default builder in Docker Engine since version 23. Add `# syntax=docker/dockerfile:1` at the top to get the latest Dockerfile features.

A good Dockerfile is half of a fast deploy; a builder that keeps its cache is the other half. LogiStack builds your Dockerfile with BuildKit on your own servers, keeps the cache between deployments and tags every image immutably. It is open source and free. [Install it](/#install) and push a repository.

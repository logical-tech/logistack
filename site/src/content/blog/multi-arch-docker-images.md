---
title: "Multi-arch Docker images: build for arm64 and amd64"
description: "Build multi-arch Docker images for arm64 and amd64 with docker buildx: QEMU emulation, native builders, cross-compilation, manifest lists and CI examples."
date: 2026-11-08
category: Docker
keywords: multi-arch docker images, docker buildx multi platform, arm64 amd64 docker, docker manifest list, buildx qemu
---

ARM servers are now a normal choice. Graviton, Ampere and Hetzner's ARM instances often cost less for the same work, and your laptop may well be Apple silicon. The catch is the image: a container built on one CPU architecture fails on the other with `exec format error`. Multi-arch Docker images solve this by publishing one tag that holds a build for each architecture, and every machine pulls the half that matches its CPU. This guide shows how to build them with `docker buildx`, how to keep them fast, and how to run them on a cluster with both kinds of servers.

## How a multi-arch image works

A normal image tag points at one manifest: a list of layers and a config for one platform. A multi-arch tag points at a **manifest list** (the OCI spec calls it an image index), which is a small document that maps platforms to per-architecture manifests:

```text
ghcr.io/acme/api:1.4.2
├── linux/amd64  -> sha256:3f1c... (layers built for x86-64)
└── linux/arm64  -> sha256:9a7e... (layers built for ARM64)
```

When a node pulls `ghcr.io/acme/api:1.4.2`, the engine reads the index, picks the entry for its own platform and downloads only those layers. Official images such as `node`, `python`, `postgres` and `golang` already work this way, which is why `FROM node:22` builds on either CPU.

You can inspect any image's index:

```bash
docker buildx imagetools inspect node:22-alpine
```

## Three ways to build for another architecture

| Method | Speed | Setup | Works for |
|---|---|---|---|
| QEMU emulation | Slow, often several times slower | One command | Anything |
| Native builder per architecture | Full speed | A machine of each CPU | Anything |
| Cross-compilation | Full speed | Changes to the Dockerfile | Go, Rust, some others |

Most teams start with emulation, then move the slow builds to native builders or cross-compilation.

## Build with buildx and QEMU

`docker buildx` is the CLI for BuildKit. The default builder that ships with Docker Engine can only output a single-platform image into the local image store, so create a builder that uses the `docker-container` driver:

```bash
docker buildx create --name multi --driver docker-container --use
docker buildx inspect --bootstrap
```

`inspect` lists the platforms the builder can produce. If `linux/arm64` is missing on an x86 machine (or `linux/amd64` on an ARM one), register QEMU handlers in the kernel:

```bash
docker run --privileged --rm tonistiigi/binfmt --install arm64,amd64
```

Docker Desktop on macOS and Windows has this set up already. On Linux, the registration lasts until the next reboot.

Now build both architectures and push the result:

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t ghcr.io/acme/api:1.4.2 \
  --push .
```

`--push` matters. A manifest list has to live in a registry; the classic local image store holds one platform per tag. Use `--load` only for a single-platform build you want to run locally.

## Make the Dockerfile platform-aware

BuildKit passes a set of automatic build arguments you can use once you declare them:

- `BUILDPLATFORM`, `BUILDOS`, `BUILDARCH`: the machine doing the build.
- `TARGETPLATFORM`, `TARGETOS`, `TARGETARCH`, `TARGETVARIANT`: the platform being built.

Two uses come up constantly.

### Download the right binary

If you fetch a prebuilt tool, pick it by `TARGETARCH`:

```dockerfile
FROM debian:12-slim
ARG TARGETARCH
ARG TINI_VERSION=v0.19.0
ADD https://github.com/krallin/tini/releases/download/${TINI_VERSION}/tini-${TARGETARCH} /usr/bin/tini
RUN chmod +x /usr/bin/tini
```

Hard-coding `amd64` in a URL is the most common reason a "multi-arch" image crashes on ARM.

### Cross-compile instead of emulating

For compiled languages that can target another CPU, run the compiler natively on the build machine and only produce the binary for the target. Pin the build stage to `$BUILDPLATFORM`:

```dockerfile
# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM golang:1.23 AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/api /api
USER 65532:65532
ENTRYPOINT ["/api"]
```

The compile step runs at native speed for both targets. Only the final stage, which just copies a file, is assembled for each platform. Rust can do the same with cross toolchains, and tools like `xx` help for C dependencies.

Interpreted languages (Node.js, Python, Ruby, PHP) usually run their install step under emulation, because native modules and wheels must match the target. That is where most of the slowness comes from. Keep those layers cached so emulated installs only run when the lockfile changes; the [Docker build best practices](/blog/docker-build-best-practices/) post covers how.

## Use native builders for speed

A buildx builder can hold several nodes, one per architecture. Each platform is built on a machine with that CPU, and buildx merges the results into one index:

```bash
docker buildx create --name native --driver docker-container \
  --platform linux/amd64 --use
docker buildx create --name native --append \
  --platform linux/arm64 ssh://builder@arm-builder.internal
docker buildx build --builder native \
  --platform linux/amd64,linux/arm64 -t ghcr.io/acme/api:1.4.2 --push .
```

### In GitHub Actions

GitHub offers arm64 hosted runners, so you can build each platform natively in a matrix and merge the digests in a final job. For most apps, the simpler emulated version is enough to start:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ghcr.io/${{ github.repository }}:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

When the emulated half gets too slow, split it into a matrix on `ubuntu-latest` and the arm64 runner, push each by digest, and create the index with `docker buildx imagetools create`.

## Running a mixed cluster

Building the image is half the work. In a cluster with both amd64 and arm64 nodes, the scheduler must not place a container on a node its image cannot run on.

With a proper manifest list, any node can run any replica. With a single-architecture image, you need a placement constraint. On Docker Swarm, nodes expose their architecture to constraints:

```bash
docker service create --name api \
  --constraint 'node.platform.arch==x86_64' \
  ghcr.io/acme/api:1.4.2
```

Forget this and Swarm may schedule the task on an ARM node, where it fails to start and retries elsewhere. The [Docker Swarm](/blog/docker-swarm/) guide covers constraints and placement in general.

## How LogiStack handles architectures

LogiStack runs on amd64 and arm64 servers, and a single swarm can mix both. Each Git service has an **Architectures** setting under **Settings › Source and build**:

- **Automatic** (the default) builds for every architecture present in the swarm.
- **amd64 only** or **arm64 only** builds one, and the service is placed only on servers of that architecture.
- **amd64 and arm64** builds one image for both kinds of server, pushed as a manifest list. This needs a Dockerfile build and a registry.

The **Builds** page under **Settings** shows each architecture, whether the swarm has servers of that kind, and whether BuildKit can build it natively, through emulation, or not at all.

![The Builds settings page listing amd64 as Native and arm64 as Can't build, with a Set up emulation button](/docs/screens/settings-builds.webp)

When an architecture shows **Can't build**, an admin can run **Set up emulation**. The wizard lists what it will do before it does it: run `tonistiigi/binfmt` once as a Swarm job on the BuildKit server, with `CAP_SYS_ADMIN` rather than a privileged container, register QEMU for the missing architectures and restart BuildKit. Like any binfmt registration, it lasts until that server reboots, and builds running during the BuildKit restart fail, so pick a quiet moment.

Two limits to know: Railpack builds produce one architecture per image, so on a mixed swarm **Automatic** with Railpack builds BuildKit's own architecture. And emulated builds are as slow on LogiStack as anywhere else, so build only the architectures your servers actually run. Every step is in [build for amd64 and arm64](/docs/deploy/build-platforms/), and registry setup is in [registries](/docs/deploy/registries/).

## Troubleshooting

- **`exec format error` at container start.** The image has no entry for this node's architecture, or a binary inside it was downloaded for the wrong CPU. Check with `docker buildx imagetools inspect` and look for hard-coded `amd64` in the Dockerfile.
- **`docker exporter does not currently support exporting manifest lists`.** You used `--load` with several platforms. Use `--push`, or build one platform at a time locally.
- **The builder lists only one platform.** QEMU is not registered, or the server rebooted since. Run the binfmt step again.
- **Emulated builds take forever or crash.** Move compilation to `$BUILDPLATFORM` with cross-compilation, or build that platform on a native machine.
- **Native module errors on ARM.** Some npm or pip packages ship no prebuilt ARM binary and compile from source. Install the build tools (`python3`, `make`, `g++`) in the build stage, or pick a version that ships ARM builds.

## FAQ

### What is a multi-arch Docker image?

A single tag that points at a manifest list with one image per CPU architecture, typically linux/amd64 and linux/arm64. Each machine pulls only the variant for its own CPU, so the same tag runs on Intel, AMD and ARM servers.

### Do I need QEMU to build arm64 images on an x86 machine?

Only if you compile or install inside the arm64 stage. Cross-compilation with `FROM --platform=$BUILDPLATFORM` avoids emulation for languages like Go and Rust. A native ARM builder avoids it entirely.

### Why can't I load a multi-platform image with --load?

The classic Docker image store keeps one platform per tag. A manifest list must be pushed to a registry with `--push`. Docker's containerd image store can hold multi-platform images locally, but pushing is still the usual path.

### Are arm64 servers worth it?

Often, for web apps, APIs and workers built on interpreted languages or Go, where ARM instances tend to give more performance per euro. Check that every dependency and base image has ARM builds before you switch.

### How do I check which architectures an image supports?

Run `docker buildx imagetools inspect <image>`. It lists each platform in the manifest list with its digest.

Multi-arch builds let you choose servers by price and performance instead of by CPU. LogiStack builds amd64, arm64 or both from your Dockerfile, sets up QEMU from the dashboard when you ask, and places each service only where its image can run. It is open source and free. [Install it](/#install) on a server of either architecture.

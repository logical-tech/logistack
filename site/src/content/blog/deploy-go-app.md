---
title: "How to deploy a Go app to production with Docker"
description: "Deploy a Go app to production: a small multi-stage Docker image, graceful shutdown, health checks without curl, migrations, multi-arch builds and HTTPS."
date: 2026-11-08
category: Deployment
keywords: deploy go app, golang production deployment, go docker image, deploy golang, go graceful shutdown
---

Go compiles to a single static binary, which makes it one of the easiest languages to ship. You can `scp` the binary to a server and run it. The trouble starts on the second deploy: how do you swap the binary without dropping requests, roll back a bad release, run migrations, and get HTTPS? This guide shows how to deploy a Go app to production in a container that's a few megabytes in size, with clean shutdowns, health checks that work in minimal images, and push-to-deploy.

The examples use the standard library's `net/http` and Go 1.23, but they apply the same way to Chi, Echo, Gin or Fiber.

## Binary on a VPS or container?

Both work. The trade-offs:

| Approach | Strengths | Weak spots |
| --- | --- | --- |
| Binary + systemd | No Docker, minimal moving parts | Manual rollbacks, manual TLS, one app per port to juggle |
| Container on a platform | Immutable images, rolling deploys, rollbacks, HTTPS handled | One more layer to learn |

For one hobby service, systemd is fine. Once you have a database, a second service or a teammate, containers pay off: every version is an image you can roll back to, and the platform handles the proxy and certificates. The rest of this guide assumes containers.

## Prepare the app for production

### Configuration from the environment

Read the port, database URL and secrets from environment variables, and fail on startup if a required one is missing:

```go title="config.go"
func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("missing required env var %s", key)
	}
	return v
}
```

### Timeouts on the server

The zero-value `http.Server` has no timeouts. A slow client can hold a connection open forever. Always set them:

```go
srv := &http.Server{
	Addr:              ":" + port,
	Handler:           mux,
	ReadHeaderTimeout: 5 * time.Second,
	ReadTimeout:       30 * time.Second,
	WriteTimeout:      30 * time.Second,
	IdleTimeout:       120 * time.Second,
}
```

### Graceful shutdown

During a rolling deploy, the old container receives `SIGTERM` and has a few seconds before it's killed. `http.Server.Shutdown` stops accepting new connections and waits for in-flight requests:

```go title="main.go"
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})

	srv := &http.Server{Addr: ":" + port, Handler: mux, ReadHeaderTimeout: 5 * time.Second}

	go func() {
		slog.Info("listening", "port", port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server failed", "err", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	slog.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("shutdown", "err", err)
	}
}
```

Close database pools after `Shutdown` returns. Keep the shutdown timeout a little shorter than your platform's drain timeout.

### Structured logs to stdout

`log/slog` (Go 1.21+) writes structured logs with no dependency. Use `slog.New(slog.NewJSONHandler(os.Stdout, nil))` in production so your log tools can filter by field. The platform collects stdout from every replica; no log files needed.

## A small multi-stage Dockerfile

```dockerfile title="Dockerfile"
FROM --platform=$BUILDPLATFORM golang:1.23 AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api

FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata \
    && adduser -D -u 10001 app
COPY --from=build /out/api /usr/local/bin/api
USER app
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/api"]
```

What's going on:

- **`CGO_ENABLED=0`** produces a fully static binary with no libc dependency, so it runs on any base image. If you use a cgo package like `mattn/go-sqlite3`, switch to a pure-Go driver (`modernc.org/sqlite`) or keep cgo and use a Debian-based runtime.
- **`-trimpath -ldflags="-s -w"`** strips local paths and debug symbols, often cutting the binary by a quarter or more.
- **`--platform=$BUILDPLATFORM`** with `TARGETOS` and `TARGETARCH` cross-compiles natively. Building for arm64 on an amd64 machine takes seconds instead of the minutes QEMU emulation needs. See [multi-arch Docker images](/blog/multi-arch-docker-images/).
- **`ca-certificates`** lets the binary call HTTPS APIs. **`tzdata`** makes `time.LoadLocation` work. Alternatively, `import _ "time/tzdata"` embeds the time zone database in the binary.

### Alpine, distroless or scratch?

| Runtime image | Size | Shell | Good for |
| --- | --- | --- | --- |
| `scratch` | 0 MB | No | Absolute minimum; you add CA certs yourself |
| `gcr.io/distroless/static-debian12` | ~2 MB | No | Minimal attack surface, non-root user built in |
| `alpine` | ~8 MB | Yes | Debugging with a shell, health checks via `wget` |

Distroless and scratch are great for security, but there's a catch: Docker health checks run **inside** the container. Checks written as shell commands, or ones that call `wget` or `curl`, fail in an image with no shell and no HTTP client. You have two good options:

1. **Use Alpine** (as above). The few extra megabytes buy a shell for debugging and `wget` for HTTP checks.
2. **Let the binary check itself.** Add a flag that calls the health endpoint and exits 0 or 1, then use it as an exec-form health check that needs no shell:

```go
if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
	resp, err := http.Get("http://127.0.0.1:" + port + "/healthz")
	if err != nil || resp.StatusCode != http.StatusOK {
		os.Exit(1)
	}
	os.Exit(0)
}
```

## Embed assets and migrations

`go:embed` puts templates, static files and SQL migrations inside the binary, so the image needs nothing else:

```go
//go:embed migrations/*.sql
var migrations embed.FS
```

Tools like `goose` and `golang-migrate` can read migrations from an `embed.FS`. Expose a `migrate` subcommand in your binary (`api migrate`) and run it once per deploy, before the new version takes traffic. Don't run migrations automatically at startup: with several replicas, they all try at once.

## Deploy a Go app with LogiStack

[LogiStack](/features/) is an open-source, self-hosted PaaS on Docker Swarm with Caddy as the reverse proxy. It builds your Dockerfile with BuildKit on your server and rolls out each version with health checks.

**1. Install LogiStack:**

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

**2. Create a database if you need one.** Select **New service**, then **Database**; PostgreSQL, MySQL, MariaDB, MongoDB, Redis and libSQL are available. The service name becomes its hostname on the private network.

**3. Create the Go service from Git.** Connect your provider, pick the repository, set **Build with** to **Dockerfile** and **Container port** to `8080`. If `main` lives in `cmd/api` and the module root is the repository root, keep **Root directory** at `/`. See [Deploy from Git](/docs/deploy/from-git/).

**4. Add variables.** Add `DATABASE_URL` and other secrets in the **Environment** tab. To stamp the version into the binary, declare `ARG LOGISTACK_COMMIT_SHA` in the build stage and pass it with `-ldflags "-X main.version=$LOGISTACK_COMMIT_SHA"`; LogiStack passes that build argument to every Dockerfile that declares it. See [Build types](/docs/deploy/build-types/).

**5. Health check.** Under **Settings** › **Healthcheck and drain**:

- With the Alpine image, choose **HTTP request**, port `8080`, path `/healthz`.
- With distroless or scratch, choose **Command** and enter the binary and its flag on two lines (`/api` and `healthcheck`, or wherever your binary lives). A command check runs without a shell.

Set **Drain timeout** to `10` seconds or more, longer than the shutdown timeout in your code.

**6. Migrations as a release command.** Under **Settings** › **Release commands**, set the **Pre-deploy command** to your binary's migrate subcommand, one argument per line:

```text title="Pre-deploy command"
/usr/local/bin/api
migrate
```

It runs once on the new image with the service's variables. If it fails, the deploy stops and the current version keeps running. See [Deployments](/docs/deploy/deployments/).

**7. Domain and scaling.** Add your domain in the **Domains** tab for a Let's Encrypt certificate. Under **Settings** › **Scaling**, add copies or turn on **Automatic** scaling with CPU load. Go services start in milliseconds, so new replicas join quickly.

**8. Mixed architectures.** If your swarm has both amd64 and arm64 servers, set **Architectures** to **amd64 and arm64** under **Settings** › **Source and build**. The `$BUILDPLATFORM` Dockerfile above cross-compiles both without emulation. See [Build platforms](/docs/deploy/build-platforms/).

![The Overview tab of a service with replicas on several nodes](/docs/screens/service-overview.webp)

## Common Go deployment problems

- **`x509: certificate signed by unknown authority`**: the runtime image has no CA bundle. Add `ca-certificates` or use distroless.
- **`unknown time zone Europe/Rome`**: no `tzdata` in the image. Install it or import `time/tzdata`.
- **`exec format error`**: the binary was built for a different architecture than the server. Set `GOARCH` from `TARGETARCH`.
- **Health check always fails on distroless**: the check needs a shell or `wget`. Use a command check that runs your binary.
- **Requests dropped on deploy**: no `SIGTERM` handling, so the process dies with requests in flight.

## FAQ

### What is the best base image for a Go app?

For most teams, Alpine or distroless static. Alpine gives you a shell for debugging; distroless removes nearly everything an attacker could use. `scratch` is smallest but needs you to add CA certificates and a non-root user yourself.

### Do I need a reverse proxy in front of a Go server?

Go's `net/http` is production-grade, but a proxy still handles TLS certificates, routes several apps on ports 80 and 443, and lets you run multiple replicas behind one domain. Platforms put one in front for you.

### How do I deploy a Go app without downtime?

Handle `SIGTERM` with `http.Server.Shutdown`, expose a health endpoint, and deploy with a platform that starts the new container before stopping the old one. The [zero-downtime deployments](/blog/zero-downtime-deployments/) guide covers the full pattern.

### How small can a Go Docker image be?

A stripped static binary on `scratch` or distroless is often 10 to 20 MB in total, most of it your binary. Alpine adds about 8 MB.

Go makes the build easy; production comes down to timeouts, shutdown, a health check that works in your base image and migrations outside startup. To run Go services on your own server with push-to-deploy, rollbacks and HTTPS, [install LogiStack](/#install).

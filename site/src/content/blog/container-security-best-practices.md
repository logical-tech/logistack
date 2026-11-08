---
title: "Container security best practices: a 20-point checklist"
description: "Container security best practices you can audit in an afternoon: images, builds, runtime flags, networking, secrets and access, with config examples."
date: 2026-11-08
category: Security
keywords: container security best practices, docker security best practices, container hardening, container vulnerabilities, docker compose security
---

Most container breaches don't start with a clever zero-day. They start with a database port someone published for debugging, an image nobody rebuilt in a year, or a container running as root with the Docker socket mounted. These container security best practices target exactly those failures. Each item says what to do, why it matters, and how to check it on a running server, so you can work through the list in an afternoon and know where you stand.

If you want the background on how container isolation works first, read [container security: a practical guide](/blog/container-security/). This post is the checklist.

## The checklist at a glance

| # | Practice | Effort | Impact |
| --- | --- | --- | --- |
| 1 | Use minimal base images | Low | High |
| 2 | Pin base image versions | Low | Medium |
| 3 | Rebuild images regularly | Low | High |
| 4 | Scan running images, not only new builds | Low | High |
| 5 | Use multi-stage builds | Medium | Medium |
| 6 | Never bake secrets into images | Low | High |
| 7 | Tag every deployment immutably | Low | Medium |
| 8 | Run as a non-root user | Medium | High |
| 9 | Drop all capabilities, add back what you need | Low | High |
| 10 | Never run privileged containers | Low | High |
| 11 | Never mount the Docker socket into apps | Low | High |
| 12 | Set memory and CPU limits | Low | Medium |
| 13 | Add health checks | Low | Medium |
| 14 | Publish no ports you don't mean to expose | Low | High |
| 15 | Put admin tools behind access rules | Low | High |
| 16 | Restrict cluster ports to your nodes | Low | High |
| 17 | Store secrets encrypted, inject at deploy time | Medium | High |
| 18 | Give every person and machine its own scoped access | Medium | High |
| 19 | Keep an audit log of changes | Low | Medium |
| 20 | Patch the host kernel and Docker | Low | High |

## Image practices

### 1. Use minimal base images

Every package in an image is code an attacker can use and a CVE you have to track. Prefer `-slim`, Alpine or distroless variants. A Debian slim image carries a fraction of the packages of the full one.

**Check it:** `docker image ls` and look for images over a few hundred megabytes that run a single small service. Those usually ship a full OS they don't need.

### 2. Pin base image versions

`FROM python` gives you whatever was latest on build day. `FROM python:3.13-slim-bookworm` gives you a known line. For strict reproducibility, pin the digest too.

```dockerfile
FROM python:3.13-slim-bookworm@sha256:<digest>
```

Pinning trades automatic updates for predictability, which is why practice 3 exists.

### 3. Rebuild images regularly

A pinned base gets security fixes only when you rebuild. Schedule a rebuild, weekly or when a scan finds a fixable critical issue, so patched packages reach production.

### 4. Scan running images, not only new builds

A scan in CI catches problems on the day you build. New advisories are published every day after that. Rescan what is running, and alert on new critical findings. See [container security scanning](/blog/container-security-scanning/) for how to set that up without slowing deploys.

## Build practices

### 5. Use multi-stage builds

Build tools, compilers and dev dependencies don't belong in production. Compile in one stage and copy only the artifacts to a clean runtime stage.

### 6. Never bake secrets into images

`ENV`, `ARG` and `COPY .env` all leave values in image layers or history, visible to anyone who can pull the image. Use BuildKit secret mounts for build-time credentials and inject runtime secrets when the container starts.

**Check it:**

```bash
docker history --no-trunc registry.example.com/acme/api:dep_8k2p1q | grep -iE "key|token|secret|password"
```

Also add `.env`, `*.pem` and `.git` to `.dockerignore`.

### 7. Tag every deployment immutably

If tags are reused, you can't tell which image a container is running or roll back to an exact build. Tag each deployment with a unique ID or the commit SHA and never overwrite it.

## Runtime practices

### 8. Run as a non-root user

Most images default to root. Set a numeric user in the Dockerfile (`USER 1000:1000`) or at runtime, and make sure the app's writable directories belong to that user. Numeric IDs avoid surprises when the image has no matching entry in `/etc/passwd`.

**Check it:**

```bash
docker ps -q | xargs docker inspect --format '{{.Name}} user={{.Config.User}}'
```

An empty `user=` means root.

### 9. Drop all capabilities, add back what you need

Docker grants a default set of Linux capabilities. A typical web app needs none of them. Drop `ALL` and add back only what the process proves it needs, such as `NET_BIND_SERVICE` to bind port 80 as non-root.

### 10. Never run privileged containers

`--privileged` disables most of the isolation that makes a container a container: it grants all capabilities and access to host devices. If a tool asks for it, find out which single capability it actually needs.

### 11. Never mount the Docker socket into apps

A container with `/var/run/docker.sock` can start other containers with the host filesystem mounted. That is root on the host. Monitoring agents and CI runners are the usual offenders. If one truly needs Docker access, treat it as part of your infrastructure, not as an app.

### 12. Set memory and CPU limits

Without limits, a memory leak or a crypto miner in one container can starve the host and take down every other service. Set limits that leave headroom above normal use.

### 13. Add health checks

A health check lets the orchestrator replace a hung container and lets rolling updates refuse a broken release. It's an availability control, and availability is part of security.

## Network practices

### 14. Publish no ports you don't mean to expose

Docker writes iptables rules for published ports that run before UFW and firewalld. A published Postgres port is reachable from the internet even when your firewall says it isn't. Route HTTP through a reverse proxy, keep databases on internal networks, and publish only ports that must be public.

**Check it:**

```bash
docker ps --format '{{.Names}}\t{{.Ports}}' | grep '0.0.0.0'
```

### 15. Put admin tools behind access rules

Database GUIs, queue dashboards and internal tools often ship without a login, or with a weak one. Put them behind an IP allowlist, basic auth or a sign-in gateway like Authelia or Authentik at the proxy.

### 16. Restrict cluster ports to your nodes

On Docker Swarm, ports 2377, 7946 and 4789 carry cluster management and overlay traffic. Open them only between your nodes, ideally over a private network.

## Secrets and access practices

### 17. Store secrets encrypted, inject at deploy time

Secrets belong in an encrypted store with versions and an owner, injected into containers at start, masked in logs, and granted only to the services that use them.

### 18. Give every person and machine its own scoped access

No shared admin accounts. Each person gets a role that fits their job, each CI pipeline and AI agent gets its own key limited to the projects it touches, with an expiry. Require two-factor authentication or passkeys for humans.

### 19. Keep an audit log of changes

When something breaks or leaks, the first question is who changed what. An [audit log](/blog/audit-logs/) answers it, and its denied entries show someone probing for access.

### 20. Patch the host kernel and Docker

Containers share the host kernel, so a kernel CVE is a container CVE. Turn on unattended security upgrades and reboot after kernel updates.

## Container vulnerabilities these practices prevent

The same handful of weaknesses shows up in most incident reports. Here is how the checklist maps to them.

| Vulnerability | What happens | Practices that prevent it |
| --- | --- | --- |
| Known CVEs in packages | Attacker exploits an unpatched library | 1, 2, 3, 4 |
| Secrets in images or Git | Anyone with pull access reads credentials | 6, 17 |
| Container escape | Compromised app reaches the host | 8, 9, 10, 11, 20 |
| Exposed services | Database or admin panel reachable from the internet | 14, 15, 16 |
| Supply chain tampering | Malicious dependency enters a build | 2, 5, 7 |
| Resource abuse | Miner or leak takes down the host | 12, 13 |
| Account takeover | Stolen credential deploys or reads anything | 18, 19 |

## Applying the practices in Docker Compose

Most of the runtime items fit in a few lines of a compose file.

```yaml
services:
  api:
    image: registry.example.com/acme/api:dep_8k2p1q
    user: "1000:1000"
    cap_drop: [ALL]
    security_opt: [no-new-privileges]
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/health"]
      interval: 15s
      retries: 3
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: "1.0"
    networks: [internal]

  db:
    image: postgres:17
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/pg_password
    volumes: [pgdata:/var/lib/postgresql/data]
    networks: [internal]
    # no ports: reachable only from the internal network

networks:
  internal:

volumes:
  pgdata:
```

## How LogiStack covers the checklist

LogiStack is an open-source, self-hosted PaaS on Docker Swarm. Some items it does for you, some it gives you a setting for, and some stay your job.

| Practice | In LogiStack |
| --- | --- |
| 4. Scan running images | Trivy scan after each deployment and daily, with a notification on new critical CVEs ([docs](/docs/operations/vulnerability-scanning/)) |
| 6. No secrets in images | Build secrets become BuildKit secrets; runtime secrets are injected and masked in logs |
| 7. Immutable tags | Every deployment image is tagged with its deployment ID |
| 8, 9. User and capabilities | **Run as**, **Add capabilities** and **Drop capabilities** per service ([docs](/docs/deploy/service-settings/)) |
| 10. No privileged | Swarm services can't run privileged; compose files asking for it are refused |
| 11. Socket mounts | Bind mounts need an admin; sensitive paths like the Docker socket need explicit confirmation |
| 12, 13. Limits and health checks | CPU and memory limits or resource profiles, health checks gate rolling updates |
| 15. Access rules | IP allowlist, password or sign-in gateway per domain at the Caddy proxy ([docs](/docs/networking/access-control/)) |
| 18, 19. Access and audit | Roles per scope, scoped expiring API keys, SSO, passkeys, audit log |
| 1, 2, 3, 5, 14, 16, 20 | Yours: base images, Dockerfiles, published ports, host firewall and patching |

LogiStack runs on Swarm, not Kubernetes, and it has no runtime intrusion detection. If you need either, it isn't the full answer.

## FAQ

### Which container security best practice should I start with?

Start with the ones that hand over the host if you get them wrong: no privileged containers, no Docker socket mounts, no accidentally published database ports. They take minutes to check and fix. Then move to non-root users and image scanning.

### Is Alpine always the best base image?

Not always. Alpine uses musl instead of glibc, which can break some compiled dependencies and change performance. Debian slim or distroless images are good alternatives with a small footprint. Pick the smallest image your app runs on without workarounds.

### Do I need a read-only root filesystem?

It's a strong control when the app supports it, because an attacker can't write tools or modify code on disk. Many apps need a writable `/tmp` or cache directory, which you can provide with a tmpfs or a volume. Treat it as a hardening step after the basics.

### How do I keep secrets out of Docker Compose files?

Reference them instead of writing them inline: Docker secrets with `_FILE` variables, environment variables injected by your platform, or a secret manager read at deploy time. Never commit the values to Git.

Work through the list once, write down what you skipped and why, and repeat it every quarter. If you'd rather start from a platform that covers part of the checklist by default, [install LogiStack](/#install) and see [all features](/features/).

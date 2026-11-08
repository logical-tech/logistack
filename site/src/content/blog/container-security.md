---
title: "Container security: a practical guide for self-hosters"
description: "Container security explained layer by layer: images, builds, runtime, host, secrets and access, with the settings that matter on your own servers."
date: 2026-11-08
category: Security
keywords: container security, docker security, secure containers, container isolation, self-hosted security
---

You moved your apps into containers, put them on a VPS, and everything runs. Then a question arrives from a client, an auditor or your own conscience: is any of this secure? Container security is not one setting you switch on. It is a set of small decisions about images, builds, the runtime, the host, secrets and who can change what. This guide walks through each layer, explains where the real risks sit, and shows the controls that cost little and prevent the most damage.

## What container security actually covers

A container is an ordinary Linux process with a restricted view of the system. That one fact explains most of the field. If the process is compromised, an attacker gets whatever that process can reach: its files, its network, its environment variables, and the kernel it shares with every other container on the host.

So container security splits into layers. Each one has its own threats and its own controls.

| Layer | Typical threat | Control that helps most |
| --- | --- | --- |
| Image | Known CVEs in OS packages and dependencies | Small base images, regular rebuilds, scanning |
| Build and supply chain | Tampered or mutable dependencies, leaked build secrets | Pinned versions, immutable tags, build secrets |
| Runtime | A compromised process escalating privileges | Non-root user, dropped capabilities, resource limits |
| Host and network | Kernel exploits, exposed ports, open management APIs | Patching, firewall rules, private networks |
| Secrets | Credentials in images, logs or Git | Encrypted secret storage, injection at deploy time |
| Platform access | A stolen password or an over-privileged API key | Roles, scoped keys, two-factor, audit log |

You don't need to perfect every row. You need to avoid the cheap mistakes in all of them, because attackers look for the weakest layer, not the strongest.

## How container isolation works, and where it ends

Docker builds isolation from Linux kernel features:

- **Namespaces** give the process its own view of process IDs, mounts, network interfaces and hostnames.
- **Control groups (cgroups)** limit how much CPU, memory and I/O it can use.
- **Capabilities** split root's powers into pieces, and Docker drops many by default.
- **Seccomp and AppArmor or SELinux profiles** block risky system calls and file access.

What containers do not give you is a separate kernel. Every container on a host talks to the same kernel. A kernel vulnerability, a container started with `--privileged`, or a mount of the Docker socket can turn a container compromise into a host compromise.

That last one deserves a sentence of its own. Any process that can write to `/var/run/docker.sock` can start a new container with the host's root filesystem mounted. Mounting the socket into an app container is equivalent to giving that app root on the host.

```bash
# Anyone who can run this owns the host. Never mount the socket into an app.
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock docker:cli \
  docker run --rm -v /:/host alpine cat /host/etc/shadow
```

If you need stronger isolation between tenants you don't trust, look at gVisor, Kata Containers or separate virtual machines. For your own apps on your own servers, a well-configured container is usually enough.

## Secure the image

The image is what you ship, so it is where most known vulnerabilities live. Three habits cover the bulk of the risk.

**Start small.** A Debian slim, Alpine or distroless base has far fewer packages than a full distribution image. Fewer packages means fewer CVEs and fewer tools for an attacker to use after getting in.

**Use multi-stage builds.** Compile in one stage, copy only the output into a minimal runtime stage. Your compilers, package managers and test fixtures stay out of production.

```dockerfile
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER 1000:1000
CMD ["node", "dist/server.js"]
```

**Rebuild on a schedule.** An image that was clean on the day you built it collects CVEs as new advisories are published. Scan running images, not only new builds, and rebuild when a fix lands. The guide on [container security scanning](/blog/container-security-scanning/) covers how to fit that into a deploy flow.

## Secure the build and supply chain

Your image is only as trustworthy as everything that went into it.

- **Pin versions.** `FROM node:22-bookworm-slim` is better than `FROM node`. Pinning the digest (`@sha256:...`) is better still when you need reproducibility.
- **Use lockfiles** and install with the strict command (`npm ci`, `pip install --require-hashes`, `go mod verify`).
- **Tag images immutably.** If every deployment produces a tag nobody reuses, you always know which bytes ran and you can roll back to an exact image. A mutable `:latest` makes both impossible.
- **Keep secrets out of layers.** An `ENV API_KEY=...` or a copied `.env` file stays in the image history even if a later layer deletes it. Use BuildKit secret mounts for anything the build needs.

```dockerfile
# The token is mounted for this step only and never written to a layer.
RUN --mount=type=secret,id=npm_token \
    NPM_TOKEN="$(cat /run/secrets/npm_token)" npm ci
```

- **Run the builder with low privileges.** A build executes code from your repository and its dependencies. A rootless builder limits what a malicious install script can do to the host.

## Secure the runtime

This is where a few flags make a large difference.

```bash
docker run -d \
  --name api \
  --user 1000:1000 \
  --cap-drop ALL \
  --cap-add NET_BIND_SERVICE \
  --security-opt no-new-privileges \
  --read-only --tmpfs /tmp \
  --memory 512m --cpus 1 \
  registry.example.com/acme/api:dep_8k2p1q
```

What each one buys you:

- **`--user`**: the process does not run as root inside the container. Many escape techniques assume root.
- **`--cap-drop ALL`, then add back only what you need**: most web apps need no capabilities at all.
- **`no-new-privileges`**: setuid binaries can't raise privileges.
- **`--read-only`**: an attacker can't drop tools or modify the app on disk.
- **Memory and CPU limits**: one runaway or abused container can't starve the rest of the host.

And what to never do in production: `--privileged`, `--pid=host`, `--network=host` for an internet-facing app, or bind mounts of `/`, `/etc` or the Docker socket. The article on [container security best practices](/blog/container-security-best-practices/) goes deeper on each of these.

## Secure the host and the network

Containers inherit the host's weaknesses.

**Patch the kernel and Docker.** A shared kernel means kernel CVEs matter to every container. Enable unattended security updates and reboot when the kernel changes.

**Know that Docker bypasses your firewall.** Docker writes iptables rules for published ports, and those rules are evaluated before UFW or firewalld. A database published with `-p 5432:5432` is reachable from the internet even when `ufw status` says the port is closed. Don't publish a port unless you mean it to be public. Put services behind a reverse proxy and keep databases on an internal network.

**Lock down cluster ports.** On Docker Swarm, 2377/tcp, 7946/tcp+udp and 4789/udp should be open only between your nodes, never to the world.

```bash
# Allow Swarm traffic from one peer node only
ufw allow from 198.51.100.20 to any port 2377 proto tcp
ufw allow from 198.51.100.20 to any port 7946
ufw allow from 198.51.100.20 to any port 4789 proto udp
```

**Keep admin panels private.** A dashboard that can deploy containers is as sensitive as SSH. Put it behind a VPN, Tailscale or an IP allowlist when you can.

## Secure secrets

Secrets leak through four doors: the image, the Git repository, logs and over-broad access. Close each one.

- Inject secrets as environment variables or files at deploy time, never at build time.
- Encrypt them at rest and keep a history of versions, so you can rotate and roll back.
- Mask them in build and deployment logs.
- Give each service only the secrets it uses, not a shared bag of everything.

If your team already runs HashiCorp Vault, Infisical or 1Password, read secrets from there at deploy time instead of copying them into yet another system.

## Secure access to the platform

The easiest way into your containers is often not an exploit. It is a stolen password or a forgotten API key with owner rights.

- Use roles with the least privilege that works. A developer who deploys rarely needs to read production secrets or open a shell.
- Give CI and AI agents their own scoped, expiring keys.
- Require two-factor authentication or passkeys.
- Keep an [audit log](/blog/audit-logs/) of every change, including denied attempts.

## Common container security mistakes

1. Running everything as root because the image defaults to it.
2. Publishing database ports "temporarily" and forgetting them.
3. Baking `.env` files into images.
4. Deploying `:latest` and losing track of which image is live.
5. Scanning images once at build time and never again.
6. Sharing one admin account and one API key across the whole team.
7. Mounting the Docker socket into a monitoring or CI container without thinking about what that grants.

## How LogiStack handles container security

LogiStack is an open-source, self-hosted PaaS on Docker Swarm with Caddy as the proxy. It doesn't replace the habits above, but it makes several of them the default:

- **Builds** run in rootless BuildKit. Each deployment produces an image tagged with its deployment ID, so you can roll back to an exact image. Build-time secrets are passed as BuildKit secrets, not build arguments. See [build types](/docs/deploy/build-types/).
- **Runtime settings** per service include the user to run as, added and dropped capabilities, and CPU and memory limits. Swarm services can't run privileged, and compose files with `privileged: true` are refused. Bind mounts need an admin, and sensitive paths like the Docker socket need explicit confirmation. See [service settings](/docs/deploy/service-settings/).
- **Image scanning** with Trivy runs after every deployment and once a day, with a badge per service and a notification when a new critical CVE appears. See [vulnerability scanning](/docs/operations/vulnerability-scanning/).
- **Secrets** are encrypted per organization with AES-256-GCM, versioned, masked in logs, and can be read from Vault, Infisical or 1Password at deploy time.
- **Access** uses roles on organization, folder, project, environment and service scopes, scoped expiring API keys, SSO, passkeys and an audit log with secrets redacted.

![The Security tab of a service with an image scan summary and a table of findings by package, installed version and fixed version](/docs/screens/service-security.webp)

Honest limits: LogiStack has no runtime threat detection, so pair it with a tool such as Falco if you need to catch suspicious behavior inside running containers. It runs on Docker Swarm, not Kubernetes, so Kubernetes-only tools like admission controllers don't apply. And it is a young project with a smaller community than the established platforms.

## FAQ

### Are containers more secure than virtual machines?

No, they are less isolated. A virtual machine has its own kernel, while containers share the host's. Containers are secure enough for your own workloads when configured well, but untrusted multi-tenant code belongs in VMs or sandboxed runtimes like gVisor.

### Is running a container as root dangerous?

Yes, more than most people expect. Root inside a container maps to root on the host unless you use user namespaces, and many escape techniques depend on it. Set a numeric user in the Dockerfile or at deploy time, and fix file permissions so the app works without root.

### How often should I scan container images?

On every build, and again on a schedule for images that are already running. New CVEs are published daily, so an image that was clean last month may not be clean today. A daily rescan with a notification on new critical findings is a sensible baseline.

### Does Docker Swarm encrypt traffic between nodes?

Swarm encrypts its control plane traffic with mutual TLS by default. Application traffic on overlay networks is not encrypted unless the network is created with the `encrypted` option, or you route it through a private link such as WireGuard or Tailscale.

### What is the single most important container security step?

Avoid the configurations that hand over the host: privileged containers, Docker socket mounts and published database ports. After that, run as non-root and keep images patched.

Container security is mostly about defaults you set once and stop thinking about. If you want those defaults built into the platform you deploy with, [install LogiStack](/#install) on a server you control, or browse the [full feature list](/features/) first.

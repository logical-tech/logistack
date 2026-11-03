# Installing LogiStack

LogiStack runs as one Docker Swarm stack on your own server. The installer sets up Docker and Swarm, creates the secrets, deploys the stack, and prints a URL where a guided wizard finishes the setup in the browser.

## Requirements

- Ubuntu 22.04+ or Debian 12+. Other Linux distributions work if Docker 26+ is already installed, but the installer warns that they are untested.
- amd64 or arm64.
- At least 2 GB of RAM and 10 GB of free disk.
- Ports 80/tcp, 443/tcp and 443/udp free, and open in your provider's firewall.
- Root access.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/logical-tech/logistack/main/install/install.sh | sudo bash
```

Preview what the installer would do, without changing anything:

```sh
curl -fsSL https://raw.githubusercontent.com/logical-tech/logistack/main/install/install.sh | sudo bash -s -- --dry-run
```

Options:

| Flag | Meaning |
| --- | --- |
| `--version X` | Release to install or upgrade to: `0.2.0`, `v0.2.0` or `latest`. Defaults to the release that runs now (read from the api's image, so in-app updates count), else the release the installer was attached to, else the latest release on GitHub. |
| `--advertise-addr IP` | Address other Swarm nodes use to reach this one. Defaults to the address of the interface holding the default route. Never `127.0.0.1`. |
| `--yes` | Skip the confirmation prompt. Needed when no terminal is attached. |
| `--dry-run` | Run the checks, print the plan, change nothing. |
| `--local-build` | Build the four images from this checkout and deploy them without pulling from ghcr.io. Single node only, since the images exist only where they were built. Pass it on every re-run. |

Without `--local-build` the installer pulls `ghcr.io/logical-tech/logistack*:<version>`. A fresh install with no `--version` asks GitHub's API for the latest release, without credentials. `--local-build` from a checkout is for development: its first build takes several minutes, most of it compiling Caddy with its DNS modules, and with no `--version` its images are labelled `0.0.0`.

When it finishes, the installer prints a URL such as `http://203-0-113-7.sslip.io`. Open it to finish the setup wizard.

The installer is idempotent. Re-running it repairs a broken install and never rotates existing secrets.

## What it creates

| Object | Details |
| --- | --- |
| Docker | Installed from `download.docker.com` when missing (Ubuntu and Debian only). |
| Swarm | `docker swarm init --advertise-addr <ip>` when the server is not in a swarm yet. An existing swarm is reused if this node is a manager. |
| Node labels | `logistack.ingress=true` and `logistack.data=true` on this node, only when no node carries them yet. |
| Secrets | `logistack-master-key`, `logistack-postgres-password`, `logistack-better-auth-secret`, `logistack-redis-password`, `logistack-agent-token`, created only when absent. The agent token is mounted into the api and every agent as `LOGISTACK_AGENT_TOKEN_FILE`. |
| `/etc/logistack/credentials` | The generated secret values, mode 600. Back this file up: the master key encrypts every secret stored in LogiStack, and Docker secrets cannot be read back. |
| `/etc/logistack/stack.yml`, `/etc/logistack/version` | The deployed stack file and the release the installer last deployed. An in-app update changes the images, not this file; the installer reads the running release from the api service. |
| `/var/log/logistack-install.log` | Full output of every command the installer ran, mode 600. |
| Stack `logistack` | `postgres`, `redis`, `logistack-api`, `logistack-worker`, `logistack-agent` (one per node), `caddy` (one per ingress node). |
| Service `ls-buildkit` | Rootless BuildKit for git builds. The worker creates it on the first build, outside the stack. `uninstall.sh` removes it. |
| Networks | `ls-control` (10.247.0.0/16, control plane, never reachable from apps) and `ls-ingress` (Caddy plus services with a domain). |
| Volumes | `logistack_pgdata` and `logistack_redisdata`, local to the node labelled `logistack.data=true`. `logistack_workerdata` holds clones and build logs, `ls-buildkit-cache` the build cache. |

If the server already has `/etc/logistack/credentials` but no secrets (for example a new server where you copied the file), the installer creates the secrets from the file instead of generating new values. This is the manual disaster recovery path until `install.sh --restore` exists.

## Upgrade

From the dashboard, an admin opens **Settings > Updates** and clicks **Update to vX**. From the server:

```sh
curl -fsSL https://raw.githubusercontent.com/logical-tech/logistack/main/install/install.sh | sudo bash -s -- --version 0.2.0
```

The installer writes the new version and redeploys the stack. The api and worker roll with start-first updates and roll back on failure. Postgres, Redis and Caddy stop the old task first, because they own a data directory or host ports. The api runs database migrations at startup under a Postgres advisory lock, so several replicas never migrate at once.

The same command moves an install built with `--local-build` (images `localhost/logistack*:<v>-local.<hash>`) to the published images: leave out `--local-build` and name the release.

### In-app updates

The api records the request in `instance_update`, which allows one queued or running update at a time, and pokes the worker. The worker does not update itself. It starts a one-shot Swarm job, `ls-update-<id>`, from its own task spec (same image, secrets, `ls-control` network and docker socket), pinned to its own node. That job runs `apps/worker/src/update-runner.ts`:

1. Pull all four images, `ghcr.io/logical-tech/<image>:<version>`, and pin each to its registry digest. If one pull fails, stop with nothing changed.
2. Update `logistack_logistack-api` and wait until Swarm reports the update complete, monitor window included, with every task on the new image and healthy. Its entrypoint migrates first.
3. The same for `logistack_logistack-agent`, `logistack_caddy` and, last, `logistack_logistack-worker`.

Each service keeps its own `update_config`, so a task that fails within the monitor window makes Swarm roll that service back. The updater then restores every service it changed in this run, newest first, and records the failure. Every step and log line goes to the run's row and to `instance-update:<id>` on `/ws`. The job outlives the worker it replaces, so the sequence never depends on a process the sequence stops. A run whose updater stops reporting for 30 minutes is marked failed. The next run removes finished updater jobs.

An in-app update swaps images only. A release that changes `install/stack.yml` (a new service, a new variable) says so in its notes and needs the installer. `LS_UPDATE_REGISTRY` on the worker (`LOGISTACK_UPDATE_REGISTRY` for the installer) changes where images come from; `localhost` uses images already on the engine, which is how the smoke test updates.

With **Check daily** on (the default), the worker asks `api.github.com/repos/logical-tech/logistack/releases/latest` once a day and emits `instance.update_available` once per new release. The Updates page asks the same endpoint through the api, cached for an hour.

## Publishing a release

```sh
git checkout main && git pull
git tag -a v0.2.0 -m v0.2.0
git push origin v0.2.0
```

`.github/workflows/release.yml` then builds the four images natively on amd64 and arm64 runners with `LOGISTACK_VERSION` and `LOGISTACK_COMMIT` baked in, provenance and SBOM attestations attached, and pushes `ghcr.io/logical-tech/<image>:0.2.0` plus `latest` (a tag with a `-`, such as `v0.3.0-rc.1`, is a prerelease and skips `latest`). Finally it creates the GitHub Release with notes from the conventional commits since the previous tag (`.github/release-notes.sh`) and attaches `install.sh`, pinned to that release, and `stack.yml`.

GitHub has no API to change a container package's visibility. After the first release, once per package (`logistack`, `logistack-worker`, `logistack-agent`, `logistack-caddy`): open it under the organization's **Packages**, then **Package settings > Danger Zone > Change visibility > Public**. The release job's last step warns while an image still needs credentials to pull.

## Uninstall

```sh
sudo bash install/uninstall.sh
```

This removes the stack and its networks. Volumes, secrets and `/etc/logistack` stay, so running the installer again brings LogiStack back with its data.

To delete everything, including the database:

```sh
sudo bash install/uninstall.sh --purge
```

It asks you to type `purge`. With `--yes` it skips the question. Docker and the swarm stay installed. Volumes on other nodes must be removed there.

## Firewall

Docker publishes ports through iptables, which bypasses UFW and firewalld rules. Ports 80 and 443 are therefore open even if UFW says otherwise. Never publish a database port unless you mean it to be public.

Before you add a second server, open the Swarm ports only between LogiStack nodes:

| Port | Purpose |
| --- | --- |
| 2377/tcp | Swarm management |
| 7946/tcp and 7946/udp | Node discovery |
| 4789/udp | Overlay network traffic |

With UFW, for each peer node:

```sh
ufw allow from <node-ip> to any port 2377 proto tcp
ufw allow from <node-ip> to any port 7946
ufw allow from <node-ip> to any port 4789 proto udp
```

With firewalld:

```sh
firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=<node-ip> port port=2377 protocol=tcp accept'
firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=<node-ip> port port=7946 protocol=tcp accept'
firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=<node-ip> port port=7946 protocol=udp accept'
firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=<node-ip> port port=4789 protocol=udp accept'
firewall-cmd --reload
```

## Adding servers

Servers will be added from the dashboard (Servers > Add server). The wizard connects once over SSH, installs Docker, joins the swarm and starts the agent. `install/join.sh` describes the manual fallback until then.

## Building the images

```sh
v=(--build-arg LOGISTACK_VERSION=<version> --build-arg LOGISTACK_COMMIT=$(git rev-parse --short HEAD))
docker build "${v[@]}" --target api -t ghcr.io/logical-tech/logistack:<version> .
docker build "${v[@]}" --target worker -t ghcr.io/logical-tech/logistack-worker:<version> .
docker build "${v[@]}" -f install/agent.Dockerfile -t ghcr.io/logical-tech/logistack-agent:<version> .
docker build "${v[@]}" -t ghcr.io/logical-tech/logistack-caddy:<version> docker/caddy
```

The release workflow does this for both `linux/amd64` and `linux/arm64`. The version ARGs sit at the end of every final stage, so a new version rebuilds metadata only; the worker is its own stage, not a child of the api, for the same reason.

The api and the worker come from one build. The worker target adds `git`, `buildctl` and `railpack`, which the api does not need. `buildctl` and `railpack` are pinned in the `Dockerfile` with a sha256 per architecture. Bump a version and its checksums together, and keep `LS_RAILPACK_FRONTEND` in `install/stack.yml` on the same railpack release.

The worker image starts as root only to read the docker socket's group id, then drops to the `bun` user with that group. The id differs per host, and `docker stack deploy` has no `group_add`.

`ls-buildkit` is not in `stack.yml`. Rootless BuildKit needs seccomp unconfined and AppArmor off, and `docker stack deploy` ignores `security_opt`. With `cap_add: [SYS_ADMIN]` the daemon starts but every `RUN` step fails with `unable to join session keyring`. The worker creates the service through the Engine API, which can set both privileges. Details are in `docs/spikes/stack-smoke.md`.

A `--local-build` image tag is the version plus a hash of the four image ids, for example `0.1.0-local.6ea78cb156ec`. Re-running the installer without code changes restarts nothing, and any change rolls the services. Builds run without provenance attestations, whose timestamp would change the image id on every build.

## Smoke test

`bash install/smoke.sh` runs the whole install inside a throwaway privileged `docker:dind` container named `ls-test-pkg-dind`. It then completes setup, signs in, deploys `nginx:alpine` through the API and checks the result. It never touches the host's swarm. `KEEP=1` leaves the container running for inspection. The last recorded run is in `docs/spikes/stack-smoke.md`.

`SMOKE_UPDATE=1 bash install/smoke.sh` (container `ls-test-rel-dind`) installs `--version 0.0.1`, builds the same images as `localhost/logistack*:0.0.2`, and updates to them with `POST /api/instance/update`, the path the Updates page uses, with the worker's image source set to `localhost`. It checks that every service runs 0.0.2, that `GET /api/version` reports it, that the migrations are all applied and the api healthy, and that `/ws` streamed the progress. CI runs this mode on `main` and on tags.

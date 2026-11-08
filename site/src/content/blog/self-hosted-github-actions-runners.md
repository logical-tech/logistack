---
title: "Self-hosted GitHub Actions runners: setup and security"
description: "Set up self-hosted GitHub Actions runners on Linux: install, labels, ephemeral runners in Docker, autoscaling options and the security rules that matter."
date: 2026-11-08
category: Deployment
keywords: self-hosted github actions runners, github self-hosted runner, github actions runner docker, ephemeral runners, actions runner controller
---

Your builds take twelve minutes on a hosted runner, they need a GPU or 64 GB of RAM, or they must reach a database that only exists inside your network. Self-hosted GitHub Actions runners solve all three: you keep the same workflow files, and jobs run on machines you own. They also hand you a security problem GitHub used to solve for you. This guide covers both halves, the setup and the rules that keep a runner from becoming a way into your infrastructure.

## When a self-hosted runner makes sense

Use one when at least one of these is true:

- **Speed.** A dedicated machine with a warm Docker layer cache and local dependency caches beats a fresh hosted VM every time.
- **Hardware.** You need arm64 at scale, a GPU, lots of memory, or a specific CPU.
- **Network access.** Jobs must reach private services such as an internal registry, a staging database or an on-prem API.
- **Cost at volume.** Many build minutes on private repositories can cost more than a server. Check GitHub's billing documentation for the current terms, including for self-hosted runners.
- **Data location.** Code and build artifacts must stay in a specific country or on your hardware.

Do not use one when your repository is public. Anyone can open a pull request, and a workflow triggered by that pull request runs their code on your machine. GitHub's own guidance says the same.

## How a runner works

The runner is an open-source agent (`actions/runner`, MIT licensed) that you install on a machine. It opens an outbound HTTPS long-poll to GitHub and asks for jobs. Nothing connects inward, so no ports need to be open.

Each runner registers at one of three levels:

| Level | Who can use it | Good for |
|---|---|---|
| Repository | One repository | Trying it out, a single special repo |
| Organization | Repositories you allow, via runner groups | Shared build pools |
| Enterprise | Organizations you allow | Large companies with central platform teams |

Workflows pick runners by labels. Every runner has `self-hosted` plus its OS and architecture, and you add your own:

```yaml
jobs:
  build:
    runs-on: [self-hosted, linux, arm64, build]
```

A job runs on any idle runner whose labels include all of the listed ones.

## Install a runner on Linux

Create an unprivileged user. Never run the agent as root:

```bash
sudo useradd --create-home --shell /bin/bash runner
sudo -iu runner
```

Download the agent. Check the [actions/runner releases](https://github.com/actions/runner/releases) page for the current version and its checksum:

```bash
RUNNER_VERSION="2.321.0"   # replace with the latest release
mkdir actions-runner && cd actions-runner
curl -fsSLo runner.tar.gz \
  "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
tar xzf runner.tar.gz
```

Get a registration token from the repository or organization under **Settings › Actions › Runners › New self-hosted runner**, or from the API, then configure:

```bash
./config.sh \
  --url https://github.com/acme \
  --token "$REGISTRATION_TOKEN" \
  --name build-01 \
  --labels build,docker \
  --unattended
```

The registration token expires after an hour and is only used once. The runner then authenticates with its own credentials stored in the install folder.

Install it as a systemd service so it survives reboots. This step needs root, so exit back to your admin user:

```bash
exit
cd /home/runner/actions-runner
sudo ./svc.sh install runner
sudo ./svc.sh start
```

The runner appears as **Idle** in the settings page. Push a workflow that uses `runs-on: [self-hosted, build]` to test it.

## Persistent vs ephemeral runners

A runner installed as above is **persistent**: it runs job after job on the same filesystem. That gives you warm caches, and it also means one job can leave files, processes or credentials behind for the next.

An **ephemeral** runner takes exactly one job and then unregisters. Combined with a fresh container or VM per runner, every job starts clean.

```bash
./config.sh --url https://github.com/acme --token "$REGISTRATION_TOKEN" \
  --ephemeral --labels build --unattended
./run.sh
```

For anything that runs code from more than one team, prefer ephemeral runners. Use a remote cache (a registry for Docker layers, an object store for dependencies) to get the speed back.

### Run ephemeral runners in Docker

A simple pattern: a container that registers with `--ephemeral`, runs one job, exits, and is restarted fresh by its supervisor. Registration tokens should come from a short-lived source, such as a GitHub App that calls the API:

```bash
# Org-level registration token, via a GitHub App installation token
curl -fsS -X POST \
  -H "Authorization: Bearer $INSTALLATION_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/orgs/acme/actions/runners/registration-token \
  | jq -r .token
```

GitHub also offers just-in-time runner configs (`POST /orgs/{org}/actions/runners/generate-jitconfig`), which return a single-use config for one ephemeral runner and skip the separate `config.sh` step.

Most container jobs need Docker. Avoid mounting the host's Docker socket into the runner container: any job could then start a privileged container and own the host. Use rootless Docker or a rootless BuildKit inside the runner, or give each runner its own small VM.

## Scale runners automatically

A fixed pool sits idle at night and queues during the day. Options to scale it:

- **Actions Runner Controller (ARC)**: GitHub's supported Kubernetes operator. It creates ephemeral runner pods from scale sets, based on queued jobs.
- **Terraform modules for cloud VMs**: community projects start an ephemeral VM per job on AWS and similar clouds, triggered by the `workflow_job` webhook.
- **Your own small controller**: listen for `workflow_job` webhooks with `action: queued`, start a container or VM with a JIT config, and let it exit when the job ends.

If you do not run Kubernetes, the webhook-driven approach is usually the least infrastructure for the result.

## Security rules for self-hosted runners

These are the ones that matter in practice:

1. **No self-hosted runners on public repositories.** Fork pull requests can run arbitrary code.
2. **Use runner groups** to restrict which repositories can target which runners. A runner with production network access should not be reachable from every repo.
3. **Prefer ephemeral runners** so a compromised job cannot persist.
4. **Run as an unprivileged user**, without passwordless `sudo`, and without the host Docker socket.
5. **Keep secrets off the machine.** Use OIDC to get short-lived cloud credentials per job instead of long-lived keys in files.
6. **Isolate the network.** Runners need outbound HTTPS to GitHub and your registries. Block everything else they do not need, especially your production servers' admin ports.
7. **Keep the agent updated.** The runner updates itself by default. GitHub stops sending jobs to versions that fall too far behind.
8. **Separate build from deploy.** A runner that can reach production should only run deploy jobs, gated by environment approvals.

The last rule is where a lot of setups go wrong: the same box builds untrusted pull request code and holds SSH keys to production. For broader container hardening, see [container security best practices](/blog/container-security-best-practices/).

## Where the runner should not live

Do not install runners on the servers that run your production apps. A heavy build steals CPU and memory from live traffic, and a malicious job lands next to your data. Give runners their own machines, or at least their own VM.

## Do you need runners to build images at all?

Many teams add self-hosted runners for one reason: Docker builds are slow on fresh hosted machines. If your deploy target already builds images, there may be a simpler path.

LogiStack builds images itself on push, with a rootless BuildKit that keeps its layer cache in a volume between deployments. Builds run as a separate service on your servers, and the result is pushed to your registry with an immutable tag. You keep GitHub Actions for tests on hosted runners, and turn on **Wait for CI checks to pass** so a deploy only starts once those checks succeed. See [build types](/docs/deploy/build-types/) and [Git webhooks and deploys from CI](/docs/automation/git-webhooks/).

For arm64 images, LogiStack can build both architectures into one image, natively or through QEMU set up from the dashboard. The details are in [multi-arch Docker images](/blog/multi-arch-docker-images/).

If your workflows do more than build and deploy, such as integration tests against private services or GPU jobs, self-hosted runners remain the right tool.

## Troubleshooting

- **Jobs stay queued.** No idle runner has all the labels in `runs-on`, or the runner group does not include that repository.
- **The runner shows Offline.** Check `sudo ./svc.sh status` and the logs under `_diag/`. Outbound HTTPS to GitHub may be blocked.
- **Disk fills up.** Persistent runners accumulate work directories, Docker images and build cache. Prune on a schedule, or switch to ephemeral runners.
- **Different results than hosted runners.** Hosted images ship many preinstalled tools. Install what you need explicitly, or use container jobs with a known image.

## FAQ

### Are self-hosted GitHub Actions runners free?

You pay for the machines. GitHub's billing terms for self-hosted runner usage have been revised over time, so check the current GitHub Actions billing documentation before you plan around it.

### Can I run a self-hosted runner in Docker?

Yes. Run the agent in a container with `--ephemeral` so each container takes one job. Avoid mounting the host's Docker socket; use rootless Docker or BuildKit inside, or a VM per runner.

### How many jobs can one runner handle?

One at a time. To run jobs in parallel, run several runner instances, each in its own folder or container, on the same or different machines.

### Do self-hosted runners work with private networks?

Yes, and that is a main reason to use them. The runner only needs outbound HTTPS to GitHub, so it can sit inside a private network and reach internal services.

### Should I use Actions Runner Controller?

If you already run Kubernetes, yes. It is the supported way to autoscale ephemeral runners. Without Kubernetes, a small webhook-driven controller or a fixed pool of VMs is less to operate.

Runners are one way to get faster builds on your own hardware; letting the deploy platform build is another. LogiStack builds with BuildKit on your servers, waits for your GitHub checks and rolls out without downtime. It is open source and free, so you can [install it](/#install) and compare build times against your current pipeline.

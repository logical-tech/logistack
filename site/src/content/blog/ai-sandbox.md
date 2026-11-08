---
title: "AI sandbox: how to let agents and AI code run safely"
description: "What an AI sandbox is, the isolation layers it needs, and how to build one with Docker, gVisor or microVMs so AI agents never touch production."
date: 2026-11-08
category: AI
keywords: ai sandbox, ai agent sandbox, sandbox for ai generated code, isolated environment for ai agents, code execution sandbox
---

Your coding agent just asked to run `npm install` on a package you have never heard of. An internal chatbot can call tools that write to a database. A teammate built a whole app in an afternoon with an AI assistant and wants to put it online today. In each case, code you did not fully read is about to run with some level of access to your systems. An AI sandbox is the answer: an isolated environment where AI agents and AI-generated code can run, fail and misbehave without reaching production data, credentials or the rest of your network. This guide explains what to isolate, the technologies that do it, and a practical setup for teams.

## What an AI sandbox is, and is not

The term covers two related things:

- **A code execution sandbox.** A throwaway environment where an agent runs commands or code it wrote: tests, scripts, package installs, data analysis. It exists for seconds or minutes.
- **A sandbox environment for AI-built apps.** A separate copy of your platform where an agent deploys, or where an app written with AI help runs, before anyone trusts it with real users or data. It exists for hours or days.

Both share one principle: **assume the code is wrong or hostile, and limit what it can reach**. A sandbox is not a policy document or a promise in a prompt. A model instructed "never touch production" can still be talked into it by a malicious README. Only isolation the code cannot change counts.

## Why teams need one now

- **Agents act, not just answer.** Coding agents run shell commands, install dependencies and call APIs. Each action is a chance to delete, leak or overspend.
- **Prompt injection is unsolved.** Any text the agent reads, from a web page, an issue or a dependency's docs, can carry instructions. The safe assumption is that, eventually, an agent will follow one.
- **Supply chain risk grows.** Agents suggest packages, and attackers publish packages with plausible names that models are likely to invent.
- **Shadow AI.** People already paste code from assistants into production. A sanctioned sandbox gives that energy somewhere safe to go. See our notes on [secure vibe coding](/blog/secure-vibe-coding/).

## The layers of an AI sandbox

Think in layers. Each one limits a different kind of damage.

| Layer | Question it answers | Typical control |
| --- | --- | --- |
| Compute isolation | Can the code escape to the host? | Container, gVisor, microVM |
| Network | Who can the code talk to? | No network, or egress allow list |
| Credentials | What can the code act as? | Scoped, short-lived keys; no production secrets |
| Filesystem | What can the code read and change? | Read-only root, a scratch volume, no host mounts |
| Resources | How much can it consume? | CPU, memory, process and time limits |
| Lifetime | How long does it exist? | Automatic teardown |
| Audit | What did it do? | Logs of commands and API calls |

### Compute isolation: how strong is strong enough

- **Standard containers** (Docker with runc) share the host kernel. With sensible flags they are a good boundary for code your own team's agents produce. They are not a strong boundary against a determined attacker who controls the code.
- **gVisor** intercepts system calls in a user-space kernel, so the container never talks to the host kernel directly. It is a drop-in Docker runtime (`runsc`) with some performance and compatibility cost.
- **MicroVMs** such as Firecracker or Kata Containers give each sandbox its own kernel with near-container startup times. This is what hosted code-execution sandboxes and multi-tenant platforms tend to use.

Match strength to who writes the code. Your agent on your repository: hardened containers. Arbitrary code from your app's users, run by an AI feature: gVisor or microVMs.

### A hardened Docker sandbox

For an agent's code execution, the flags matter more than the image:

```bash
docker run --rm -it \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,size=256m \
  -v "$PWD/workspace":/workspace:rw \
  -w /workspace \
  --user 1000:1000 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --memory 1g --cpus 1 --pids-limit 256 \
  python:3.12-slim python script.py
```

What each line buys you: no network at all, an immutable root filesystem, a small writable scratch area, a non-root user, no Linux capabilities, no privilege escalation, and hard limits on memory, CPU and process count so a fork bomb or runaway loop dies alone.

To add gVisor, install it on the host and add `--runtime=runsc`. When the agent genuinely needs the network, for example to install packages, use a proxy that allows only your package registry instead of opening everything.

Never mount the Docker socket into a sandbox. Access to it is root on the host.

### Credentials: the layer most people skip

The most damaging thing an agent can do usually needs no exploit, only a key. Rules that hold up:

- **No production secrets in the sandbox.** Use separate test databases and test API keys.
- **One key per agent, scoped and expiring.** The key can deploy to staging and nothing else, and stops working on Friday.
- **Destructive actions need a human.** Delete, stop, restore and rollback should require explicit approval, enforced by the API, not by the prompt.

### Lifetime and audit

Sandboxes accumulate. Give every one a time to live, and delete it with its volumes and databases when it expires. Keep a record of every command and API call, tied to the agent's identity, so you can answer "what did it change" in a minute.

## Types of AI sandbox setups

| Setup | Isolation | Good for | Limits |
| --- | --- | --- | --- |
| Local dev container | Container on a laptop | One developer's agent running tests | Shares the laptop's network and often its credentials |
| Hosted code sandbox (microVM-based services such as E2B) | MicroVM per session | Running untrusted code from an AI feature in your product | Per-use cost, data leaves your infrastructure |
| Self-hosted runner pool with gVisor or Kata | Strong, on your servers | Multi-tenant code execution you control | You build and operate it |
| Separate staging environment on your platform | Network and credential separation | Agents that deploy, AI-built apps before launch | Ordinary containers, not for hostile code |

Most teams need two of these: a code execution sandbox for the agent's commands, and a separate deployment environment for what the agent builds.

## Using LogiStack as the deployment half of an AI sandbox

LogiStack is an open-source self-hosted PaaS on Docker Swarm. It runs services as ordinary Docker containers, so it is not a microVM sandbox for hostile code. Where it fits is the second half: a place where agents deploy, and AI-built apps run, separated from production by network, credentials and permissions.

- **Isolated environments.** Each environment in a project has its own private network, variables, volumes and databases. Services in a sandbox environment cannot reach the production database. Duplicating production copies configuration, never data. See [environments](/docs/deploy/environments/).
- **Throwaway previews.** A pull request gets its own environment and URL, removed when the pull request closes or after a set number of hours without activity, with its volumes and databases. See [preview environments](/docs/deploy/preview-environments/).
- **Scoped, expiring keys for agents.** Give an agent an API key limited to one environment or project, with a role such as `developer` or `viewer` and an expiry. A key never does more than its owner. See [API keys](/docs/team/api-keys/).
- **Approval for destructive actions.** Through the [MCP server](/docs/automation/mcp-server/), every delete, stop, restore and rollback is refused unless the call carries `confirm: true`, and the server tells the agent to ask you first.
- **An audit trail.** Every write is recorded with its actor, so you can filter the [audit log](/docs/team/audit-log/) by the agent's key and see exactly what it changed.
- **Resource limits and alerts.** CPU and memory limits per service, plus thresholds that notify you when a sandboxed app runs hot.
- **Access rules.** Put a password, an IP allow list or a sign-in gateway in front of a sandbox app's domain so only your team can open it.

A workable policy for a team, written into the repository's `AGENTS.md`:

```md
## Deployment rules for agents

- Work in the `sandbox` environment of the `storefront` project only.
- Use the API key in LOGISTACK_API_KEY. It is scoped to that environment and expires weekly.
- Never set `confirm: true` on a destructive tool without asking me in this conversation.
- Never print or commit secret values.
- After a deploy, poll the deployment until it is healthy or failed, and report the error on failure.
```

Pair that with a hardened container or gVisor runner for the agent's local commands, and you have both halves: the agent can experiment freely, and the worst case is a broken sandbox environment you delete.

## FAQ

### What is an AI sandbox?

An AI sandbox is an isolated environment where AI agents and AI-generated code run without access to production systems, real data or broad credentials. It combines compute isolation, network limits, scoped credentials, resource caps, automatic teardown and an audit trail.

### Is a Docker container a secure sandbox for AI code?

A hardened container (no network, read-only filesystem, non-root user, no capabilities, resource limits) is a reasonable boundary for code your own agents write. For untrusted code from users or the internet, add gVisor or use microVMs such as Firecracker, because standard containers share the host kernel.

### How do I stop an AI agent from deleting production data?

Do not give it credentials that can. Use a separate environment with its own database, give the agent a key scoped to that environment with an expiry, and require human approval for destructive actions at the API level. Review the audit log for anything it changed.

### How long should an AI sandbox live?

As short as the task. Code execution sandboxes should last a session. Deployment sandboxes and previews should be removed automatically after a period of inactivity, together with their volumes and databases, so forgotten copies do not pile up.

If your agents already deploy code, give them a place where mistakes are cheap. [Install LogiStack](/#install), create a sandbox environment, and hand your agent a scoped key for it. The [features page](/features/) lists the rest of what comes in the same install.

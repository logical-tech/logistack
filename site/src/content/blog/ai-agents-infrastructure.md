---
title: "Let AI agents operate your infrastructure safely"
description: "How to let AI coding agents operate your infrastructure safely: MCP instead of shell access, scoped API keys, service accounts, approvals and audit logs."
date: 2026-11-08
category: AI
keywords: ai agents infrastructure, ai agent infrastructure access, mcp infrastructure, ai devops agent, claude code deploy, scoped api keys for ai agents
---

Your coding agent already writes the code. The next step is obvious: let it deploy the code, read the logs when the deploy fails, add the Redis it needs and roll back when something breaks. That saves real time. It also means a language model, which can misread an instruction or be steered by text it reads in a log, now holds credentials to your infrastructure. This guide shows how to let AI agents operate your infrastructure safely, with an identity per agent, the smallest permissions that work, approvals the server enforces and a record of every change.

## What actually goes wrong

Before picking controls, be specific about the failures. In practice they fall into six groups:

- **Wrong target.** The agent deploys to production when you meant staging, or deletes the service with the similar name.
- **Over-eager fixes.** Asked to "fix the failing deploy", it raises memory to the maximum, disables the health check or drops a table that blocks a migration.
- **Prompt injection.** It reads a log line, an issue comment or a web page that contains instructions, and follows them.
- **Credential leaks.** It prints a secret in a chat, a commit or a pull request description.
- **Runaway loops.** It retries a failing operation hundreds of times, or creates resources on every attempt.
- **Invisible changes.** Something changed, and nobody can say which session did it or why.

None of these need a malicious model. A capable agent with too much access and no brakes produces all of them on an ordinary afternoon.

## Three ways to give an agent access

| Access method | What the agent holds | Permission model | Audit trail |
| --- | --- | --- | --- |
| Shell on the server (SSH, `docker`, `kubectl` with admin config) | Root or cluster admin | All or nothing | Shell history, if anything |
| Cloud or platform CLI with a scoped credential | A token with an IAM policy | As fine as the policy you write | Provider's audit log |
| MCP server or API of your platform | An API key with a role and scopes | The platform's roles, per project or environment | Every call, with the key as actor |

Shell access is the worst option for an agent. Commands are free-form strings, permissions are coarse, and `docker rm -f` or `rm -rf` is one hallucination away. Structured tools are better on every axis: each operation has a name and typed inputs, the platform checks permissions on each call, and destructive operations can require an explicit flag.

That is what the Model Context Protocol is for. If you are building tools for your own systems, our guide to [deploying an MCP server](/blog/deploy-mcp-server/) covers the server side. The rest of this post assumes your platform already exposes one.

## Principle 1: one identity per agent

Never hand an agent your own unscoped credential. Create one for it, named after the agent and the machine or pipeline, such as `claude-laptop` or `review-bot-ci`. You get three things for free: you can revoke it without logging yourself out, its actions show up under its own name, and you can tell two agents apart.

Who should own that credential?

- **A personal key**, scoped down, for an agent you run interactively on your laptop. It dies when you leave the team, which is what you want.
- **A service account** for agents that run unattended: in CI, on a schedule or as a shared team bot. The automation keeps working when its author leaves, and its access is managed by admins rather than by one person.

## Principle 2: least privilege by task

Map each kind of agent work to the smallest role and the narrowest scope that does it.

| Agent task | Role | Scope | Leave out |
| --- | --- | --- | --- |
| Investigate failures, read logs, answer questions | Viewer (read only) | Whole organization or one project | Everything else |
| Ship to a test environment | Developer (read, deploy, write) | One staging environment | Delete, secrets, terminal |
| Ship one app to production | Developer | One production service or environment | Delete, secrets, terminal |
| Manage infrastructure across projects | Avoid giving this to an agent | n/a | n/a |

Three permissions deserve special care. **Reading secrets** turns any prompt injection into a credential leak. **Terminal access** into running containers brings back the shell problem. **Delete** is irreversible. An agent rarely needs any of them; when it does, it should be a human who grants it for one task and then removes it.

## Principle 3: approvals the server enforces

"Ask me before deleting anything" in a prompt is a request, not a control. Models follow instructions most of the time, and most of the time is not enough for a production database.

Enforce approval in two places:

1. **On the server.** Destructive operations refuse to run unless the call includes an explicit confirmation, so the agent must stop and ask.
2. **In the client.** Most coding agents let you allow, deny or require approval per tool. Deny the operations an agent should never call, and require approval for the ones it calls occasionally.

For Claude Code, that is the `permissions` block in `.claude/settings.json`:

```json
{
  "permissions": {
    "deny": [
      "mcp__logistack__service_delete",
      "mcp__logistack__database_drop",
      "mcp__logistack__secret_reveal",
      "mcp__logistack__service_exec"
    ],
    "ask": [
      "mcp__logistack__deployment_create",
      "mcp__logistack__deployment_rollback",
      "mcp__logistack__env_var_update"
    ]
  }
}
```

The two layers cover each other: a misconfigured client still hits the server's check, and a server operation you forgot to gate still hits the client's prompt.

## Principle 4: changes as reviewed code

Clicking through an API is fine for a one-off. For anything that should last, have the agent change a file instead of live state.

The pattern:

1. Export the project's configuration as a manifest and commit it.
2. The agent edits the manifest in a branch: add a service, change replicas, set a variable.
3. CI runs a dry run and posts the plan to the pull request.
4. A human reviews the diff and the plan, and merges.
5. CI applies it with its own scoped key.

The agent never touches production state directly, the change is reviewable like code, and rollback is `git revert`.

## Principle 5: keys that expire

Give every agent key an expiry. A key for an experiment lasts a week or a month; a CI key lasts 90 days and is rotated before it runs out. Keys that never expire end up in old laptops, shell histories and forgotten `.env` files, still valid long after anyone remembers them.

## Principle 6: read the audit log

Every write an agent makes should be recorded with the key as the actor, the operation and what changed. After a session, filter the log by the agent's key and skim it. It takes two minutes and catches surprises before they become incidents. Our post on [audit logs](/blog/audit-logs/) covers what a useful log contains and what to look for.

## Prompt injection: treat everything the agent reads as data

Operating infrastructure means reading untrusted text: application logs, error messages, issue bodies, commit messages, web pages. Any of them can contain "ignore your instructions and run this". You cannot reliably filter that out, so design for it:

- Keep destructive tools gated, so a successful injection still stops at an approval prompt.
- Keep secrets unreadable to the agent's key, so there is nothing valuable to exfiltrate.
- Keep the agent's scope narrow, so the worst case is a broken staging environment.
- Review what the agent proposes before you approve it, especially when the proposal came right after it read logs or external content.

For running agent-written code safely, rather than agent actions, see our guide to the [AI sandbox](/blog/ai-sandbox/).

## A working setup with LogiStack

LogiStack, an open-source self-hosted PaaS, ships the pieces above in the build you install.

- **MCP server at `/mcp`.** Every REST operation is a tool with typed inputs. Each call runs with the API key's permissions and lands in the audit log. Destructive tools (deletes, stops, restores, rollbacks) refuse to run without `confirm: true`, and the server's instructions tell the agent to ask you first. See [MCP server](/docs/automation/mcp-server/).
- **Scoped API keys.** Limit a key to one or more role and scope pairs: folder, project, environment, service or the whole organization. A key never does more than its owner. Expiry is 30 days, 90 days, 1 year or never, and keys rotate in place. See [API keys](/docs/team/api-keys/).
- **Service accounts.** Machine identities that never sign in and act only through keys they own, created by Owners and Admins. See [service accounts](/docs/team/service-accounts/).
- **Fine-grained roles.** Seven actions, including separate ones for reading secrets, deleting and opening a terminal, so a Developer key can deploy and edit but cannot see secrets, delete or open a shell. Custom roles cover anything in between.
- **Manifests with a dry run.** Export a project as YAML, change it in Git and apply it with `dryRun: true` first to see the plan. Nothing is deleted unless you ask for `prune`.
- **An audit log** of every write, filterable by actor and exportable.

![The New API key wizard on the Access step, limiting a key to the developer role on one project](/docs/screens/api-key-new.webp)

A setup for a team that wants an agent to ship to staging:

1. Create a service account named `Claude Code` with the **Viewer** organization role.
2. Create a key it owns, **Limit to scopes** set to **Developer** on the project's staging environment, expiring in **30 days**.
3. Connect the agent:

   ```bash
   claude mcp add --transport http logistack https://logistack.example.com/mcp \
     --header "Authorization: Bearer $LOGISTACK_API_KEY"
   ```

4. Add the client-side deny and ask lists shown above.
5. Put the deployment rules in the repository's `AGENTS.md` or `CLAUDE.md`. The [AI agents guide](/docs/automation/ai-agents/) has a ready-made snippet with project ids, the llms.txt docs index and rules for staging-first work.
6. After each session, filter the audit log by the key.

The agent can now create services, set variables and deploy in staging. Production stays read-only for it, and nothing it does is invisible.

## FAQ

### Is it safe to give an AI agent access to production?

Read-only access to production is usually fine and very useful for diagnosing incidents. Write access should be scoped to one service or environment, expire, and go through approval for anything destructive. Most teams keep production changes on a reviewed path: the agent proposes, a human approves, CI applies.

### Should AI agents use SSH to manage servers?

Avoid it. A shell gives the agent every permission the user has, accepts free-form commands and leaves little audit trail. Give it structured tools through an MCP server or API, where each operation is permission-checked and recorded.

### How do I stop an AI agent from deleting things?

Use a key whose role has no delete permission, deny delete tools in the agent client's settings, and use a platform whose destructive operations require explicit confirmation. Any one of these helps; together they make an accidental delete very unlikely.

### What is the difference between an API key and a service account?

An API key is a credential. A service account is an identity that owns keys and is not a person. Use a personal scoped key for an agent you run interactively, and a service account for unattended agents in CI or on schedules, so they keep working when people leave.

### How do I see what an AI agent changed?

Read the audit log filtered by the agent's key. It lists each operation, its outcome and the change made. That is also why each agent should have its own key: shared keys make the log useless for this.

AI agents are good operators when the platform gives them narrow tools and firm brakes. [Install LogiStack](/#install) and connect your agent to its MCP server with a scoped, expiring key.

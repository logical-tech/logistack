---
title: "Secure vibe coding: ship AI-built apps without leaking secrets"
description: "Secure vibe coding in practice: the security mistakes AI-generated apps make, guardrails for prompts and agents, and safe defaults for deploying them."
date: 2026-11-08
category: AI
keywords: secure vibe coding, vibe coding security, ai generated code security, ai coding agent security, deploy ai built app
---

You described an app to an AI assistant, accepted most of what it wrote, and had something working by dinner. Then you deployed it. The code runs, but nobody has read all of it, including you. That is the core problem secure vibe coding has to solve: AI makes it fast to produce software, and it makes the same handful of security mistakes again and again. This guide lists those mistakes, shows guardrails that catch them before deploy, and explains how to give an AI agent access to your infrastructure without handing it the keys to everything.

## What secure vibe coding means

Vibe coding is building software mostly by prompting an AI and steering the result, rather than writing each line yourself. Secure vibe coding keeps that speed but adds a few checkpoints:

- **Before you prompt**: tell the model your security rules.
- **While it writes**: keep secrets out of the code and out of the chat.
- **Before you merge**: review the risky parts and scan dependencies.
- **When you deploy**: use a platform with safe defaults and narrow permissions.
- **When the agent deploys for you**: scope its credentials and log what it does.

None of these slow you down much. Skipping them is what makes an AI-built app the easy target on the internet.

## The security mistakes AI-generated apps make most

Models learn from public code, and public code is full of tutorials that skip security for brevity. The same patterns show up in generated apps:

| Mistake | How it shows up | Fix |
| --- | --- | --- |
| Hardcoded secrets | `const stripe = new Stripe("sk_live_...")` in source | Read from environment variables injected at deploy time |
| Missing authorization | An API route checks that you're logged in, not that the record is yours | Check ownership on every read and write |
| Client-side checks only | Price or role validated in the browser | Validate again on the server |
| String-built queries | SQL assembled with template literals | Parameterized queries or the ORM's query builder |
| Wide-open CORS | `Access-Control-Allow-Origin: *` with credentials | Allow only your own origins |
| Debug mode in production | Stack traces and env dumps on error pages | Separate config per environment |
| Exposed admin tools | A database GUI or admin route with no login | Put it behind an access rule or remove it |
| Invented packages | An import of a package that doesn't exist, or a lookalike name | Verify every new dependency before installing |
| Secrets pasted into chat | An API key shared "so the AI can test it" | Use test keys and reference secrets by name |

The authorization mistake deserves extra attention. Generated code is good at "is the user signed in?" and bad at "may this user see this row?". That gap, often called insecure direct object reference, lets any signed-in user read anyone's data by changing an ID in the URL.

## Before you prompt: write your security rules down

Most coding assistants read a rules file from the repository, such as `AGENTS.md`, `CLAUDE.md` or `.cursorrules`. Put your non-negotiables there, so every session starts with them.

```markdown
## Security rules

- Never hardcode secrets, keys or passwords. Read them from environment variables.
- Never print, log or commit secret values. Never ask me to paste one into chat.
- Every API route that touches user data checks the current user owns the record.
- Use parameterized queries only. No string-built SQL.
- Validate all input on the server with a schema, even if the client validates too.
- Before adding a dependency, tell me its name, weekly downloads and repository URL.
- Do not disable TLS verification, CORS checks or CSRF protection to make an error go away.
```

Rules files aren't a guarantee, but they shift the model's defaults in the right direction and give you something to point at in review.

## Keep secrets out of the code and the chat

Secrets leak from AI-built apps in three ways: in the source, in the Git history and in the conversation itself.

**In the source.** Every secret comes from the environment. Commit a `.env.example` with names and fake values, never the real `.env`.

```bash
# .gitignore
.env
.env.*
!.env.example
```

**In Git history.** Run a secret scanner before every commit, so a key the AI inlined never reaches the remote.

```bash
gitleaks git --redact -v .
```

**In the chat.** Use test-mode keys while you build, and never paste production credentials into a prompt. If the agent needs a value at runtime, it should come from your deployment platform's secret store, referenced by name.

If a real key does leak, rotate it first and clean the history second. A key that has been pushed should be treated as public, whatever you do to the repository afterwards.

## Review what the AI wrote in ten minutes

You don't have to read every line. Read the lines where mistakes are expensive:

1. **Auth and permissions**: every route handler, middleware and policy check.
2. **Database access**: every query, especially ones built from request input.
3. **File and network access**: uploads, downloads, outbound requests built from user input.
4. **Config**: CORS, cookies, session settings, debug flags.
5. **New dependencies**: what was added to `package.json`, `requirements.txt` or `go.mod`.

Then let tools do the rest:

```bash
# Static analysis for common vulnerability patterns
semgrep scan --config auto

# Known vulnerabilities in dependencies
npm audit --omit=dev
```

You can also ask the model to review its own work with a specific frame: "List every route and say how it checks authorization. Flag any that don't." It's better at answering a narrow question than at volunteering problems.

## Check every dependency the AI adds

Models sometimes import packages that don't exist, or that exist under a slightly different name. Attackers register those names and wait. Before installing anything new:

```bash
npm view some-package name version time.created repository.url
```

A package created last week, with no repository and a name one letter off a popular one, is a red flag. Pin versions with a lockfile and install with `npm ci` in builds.

## Deploy with safe defaults

The deployment is where a small mistake becomes a public one. Whatever platform you use, check these before going live:

- **Secrets** are stored encrypted and injected at deploy time, not built into the image.
- **Databases** are reachable only from your app's internal network, with no published port.
- **Staging and previews** are behind a password or IP allowlist, not open to search engines.
- **The image** is scanned for known vulnerabilities, and rescanned later.
- **Admin routes and tools** sit behind an access rule at the proxy.

For the container side of this list, the [container security best practices](/blog/container-security-best-practices/) checklist goes into detail.

## When the AI agent deploys for you

Agents that can call your platform's API or MCP server can create services, change variables and deploy. That is useful, and it means the agent's credential is now a production credential. Treat it like one:

- **One key per agent and machine**, named after both, such as `claude-laptop`.
- **The smallest role that works**: read-only for an agent that investigates, deploy rights on one project for one that ships.
- **An expiry**, so a forgotten key stops working on its own.
- **A human approves destructive actions**: deletes, stops, restores and rollbacks.
- **An audit trail** of every call the agent makes, which you review after the session. See [audit logs](/blog/audit-logs/) for what to look for.

Keep the key out of the repository. If your MCP config is shared with the team, reference an environment variable instead of the value:

```json
{
  "mcpServers": {
    "logistack": {
      "type": "http",
      "url": "https://logistack.example.com/mcp",
      "headers": { "Authorization": "Bearer ${LOGISTACK_API_KEY}" }
    }
  }
}
```

## A secure vibe coding workflow on LogiStack

LogiStack is an open-source, self-hosted PaaS, and it covers most of the deploy-side checklist out of the box:

1. **Secrets.** On a service's **Environment** tab, the **Secret** toggle turns on by itself for names containing `PASSWORD`, `TOKEN`, `KEY` or `SECRET`, and the value is saved as an encrypted secret. Secrets are versioned, masked as `***` in build and deployment logs, and never appear in manifests or the API's variable lists. If your team uses Vault, Infisical or 1Password, reference them with `secret://` and LogiStack reads the value at deploy time without storing it. See [secrets and environment variables](/docs/deploy/environment-variables/) and [external secrets](/docs/deploy/external-secrets/).
2. **Previews and staging behind a gate.** Add an IP allowlist, a password or a sign-in gateway such as Authelia to a domain, checked by the Caddy proxy before the request reaches your app. See [access rules](/docs/networking/access-control/). Keep fork previews off for public repositories, because a fork's pull request runs with the preview's secrets.
3. **Databases stay internal.** A managed database has no public domain and is reachable only inside its environment.
4. **Image scanning.** Every deployed image is scanned with Trivy after deploy and daily, and a new critical CVE sends a notification.
5. **Agents with narrow keys.** Create an API key limited to one project with an expiry and connect your assistant to the MCP server at `/mcp`. Destructive tools refuse to run without `confirm: true`, and every call lands in the audit log under the key's name. See [MCP server](/docs/automation/mcp-server/) and [AI agents](/docs/automation/ai-agents/).

![The New API key wizard on the Access step, limiting a key to the developer role on one project](/docs/screens/api-key-new.webp)

What LogiStack doesn't do: it doesn't review your code, scan your Git history for secrets or check your dependencies before install. Keep the rules file, the ten-minute review and a secret scanner in your own workflow.

## FAQ

### Is vibe coding safe for production apps?

It can be, if you add review and guardrails. The risk isn't that AI writes worse code than people; it's that nobody reads it. Review the security-sensitive parts, scan dependencies and secrets, and deploy with least-privilege defaults, and an AI-built app can be as safe as a hand-written one.

### Should I give my AI coding agent production access?

Give it the least access that does the job. A read-only key on production lets it diagnose problems; deploy rights are better limited to staging. If it must deploy to production, scope the key to one project, set an expiry and keep destructive actions behind your approval.

### What should I do if the AI committed a secret?

Rotate the secret immediately, before anything else. Then remove it from the code, move it to your platform's secret store, and clean the Git history if the repository is private. If the repository was ever public, assume the secret was copied.

### Do AI assistants follow security rules files?

Mostly, and better when the rules are short, specific and testable. They can still slip, especially in long sessions. Treat the rules file as a default-setter and keep the review step.

Vibe coding is here to stay; the goal is to make the fast path also the safe one. To deploy AI-built apps with secrets, access rules, image scanning and scoped agent keys already in place, [install LogiStack](/#install) on a server you own.

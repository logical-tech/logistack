---
title: "Audit logs: what to record, how to review them, and why"
description: "What audit logs are, what every entry should record, how to review them for incidents and compliance, and how to audit people, CI and AI agents alike."
date: 2026-11-08
category: Security
keywords: audit logs, audit trail, audit log best practices, infrastructure audit log, change log for deployments
---

A production domain disappears at 02:14. The site is down, the team is awake, and the first question in the chat isn't how to fix it. It's "who did this?" Without audit logs, the answer is a round of guesses and a scroll through shell history on three machines. With them, it's one filter: action `domain.delete`, last 24 hours. This guide covers what an audit log should record, how it differs from the other logs you already keep, how to review it, and how to make it useful when the actor is a CI pipeline or an AI agent rather than a person.

## What an audit log is, and what it isn't

An audit log is a record of actions taken on a system: who did what, to which resource, when, and whether it worked. It is written for people asking questions after the fact, so its entries are structured and stable rather than free text.

It's easy to confuse with the logs you already have:

| Log | Answers | Written by | Example |
| --- | --- | --- | --- |
| Application log | What is my code doing? | Your app | `payment processed in 230ms` |
| Access log | Who requested what over HTTP? | The proxy | `GET /api/orders 200` |
| Build and deploy log | What happened during this release? | The CI or platform | `pushing image ... done` |
| Audit log | Who changed what, and was it allowed? | The control plane | `env_var.update by ana@acme, success` |

Application and access logs are high volume and short lived. Audit logs are low volume, and each entry may matter months later.

## What every audit log entry should record

A useful entry answers six questions without anyone having to cross-reference another system.

- **Who**: the actor's ID and display name, and the kind of actor: a person, an API key, a service account, or the system itself.
- **What**: the action, in a consistent form such as `resource.verb` (`deployment.create`, `member.update`).
- **On what**: the resource type and its ID.
- **When**: a precise timestamp with a time zone.
- **From where**: the client IP, user agent and a request ID that ties the entry to other logs.
- **With what result**: success, denied (no permission) or error (allowed but failed), and for changes, the before and after values.

Here is what that looks like in practice:

```json
{
  "at": "2026-11-07T02:14:09Z",
  "actor": { "kind": "api_key", "id": "key_7f2c", "name": "ci-deploy" },
  "action": "domain.delete",
  "resource": { "type": "domain", "id": "dom_shop_example" },
  "outcome": "success",
  "ip": "203.0.113.42",
  "userAgent": "curl/8.5.0",
  "requestId": "req_01JC8Q4M2V"
}
```

One rule overrides everything else: **secret values never go in the audit log.** Record that `STRIPE_KEY` changed, from version 3 to version 4, by whom. Never record the key itself. An audit log full of credentials becomes the most valuable file to steal.

## Why audit logs matter

### Incident response

When something breaks after a change, the audit log turns "what changed?" from a guess into a query. You see the exact change, its author and its time, and you can line it up against your metrics and the [deployment history](/blog/zero-downtime-deployments/).

### Spotting someone probing for access

Denied entries are the most underrated part of an audit log. One denied action is usually a confused colleague. A burst of denied actions from one key or one IP, across many resources, is someone testing what a stolen credential can do.

### Compliance evidence

Security frameworks and customer questionnaires commonly ask for evidence of change control and access review. An exportable audit log with actor, action, time and outcome is the evidence they want. Without one, you are reconstructing it from memory.

### Accountability for automation

More changes now come from machines: CI pipelines, scheduled jobs, AI coding agents. If they share a human's credentials, the log says a person did something they never touched. Give each machine its own identity, and the log tells you exactly what the automation did.

## Which events to audit on an infrastructure platform

On a deployment platform, almost every write matters, but these deserve the closest attention:

| Event | Why it matters |
| --- | --- |
| Deployments and rollbacks | The most common cause of incidents |
| Environment variable and secret changes | Config drift and credential misuse |
| Secret reveals | Someone read a credential in plain text |
| Member, role and grant changes | Privilege escalation |
| API key creation, rotation and revocation | New long-lived access |
| Terminal sessions in containers | Direct access to running workloads |
| Domain, DNS and access rule changes | Traffic hijack or exposure |
| Deletes of any kind | Irreversible changes |

Reads are usually not worth logging individually, with one exception: reading a secret's value. That is a read with consequences.

## Audit log best practices

1. **Log denied and failed attempts, not only successes.** The failures tell you about misconfigured automation and about attackers.
2. **Redact secrets before writing**, not when displaying. A redacted view on top of a raw store is still a raw store.
3. **Distinguish actor kinds.** "Person", "API key", "service account" and "system" need different follow-ups.
4. **Restrict who can read it.** The log reveals your structure and your team's habits. Limit it to admins.
5. **Export it regularly** to storage the platform's admins can't edit, such as an object storage bucket with versioning or object lock. That protects it from both accidents and cover-ups.
6. **Keep it as long as your obligations require.** Decide a retention period deliberately, and export older entries before they age out.
7. **Review it on a schedule.** A log nobody reads only helps after the damage is done.

## How to review an audit log in 15 minutes a week

A short, regular routine catches more than an annual deep dive.

1. **Filter on denied outcomes for the last 7 days.** Explain every cluster.
2. **Filter on role, member and API key actions.** Every new admin and every new unscoped key should be expected.
3. **Filter on secret reveals.** Each should map to a reason someone can name.
4. **Look at your automation's keys.** Check that CI and agents only touched what they are meant to touch.
5. **Skim deletes.** Anything irreversible deserves a second look.

## Auditing AI agents

AI agents that deploy, edit config or query databases are just another actor, but they act fast and in volume. Three habits keep them auditable:

- Give each agent and machine its own API key, named after both, such as `claude-laptop`.
- Scope that key to the projects it works on and set an expiry.
- Review its actions by filtering the audit log on that key after each session.

The post on [secure vibe coding](/blog/secure-vibe-coding/) covers the rest of the guardrails for AI-assisted work.

## Audit logs in LogiStack

LogiStack, the open-source self-hosted PaaS, records every change made in an organization, whether through the dashboard, the REST API or the MCP server. Each entry shows when, the actor and its kind (**Person**, **API key**, **Service account** or **System**), the action as `resource.verb`, the resource, the outcome (**Success**, **Denied** or **Error**) and the IP. The details add the user agent, request ID and, for updates, **Before** and **After** values. Secret values are redacted before the entry is written, and every secret reveal is itself recorded as `secret.reveal`.

![The Audit log page with filters for time range, actor, action, resource and outcome, and entries such as deployment.create by an API key and a denied service.delete](/docs/screens/settings-audit-log.webp)

You filter by time range, actor, action, resource and outcome. Filters live in the URL, so a saved view like "denied in the last 30 days" is a bookmark. Viewing the log needs the **Administer** action on the organization, which Owners and Admins have. The audit log is included in the free, open-source build; nothing sits behind a paid tier.

Export goes to CSV or JSON from the page, up to 10,000 entries per export, or through the API. A nightly cron job that copies the previous day to storage your admins can't modify looks like this:

```bash
#!/usr/bin/env bash
set -euo pipefail
FROM="$(date -u -d 'yesterday 00:00' +%Y-%m-%dT%H:%M:%SZ)"
TO="$(date -u -d 'today 00:00' +%Y-%m-%dT%H:%M:%SZ)"
curl -fsSG https://stack.example.com/api/audit-log/export \
  -H "Authorization: Bearer $LOGISTACK_KEY" \
  --data-urlencode "format=json" \
  --data-urlencode "from=$FROM" \
  --data-urlencode "to=$TO" \
  -o "audit-$(date -u -d yesterday +%F).json"
```

Use a dedicated [API key](/docs/team/api-keys/) for this job, and upload the file to a versioned bucket. The full reference is in the [audit log docs](/docs/team/audit-log/), and the roles that decide who can do what are in [roles and permissions](/docs/team/roles-and-permissions/).

## FAQ

### What is the difference between an audit log and an audit trail?

The terms are mostly used interchangeably. Some people use "audit trail" for the full chain of evidence around a change, such as the log entry plus the commit and the ticket, and "audit log" for the system's own records. In practice, both mean a reliable record of who did what and when.

### How long should I keep audit logs?

As long as your contracts, regulations or internal policies require, and at least long enough to investigate an incident discovered late. Many teams choose one year as a baseline. Export entries to cheap storage so retention doesn't depend on the platform's database.

### Should audit logs record read actions?

Usually not, because reads are high volume and low risk. The exceptions are reads of sensitive data, such as revealing a secret or exporting a database, which should be logged like writes.

### Can an admin delete audit log entries?

They shouldn't be able to, but a determined admin with server access can tamper with almost anything stored locally. That is why exporting to storage with versioning or object lock, owned by a different account, matters for audit logs you may need to rely on.

Audit logs are cheap to keep and expensive to wish you had. If you want one that records people, CI and AI agents in the same place with secrets redacted, [install LogiStack](/#install) and open **Settings › Audit log** after your first deploy.

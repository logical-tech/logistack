---
title: "Self-host Mattermost: an open-source Slack alternative"
description: "Self-host Mattermost as a Slack alternative: deploy it with Postgres, set up email and mobile push, import from Slack, and keep chat history on your servers."
date: 2026-11-08
category: Self-hosting
keywords: self-host mattermost, mattermost docker, slack alternative, open source slack alternative, self-hosted team chat
---

Slack works until it doesn't: the free plan hides older messages, the per-seat bill grows with every contractor, and your security team asks where years of chat history actually live. If you self-host Mattermost, you get channels, threads, DMs, file sharing and mobile apps on a server you control, with no message limit and no per-user price for the free edition. This guide covers deploying Mattermost as a Slack alternative, the settings you must change on day one, and what you give up compared with Slack.

## Why self-host a Slack alternative

Team chat is where decisions, incident timelines and credentials (despite everyone's best intentions) end up. That makes it a good candidate to keep in-house:

- **Data residency.** Messages and files stay on your servers, in a database you can back up and audit.
- **Cost shape.** You pay for a server, not per seat. Guests and contractors cost nothing extra.
- **No history cliff.** Every message stays searchable for as long as you keep it.
- **Air-gapped or regulated environments.** Mattermost runs fully offline, which hosted chat cannot.

The trade-off is real: you run it. Upgrades, backups and uptime are your job. For a five-person team that lives in Slack Connect channels with customers, Slack is still easier. For a company that wants control over its chat, Mattermost is the most Slack-like open-source option.

## Mattermost vs. Slack and other open-source chat

| Tool | Hosting | License | Strength | Weak spot |
| --- | --- | --- | --- | --- |
| Slack | SaaS only | Proprietary | Integrations, Slack Connect, polish | Per-seat price, data on Slack's servers |
| Mattermost Team Edition | Self-hosted or cloud | Open source | Closest to Slack's UX, strong DevOps integrations | Some admin features are in paid editions |
| Rocket.Chat | Self-hosted or cloud | Open source (MIT core) | Omnichannel (live chat, WhatsApp) | Heavier, uses MongoDB |
| Matrix (Synapse + Element) | Self-hosted or federated | AGPL-3.0 (Synapse) | Federation, end-to-end encryption | More moving parts, different UX |
| Zulip | Self-hosted or cloud | Apache-2.0 | Topic-based threading | Workflow takes adjusting to |

LogiStack has templates for [Rocket.Chat](/templates/rocketchat/) and Synapse if federation or omnichannel matters more to you than a Slack-like feel.

Mattermost ships in editions. Team Edition is the free, open-source build and covers what most teams use daily: channels, threads, DMs, file uploads, search, webhooks, slash commands, bots and plugins. Features such as SAML single sign-on, advanced compliance exports and high availability clustering sit in the paid editions. Check Mattermost's edition comparison before you plan around a specific feature.

## What the Mattermost template deploys

The [Mattermost template](/templates/mattermost/) uses the `mattermost/mattermost-team-edition:release-10` image and a managed PostgreSQL 16 database.

| Service | Purpose | Volumes |
| --- | --- | --- |
| `mattermost` | The server and web app, on port 8065 | `config`, `data`, `logs`, `plugins`, `client/plugins`, `bleve-indexes` |
| `postgres` | Messages, users, channels | `postgresql-data` |

Each volume has a job. `data` holds uploaded files and attachments, `config` holds `config.json` (where System Console settings are saved), `plugins` holds server plugins, and `bleve-indexes` holds the search index. The template sets `MM_SERVICESETTINGS_SITEURL` from the domain you enter, which Mattermost needs for links, OAuth and mobile apps.

Inputs: the domain, a Postgres user, a generated Postgres password and a database name.

## Deploy Mattermost on your server

Install LogiStack on a fresh Ubuntu or Debian server if you have not:

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

Mattermost wants more memory than a lightweight app. Give the server at least 4 GB of RAM for a small team, and more as you add users and plugins.

1. Create a DNS A record such as `chat.example.com` pointing at your server.
2. In a project, select **New service** › **Templates**, search `mattermost` and open the card.
3. Check **What it creates**: two services and seven volumes.
4. On **Settings**, set the public URL to `chat.example.com`. Fill in the database name, for example `mattermost`.
5. Review and select **Deploy**.

Postgres starts first. Mattermost runs its database migrations on first boot, which can take a minute. Follow progress in the service's **Logs** tab. When it is healthy, open the URL. The [templates documentation](/docs/deploy/templates/) has screenshots of each step.

### Create the first admin

The first account you create becomes the system admin. Do it immediately after the deploy, before anyone else finds the URL. Then create a team and invite your colleagues by link or email.

## Configure Mattermost for real use

A fresh install works, but four settings in **System Console** make the difference between a demo and something your team relies on.

### Email (SMTP)

Without SMTP, invites, password resets and notification emails do not go out. Under **Environment** › **SMTP**, enter your provider's host, port and credentials. Any transactional email service works. Send a test email from the same page.

### Mobile push notifications

The iOS and Android apps connect straight to your server URL. Push notifications travel through a push proxy because only the app vendor can send to Apple and Google. Team Edition can use Mattermost's free test push notification service, which works but comes without delivery guarantees. Paid editions get the production push service, and you can also build and run your own proxy. Decide which you need before you roll out mobile.

### File storage

Uploads land in the `data` volume by default. That is fine for most teams. If you expect a lot of files, Mattermost can store them in S3-compatible storage instead, set under **Environment** › **File Storage**. A bucket on [self-hosted S3 storage](/blog/self-hosted-s3-storage/) works.

### Sign-in

Team Edition supports email login and GitLab OAuth. Turn off open sign-up under **Authentication** › **Signup** once your team has joined, so only invited people get accounts.

You can set any of these as environment variables instead of clicking. Mattermost reads `MM_<SECTION>_<SETTING>` names, for example `MM_EMAILSETTINGS_SMTPSERVER`. Add them on the `mattermost` service's **Environment** tab and deploy; values in environment variables override `config.json`. Mark passwords as secrets.

## Move your history from Slack

Mattermost can import a Slack workspace export. The flow:

1. Export your workspace from Slack's admin settings. What a standard export contains depends on your Slack plan; private channels and DMs need a higher plan.
2. Convert the export with Mattermost's `mmetl` tool into Mattermost's bulk import format.
3. Upload the result and run the import with `mmctl`.

You can run `mmctl` from the **Terminal** tab of the `mattermost` service, which opens a shell in the running container without SSH. Do a trial import into a separate environment first. Users, channels and messages carry over; Slack apps and workflows do not, and you rebuild those as Mattermost webhooks, slash commands or plugins.

## Backups and upgrades

Two things hold your team's history: the database and the uploaded files.

- **Database.** Open the `postgres` service, select **Backups** and create a daily policy to an S3 destination. Keep **Verify on a schedule** on, so a scheduled job proves the dump restores.
- **Files.** Add a second policy on the `mattermost` service for the `data` volume. Add one for `config` too, unless you keep all settings in environment variables.

The [backups guide](/docs/data/backups/) walks through destinations, retention and encryption.

Upgrades follow Mattermost's release cycle. The template tracks `release-10`. For a predictable upgrade, pin an exact version tag in the service settings, read the release notes, back up, then change the tag and deploy. LogiStack starts the new container and checks its health before stopping the old one, and you can roll back to the previous deployment from **Deployments** if something breaks. Database migrations do not roll back on their own, which is why the backup comes first.

## Route LogiStack alerts into Mattermost

Once Mattermost runs, put it to work on your infrastructure. LogiStack's notification channels include Mattermost: create an incoming webhook in Mattermost, add it as a channel under **Integrations** › **Notifications**, and send failed deployments, backup failures and node alerts to an `#ops` channel. The [alerts and notifications guide](/docs/operations/alerts-and-notifications/) shows how to scope rules per project.

## FAQ

### Is Mattermost free?

Team Edition is free and open source with no user limit. Mattermost sells paid editions with features such as SAML, compliance exports and high availability. Many teams run Team Edition for years without needing them.

### How many users can one Mattermost server handle?

A single server comfortably serves a small or medium company. The practical limits are database performance and memory, so watch the service metrics as you grow. Very large deployments use Mattermost's clustering, which is a paid feature.

### Do the Mattermost mobile apps work with a self-hosted server?

Yes. Install the official app and enter your server URL. Push notifications need a push proxy; Team Edition can use Mattermost's test service, and paid editions get the production one.

### Can Mattermost replace Slack integrations?

Most common ones, yes: incoming and outgoing webhooks, slash commands, bots and a plugin marketplace with GitHub, GitLab, Jira and more. Slack-specific workflows and apps have to be rebuilt.

### Should I self-host or use Mattermost Cloud?

Self-host when data control, cost per seat or offline operation matter. Use the vendor's cloud when nobody on your team wants to own backups and upgrades.

Mattermost gives your team a Slack-like chat on infrastructure you control. [Install LogiStack](/#install), deploy the template, and you have chat with HTTPS, daily verified backups and rolling upgrades. If your team is also moving other tools in-house, our overview of [self-hosted PaaS options](/blog/self-hosted-paas/) explains how to run them all from one place.

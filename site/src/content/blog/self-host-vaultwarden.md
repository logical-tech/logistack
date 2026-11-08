---
title: "Self-host Vaultwarden: a Bitwarden-compatible password server"
description: "Self-host Vaultwarden with Docker: deploy it behind HTTPS, close signups, secure the admin page, set up SMTP and keep encrypted backups of your vault."
date: 2026-11-08
category: Self-hosting
keywords: self-host vaultwarden, vaultwarden docker, vaultwarden setup, bitwarden self hosted, vaultwarden admin token, vaultwarden backup
---

You want a password manager for your family or small team, with the polished Bitwarden apps on every device, but with the vault on a server you control. The official Bitwarden server is built for organizations and runs a dozen containers. Vaultwarden is the light alternative: one small container that speaks the same API, so the official Bitwarden browser extensions, desktop and mobile apps work with it.

Self-hosting Vaultwarden is easy to start and easy to get wrong in ways that matter: open signups, an unprotected admin page, and no off-site backup. This guide covers a production setup of self-hosted Vaultwarden with Docker that avoids all three.

## Vaultwarden vs the official Bitwarden server

Vaultwarden is an unofficial, community-built server written in Rust, licensed AGPLv3. It is not affiliated with Bitwarden, Inc.

| | Vaultwarden | Bitwarden self-hosted |
| --- | --- | --- |
| Footprint | One container, very little RAM | Several containers, a SQL database |
| Database | SQLite by default; MySQL or PostgreSQL optional | Microsoft SQL Server (or the newer unified image with other databases) |
| Clients | Official Bitwarden apps and extensions | Official Bitwarden apps and extensions |
| Organizations, sharing, Send, TOTP, emergency access | Yes | Yes, some behind a paid license |
| Audits and support | Community project, no vendor support | Vendor-audited code, commercial support |

Vaultwarden is the better fit for families, homelabs and small teams that want everything without a license key. The official server is the better fit for companies that need vendor support, compliance paperwork and enterprise features like SCIM provisioning. Be honest with yourself about which group you are in.

One rule applies either way: the vault data is end-to-end encrypted by the clients with your master password. The server stores ciphertext. That protects you if the server is compromised, but it also means nobody can recover a vault if the master password is lost.

## Deploy Vaultwarden with Docker

Vaultwarden must run over HTTPS. The web vault relies on browser crypto APIs that only work in a secure context, and the apps refuse plain HTTP. Caddy handles that for you.

On a fresh server with ports 80 and 443 open:

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

Then:

1. Open a project, select **New service**, then the **Templates** tile.
2. Search for `vaultwarden` and select [Vaultwarden](/templates/vaultwarden/).
3. Enter your hostname in **Public URL**, for example `vault.example.com`.
4. Review and select **Deploy**, then point the DNS record at the server.

The template runs `vaultwarden/server` pinned to a release, listening on port 80 behind Caddy, with all data in a volume named `vaultwarden` at `/data`. It sets two variables:

```bash
DOMAIN=https://vault.example.com
SIGNUPS_ALLOWED=true
```

`DOMAIN` must match the public URL exactly. Vaultwarden uses it for links in emails, for WebAuthn and for attachment downloads. Real-time sync notifications to the apps go over a WebSocket on the same port, and Caddy proxies it with no extra config.

The general template flow is in [Deploy an app from a template](/docs/deploy/templates/), and domain setup in Add a domain to a service.

## Create your account, then close signups

The template allows signups so you can create the first account. Do that now:

1. Open `https://vault.example.com` and select **Create account**.
2. Pick a long master password you can remember. A passphrase of several random words works well.
3. Sign in and turn on two-step login under **Settings › Security**.

Then close registration. On the service's **Environment** tab, set:

```bash
SIGNUPS_ALLOWED=false
```

Select **Save and redeploy**. Anyone who found your URL can no longer create an account on your server.

To add family or team members afterwards, invite them from an organization, or from the admin page. Invitations need working email (see below). If you skip SMTP, keep `INVITATIONS_ALLOWED=true` (the default): invited users can then register even with signups closed.

Another option for a small group: leave signups open but limit them to your own email domain.

```bash
SIGNUPS_DOMAINS_WHITELIST=example.com
```

## Secure the admin page

Vaultwarden has an admin page at `/admin` for managing users, sending invitations, and changing most settings without a redeploy. It is disabled until you set `ADMIN_TOKEN`.

Do not use a plain-text token. Generate an Argon2 hash with the binary inside the container. Open the service's **Terminal** tab and run:

```bash
/vaultwarden hash --preset owasp
```

Type a strong password twice. Copy the resulting string, which starts with `$argon2id$`. Add it as `ADMIN_TOKEN` on the **Environment** tab, marked as secret, and redeploy. You then sign in to `/admin` with the password you typed, not the hash.

The admin page is a high-value target. Restrict it further:

- Put an [IP allowlist](/docs/networking/access-control/) on the domain if you always manage it from the same network. Note that the rule applies to the whole hostname, so it also blocks the apps from other networks. Use it only if all your devices connect from those networks, or through a VPN.
- Or remove `ADMIN_TOKEN` when you are done, which disables `/admin` again.

Settings saved from the admin page are written to `/data/config.json` and override environment variables. If a variable change seems to have no effect, check that file.

## Set up email

Email is optional but useful: account verification, invitations, new-device login alerts, and emergency access all need it. Configure SMTP with environment variables:

```bash
SMTP_HOST=smtp.example-provider.com
SMTP_FROM=vault@example.com
SMTP_FROM_NAME=Vaultwarden
SMTP_PORT=587
SMTP_SECURITY=starttls
SMTP_USERNAME=vault@example.com
SMTP_PASSWORD=<your SMTP password>
```

Use `SMTP_SECURITY=force_tls` with port 465. After a redeploy, send a test email from the admin page's **SMTP Email Settings** section. Mark `SMTP_PASSWORD` as secret. LogiStack stores secret variables encrypted and never prints them in logs; see [Secrets and environment variables](/docs/deploy/environment-variables/).

## Keep the vault off the public internet

A password vault does not need to be reachable from everywhere. If every user's devices can join a private network, you can remove public exposure entirely.

With LogiStack's [Tailscale integration](/docs/networking/tailscale/), you publish the Vaultwarden service on a tailnet hostname such as `https://vault.<your-tailnet>.ts.net`, with a valid certificate. Devices on your tailnet reach it; nothing listens on the public internet. The apps cache the vault offline, so a phone without the tailnet still shows your passwords, it just cannot sync new changes until it reconnects.

The trade-off: sharing with someone outside your tailnet, or using Bitwarden Send links publicly, no longer works. For a family vault that is usually fine. For a team with contractors it may not be.

If you keep it public, Vaultwarden has brute-force protection built in. Because it sits behind Caddy, it sees the proxy's address unless it reads the forwarded client IP. Vaultwarden reads `X-Real-IP` by default; set `IP_HEADER=X-Forwarded-For` so login limits apply per client, then check the **Logs** tab after a failed login to confirm the real IP shows up.

## Back up Vaultwarden

Losing the server must not mean losing every password you have. The whole state is in `/data`:

- `db.sqlite3`: the encrypted vault, users and organizations.
- `attachments/` and `sends/`: encrypted file attachments and Send files.
- `rsa_key.*`: the keys that sign login tokens. Lose them and every device must sign in again.
- `config.json`: settings saved from the admin page.

On LogiStack, open the service's **Backups** tab and create a policy for the `vaultwarden` volume:

- **Schedule**: daily, or more often for a busy team.
- **Consistency**: turn on **Stop vaultwarden while archiving**, so SQLite is copied in a consistent state. The service is down for a few seconds; the apps keep working from their cache.
- **Destination**: a bucket at a different provider from the server.
- **Encryption**: keep **Encrypt before upload** on, and store the backup key somewhere you can reach without this vault, such as a printed copy in a safe place.

![The new backup policy wizard](/docs/screens/backup-new.webp)

The last point is easy to miss. If the backup key lives only inside the vault you are trying to restore, you cannot restore it. See [Back up a database or volume](/docs/data/backups/) and [Restore a backup](/docs/data/restore/).

As a second, independent copy, each user can export their vault from the web vault under **Tools › Export vault**, preferably in the password-protected encrypted format.

## Updates

The template pins a Vaultwarden release. Vaultwarden follows changes in the Bitwarden clients, so an outdated server can break new app versions. Check releases every month or so:

1. Read the release notes.
2. Run the backup policy with **Run now**.
3. Change the image tag on the service and redeploy.
4. Sign in on the web vault and one app to confirm sync.

## FAQ

### Is Vaultwarden safe to use?

The vault is encrypted on your devices before it reaches the server, so the server never sees your passwords. The risks are in how you run it: open signups, a weak admin token, no updates and no backups. Fix those and it is a sound setup for personal and small-team use.

### Do the official Bitwarden apps work with Vaultwarden?

Yes. In the app or extension, choose the self-hosted option on the login screen and enter your server URL. Please do not report Vaultwarden issues to Bitwarden's support; use the Vaultwarden project instead.

### Can I use Postgres instead of SQLite?

Yes. Set `DATABASE_URL` to a PostgreSQL connection string and Vaultwarden uses it. For a family or small team, SQLite is simpler and fast enough, and one volume backup covers everything.

### What happens if I forget my master password?

Your vault cannot be decrypted, by you or by the server admin. Set up emergency access to a trusted person, and keep your master password written down somewhere safe offline.

### Can I migrate from Bitwarden or another password manager?

Yes. Export from your current manager and import under **Tools › Import data** in the web vault. Bitwarden's own JSON format keeps your folders.

Vaultwarden is a small service with high stakes, so the boring parts matter most: HTTPS, secrets and off-site encrypted backups. LogiStack handles them for Vaultwarden and every other [template](/templates/) on your server. [Install LogiStack](/#install) to get started.

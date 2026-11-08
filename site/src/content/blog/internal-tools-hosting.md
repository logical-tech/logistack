---
title: "Internal tools hosting: run admin apps safely"
description: "Internal tools hosting done safely: where to run admin panels and dashboards, how to keep them off the public internet, and how to put SSO in front."
date: 2026-11-08
category: Self-hosting
keywords: internal tools hosting, host internal apps, admin panel security, self-hosted internal tools, forward auth, private network
---

Every company grows a shadow layer of internal software. An admin panel to refund orders, a Grafana board, a Metabase instance, an Appsmith app the support team built, a script with a web form that someone deployed on a Friday. These tools often have more power than the customer-facing product: they read every customer's data and can change it. Yet they are the ones most often left on a public URL with a shared password. Internal tools hosting is about giving these apps a proper home: somewhere cheap to run, easy to deploy, and closed to everyone who should not reach them.

This guide covers where to run internal apps, the layers of access control you can put in front of them, and a concrete setup on a self-hosted platform.

## What counts as an internal tool

Internal tools share a few traits that shape how you host them:

- **Small, known audience.** Ten to a few hundred employees, not the public.
- **High privilege.** Direct access to production data, refunds, user impersonation, configuration.
- **Low traffic.** A few requests per minute, often idle overnight.
- **Many of them.** Each team adds its own, and few have an owner a year later.

Typical examples: admin panels built into your app or as a separate service, low-code builders such as Appsmith, Budibase or ToolJet, BI tools such as Metabase or Grafana, spreadsheet-databases such as NocoDB or Baserow, workflow tools such as n8n, and one-off scripts with a small web UI.

## Where to run internal apps

| Option | Good for | Watch for |
| --- | --- | --- |
| Hosted internal-tool SaaS | Teams with no infrastructure, quick start | Per-seat pricing, your data flows through the vendor, access to private databases needs a tunnel or allowlist |
| Same cluster as production, public URL | Nothing, unless protected | Exposure: one weak password and the tool is the breach |
| Same platform, behind access rules or a private network | Most teams | You must apply the controls consistently |
| Separate server for internal tools | Stronger isolation from customer traffic | One more server to patch |
| Office or VPN-only network | Strict environments | Remote staff need the VPN for every tool |

Low traffic makes internal tools cheap to self-host: a few of them share one small server easily. The hard part is not compute, it is access.

## Layers of access control

Think of access in layers. Each layer stops a different class of mistake, and the important tools deserve more than one.

### 1. Network: keep it off the public internet

The safest internal tool has no public address. Two common ways:

- **A private network such as Tailscale or WireGuard.** Only devices on your network can reach the tool. Nothing listens on the public internet.
- **IP allowlists**, if your staff work from known addresses or through a company VPN with fixed exit IPs.

### 2. Proxy: authenticate before the app sees the request

When a tool must be reachable from the internet, put authentication at the reverse proxy, in front of the app. The app never receives a request from someone who has not signed in. This matters because many open-source tools have weak or no built-in authentication, and because a login page in the app is itself an attack surface.

Options, from weakest to strongest:

- **Basic auth:** a username and password checked by the proxy. Fine for a staging site, weak for a tool with production data, since passwords get shared.
- **Forward auth to a sign-in gateway:** the proxy asks an authentication service, such as Authelia, Authentik or oauth2-proxy, whether each request is allowed. The gateway signs people in against your company identity provider, with your MFA and your offboarding.

### 3. App: roles inside the tool

Inside the tool, give people the least privilege that lets them work. A support agent who issues refunds does not need to edit the refund rules. Read-only by default, write where needed.

### 4. Data: limit what the tool can touch

Connect each tool to the database with its own role and only the permissions it needs, ideally read-only and limited to the tables it uses. A compromised BI tool with a read-only role on three tables is an incident. The same tool with the superuser password is a disaster.

## Setting it up on a self-hosted platform

Here is how these layers map to LogiStack. Other platforms offer some of the same controls under different names.

### Deploy the tool

Deploy a low-code builder or BI tool from a one-click template, such as [Appsmith](/templates/appsmith/), NocoDB, Baserow, Directus, n8n or Grafana. Templates generate passwords and keys, store them encrypted and never print them in a log. Your own admin app deploys from Git like any other service.

Put internal tools in their own project, for example `Internal tools`, so you can grant access to it separately from customer-facing projects.

### Option A: private, on your tailnet

LogiStack can join every server to your Tailscale tailnet and publish chosen services on tailnet hostnames, such as `https://grafana.<your-tailnet>.ts.net`, with HTTPS from a tailnet certificate. Nothing listens on the public internet for that service, and only devices in your tailnet reach it. This is the simplest strong option for teams that already use Tailscale. See [Tailscale](/docs/networking/tailscale/).

### Option B: public hostname, sign-in gateway in front

When the tool needs a normal public hostname, add access rules to its domain. LogiStack's proxy, Caddy, checks them before the request reaches the service. A domain can have three kinds of rule, checked in this order:

1. **IP allowlist:** addresses or CIDR ranges, IPv4 or IPv6. Everyone else gets `403`.
2. **Sign-in gateway:** forward auth to a service such as Authelia, Authentik or oauth2-proxy.
3. **Password:** basic auth with bcrypt-hashed passwords.

For a sign-in gateway, you set the **Auth endpoint** the proxy asks first. A `2xx` answer lets the request through; anything else, such as a redirect to the login page, goes back to the visitor. For Authelia, the endpoint looks like this:

```text
http://authelia:9091/api/authz/forward-auth
```

The gateway can pass identity headers to the tool, by default `Remote-User`, `Remote-Groups`, `Remote-Email` and `Remote-Name`, so the tool knows who signed in. A visitor cannot forge them. Before saving, the wizard sends a test request as an anonymous visitor and warns you if the gateway would let everyone through. See [access control](/docs/networking/access-control/).

![The Domains tab of a service with the Basic auth panel below the domain list](/docs/screens/service-domains.webp)

The gateway itself needs an identity source. If you do not already have Okta, Entra ID or Google Workspace, [Keycloak](/templates/keycloak/) and Pocket ID deploy from templates as self-hosted identity providers.

### Combine layers for sensitive tools

For an admin panel that can change production data, stack them: an IP allowlist for your VPN's exit addresses, plus the sign-in gateway. A stolen password alone does not get in, and neither does a request from an unknown network.

### Protect the platform too

The platform that runs your internal tools is itself an internal tool, with more power than any of them. Treat it that way:

- **Single sign-on for the dashboard.** LogiStack connects to Okta, Microsoft Entra ID, Google Workspace, Keycloak or any OIDC or SAML provider. People at your email domain sign in through it and join with the role you choose. Removing someone in your identity provider removes their access. See [single sign-on](/docs/team/sso/).
- **Least-privilege roles.** Grant Viewer on the organization and wider roles only on the projects people work on. Read secrets, Administer and Terminal are marked sensitive; grant them deliberately.
- **An audit log.** Every change, from the dashboard, the API or an AI agent through MCP, is recorded with who, what and from where. Denied attempts are recorded too. See [audit logs](/blog/audit-logs/) for what to look for.
- **Two-factor authentication**, required for the whole organization if you do not use SSO.

One limit to know: the access rules protect app domains, not the LogiStack dashboard itself. To keep the dashboard off the public internet, put it behind your own VPN or firewall.

## Common mistakes

- **A published port next to a protected domain.** Access rules live on the proxy. A port published directly on the node bypasses the proxy and every rule on it. Reach internal tools through a domain or a private network only.
- **An IP allowlist behind Cloudflare's proxy without trusted proxies.** Every request then arrives from a Cloudflare address. Allowlist your office and you block everyone; allowlist Cloudflare and you let everyone in. Add Cloudflare's ranges as trusted proxies.
- **One shared admin password.** Nobody knows who did what, and nobody rotates it when someone leaves. Use a sign-in gateway tied to individual accounts.
- **Superuser database credentials in a BI tool.** Create a dedicated role with read access to the tables the tool needs. LogiStack's database roles wizard creates users with per-table permissions.
- **Secrets pasted into tool configs.** Keep credentials in encrypted environment variables or a secret store, not in a low-code app's settings page. [Secrets management](/blog/secrets-management/) covers the options.
- **No owner.** Every internal tool gets a named owner and a review date. Unowned tools are the ones that run an old version with a known vulnerability.

## A minimal checklist

For each internal tool:

1. It runs in a dedicated project with its own permissions.
2. It is reachable only through a private network, or through a domain with a sign-in gateway.
3. Its most sensitive actions need an extra layer, such as an IP allowlist.
4. It uses its own database role with the least privilege.
5. Its credentials are stored encrypted, never in a repository.
6. It has an owner, and its version is updated on a schedule.
7. Its data is backed up if it stores anything you cannot rebuild.

## FAQ

### Should internal tools be on a separate server?

Not necessarily. Separate projects with their own permissions and private networks give good isolation on a shared cluster. A separate server helps when the tools are heavy, or when your threat model calls for stronger separation from customer-facing workloads.

### Is basic auth enough for an internal tool?

For a staging site, often yes. For a tool with production data, no: passwords get shared, rarely rotated, and are not tied to your identity provider. Use a sign-in gateway with SSO, or keep the tool on a private network.

### What is forward auth?

A pattern where the reverse proxy asks an authentication service about each request before passing it on. If the service answers `2xx`, the request continues; otherwise the visitor is sent to sign in. The app behind it does not need its own login.

### Can I use my company SSO for self-hosted internal tools?

Yes. Put a sign-in gateway such as Authelia, Authentik or oauth2-proxy in front of the tools, connected to your identity provider, and add it as forward auth on each tool's domain. For the hosting platform's own dashboard, use its built-in OIDC or SAML sign-in.

Internal tools deserve the same care as your product, and they cost little to run. LogiStack gives you one-click templates, Tailscale publishing, access rules with forward auth, SSO for the dashboard and an audit log, all in the free, open-source build. [Install it](/#install) on a small server and move your first internal tool behind a sign-in gateway.

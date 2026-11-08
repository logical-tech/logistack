---
title: "Let's Encrypt rate limits: what they are and how to avoid them"
description: "Let's Encrypt rate limits explained: the 50 per week domain budget, why sslip.io and nip.io share one, and how DNS-01 wildcard certificates avoid it."
date: 2026-11-08
category: Networking
keywords: lets encrypt rate limits, too many certificates already issued, sslip.io rate limit, public suffix list, wildcard certificate dns-01
---

Your new service is up, the DNS record points at the server, and the browser still shows a certificate error. The proxy log says `too many certificates already issued`. You have hit one of the Let's Encrypt rate limits, and the frustrating part is that waiting is often the only fix. This guide explains each limit in plain terms, shows why free wildcard DNS services like sslip.io and nip.io run into them constantly, and walks through the setup that keeps you clear of them for good.

The numbers below come from Let's Encrypt's own rate limits page, checked on 8 November 2026. Limits change from time to time, so treat that page as the source of truth.

## Why Let's Encrypt has rate limits

Let's Encrypt issues hundreds of millions of free certificates. Its limits protect the service from runaway clients: a misconfigured proxy that orders a new certificate on every restart, or a script that loops on a failed challenge. Normal use stays well under them. Trouble starts when many certificates share one registered domain, when certificates are lost and re-ordered, or when validation keeps failing.

## The Let's Encrypt rate limits that matter

| Limit | Quota | Refill | Keyed on |
| --- | --- | --- | --- |
| New certificates per registered domain | 50 per 7 days | 1 every 202 minutes | Registered domain, across all accounts |
| New certificates per exact set of identifiers | 5 per 7 days | 1 every 34 hours | The exact list of names, across all accounts |
| Authorization failures per identifier per account | 5 per hour | 1 every 12 minutes | Hostname and ACME account |
| Consecutive authorization failures per identifier | 1,152 | 1 per day; resets on success | Hostname and ACME account |
| New orders per account | 300 per 3 hours | 1 every 36 seconds | ACME account |
| New accounts per IP address | 10 per 3 hours | 1 every 18 minutes | IPv4 address |
| New accounts per IPv6 range | 500 per 3 hours | 1 every 22 seconds | /48 range |

The limits refill gradually rather than all at once on a fixed day. When a request breaks several limits, the error names the one that clears last, and the response carries a `Retry-After` header.

### New certificates per registered domain

This is the limit most people hit. Every new certificate that contains a name under `example.com` counts against `example.com`, whether it covers `example.com`, `shop.example.com` or `a.b.c.example.com`. Fifty per week is a lot for one company, and little for a shared domain with thousands of users.

### New certificates per exact set of identifiers

Ordering a certificate for exactly the same list of names more than five times a week fails. This one catches you when the proxy loses its storage: a container without a persistent volume, a rebuilt server, a test loop that wipes state. Each restart orders the same certificate again.

### Authorization failures

If validation fails five times in an hour for one hostname, you wait. Typical causes: the DNS record points somewhere else, port 80 is closed, or a CDN answers the challenge instead of your server. Fix the cause before you retry.

The consecutive-failure limit is newer and aimed at abandoned hostnames. A client that fails validation for the same name every day, without a single success, eventually has that name paused for its account. Let's Encrypt provides a self-service page to unpause it.

### What renewals count against

Renewals are treated generously:

- A renewal through ACME Renewal Information (ARI), where the client asks Let's Encrypt when to renew, is exempt from all limits.
- A renewal with the same set of names is exempt from the per-domain and per-account order limits, but still counts toward the exact-set limit and authorization failures.
- Adding one name to an existing certificate creates a new set. That is a new certificate, not a renewal.

Revoking a certificate does not give quota back.

## The Public Suffix List decides what a registered domain is

Let's Encrypt does not guess where a domain ends. It uses the Public Suffix List (PSL), a community-maintained list of suffixes under which anyone can register names. `com` and `co.uk` are on it, so the registered domain of `shop.example.co.uk` is `example.co.uk`.

Services that hand out subdomains to strangers can ask to be added to the list. Once listed, each user's subdomain counts as its own registered domain with its own budget. Many dynamic DNS and hosting providers are listed for exactly this reason.

## Why sslip.io, nip.io and traefik.me share one budget

sslip.io and nip.io are wildcard DNS services. Any name that contains an IP address resolves to that address, with no setup:

```bash
dig +short app.203-0-113-10.sslip.io
# 203.0.113.10
dig +short app.203.0.113.10.nip.io
# 203.0.113.10
```

That makes them a convenient way to try an app on a real hostname before you own a domain. Many self-hosted platforms use them for generated hostnames.

The catch: none of `sslip.io`, `nip.io` or `traefik.me` is on the Public Suffix List. We checked the list on 3 November 2026 while testing LogiStack's proxy. A search found none of the three, while `duckdns.org`, a dynamic DNS service that did register, was there.

Without a PSL entry, the registered domain of `app.203-0-113-10.sslip.io` is `sslip.io` itself. So every certificate for every sslip.io hostname, issued by anyone on the internet, draws from the same 50 certificates per week. When that pool is empty, your issuance fails with an error like this, and nothing you change on your server fixes it:

```text
too many certificates already issued for "sslip.io"
```

The pool refills by one certificate every 202 minutes, and someone else may take that one. Treat HTTPS on these hostnames as best effort.

## The fix: a wildcard certificate over DNS-01

The lasting answer is to use a domain you own and cover many hostnames with one certificate.

A wildcard certificate for `*.srv1.example.com` covers `app.srv1.example.com`, `grafana.srv1.example.com` and any other single label under that name. You issue it once. The fiftieth service on the server needs no new certificate at all, and the hostnames count against your own domain's budget, not a shared one.

Let's Encrypt issues wildcards only through the DNS-01 challenge. Instead of serving a file on port 80, your ACME client writes a TXT record at `_acme-challenge.srv1.example.com` through your DNS provider's API. That means:

- Your client needs an API token for the DNS provider, scoped to the zone.
- Validation works before the A record has propagated, and on servers that have no open port 80.
- It also works for hostnames proxied by a CDN, where HTTP-01 would hit the CDN instead of your server.

The DNS records for a per-server wildcard are just two A records:

```text
*.srv1.example.com.   300  IN  A  203.0.113.10
srv1.example.com.     300  IN  A  203.0.113.10
```

One wildcard name per server (`srv1`, `srv2`) keeps servers separate without extra certificates.

A wildcard covers one level only. `*.srv1.example.com` does not cover `srv1.example.com` itself or `a.b.srv1.example.com`. Request the apex name in the same certificate if you need it.

## Other ways to stay under the limits

- **Persist certificate storage.** Mount the proxy's data directory on a volume. Losing it is the most common cause of the exact-set limit.
- **Share storage between instances.** If you run several proxies, give them one storage backend so only one orders each certificate.
- **Test against staging.** Let's Encrypt's staging environment has much higher limits and issues untrusted certificates. Use it while you experiment, then switch to production.
- **Fix validation before retrying.** Check DNS and port 80 with `dig` and `curl` first. Failed attempts count.
- **Use a second CA.** ZeroSSL and others also speak ACME and have their own limits. It helps when a shared budget is the problem, but read the CA's own terms.
- **Request an override.** For large legitimate use, Let's Encrypt accepts override requests for the per-domain and per-account order limits. Processing takes weeks.

To see what has already been issued for a domain, search the public Certificate Transparency logs:

```bash
curl -s 'https://crt.sh/?q=%25.example.com&output=json' \
  | jq -r '.[] | "\(.not_before)  \(.name_value)"' | sort | tail -20
```

## How LogiStack handles rate limits

LogiStack, an open-source self-hosted PaaS, runs Caddy as its proxy and was designed around these limits from the start.

- **Generated hostnames are a fallback.** For quick tests, a service can get a generated hostname such as `web-a1b2c3.203-0-113-10.sslip.io`. The docs say plainly that HTTPS on it can fail because of the shared budget. See [generated domains](/docs/networking/domains/).
- **A per-server wildcard is the recommended setup.** In the setup wizard you pick **Your own wildcard domain**, enter a base such as `srv1.example.com` and connect a DNS provider (Cloudflare, Route 53, Hetzner DNS, DigitalOcean, OVHcloud or Porkbun). LogiStack creates both A records and requests one wildcard certificate over DNS-01. Every generated hostname is then served from it. See [Per-server wildcard DNS](/docs/networking/wildcard-dns/).
- **Certificates are shared.** Caddy keeps certificates in Redis, so several ingress nodes serve one certificate instead of each ordering its own.
- **You can switch the authority.** **Settings** > **Certificates** offers Let's Encrypt, Let's Encrypt staging, ZeroSSL and Caddy's internal CA. See [HTTPS certificates](/docs/networking/https-certificates/).

![LogiStack's Certificates settings showing wildcard certificates issued automatically, with issuer and expiry dates](/docs/screens/settings-certificates.webp)

## FAQ

### How many certificates can I get from Let's Encrypt per week?

Up to 50 new certificates per registered domain in any 7-day window, refilling one every 202 minutes. Renewals of an existing set of names do not count toward that number. The same exact set of names can be issued at most 5 times a week.

### How do I fix "too many certificates already issued"?

If the domain is yours, wait for the window to refill, then make sure your proxy keeps its certificate storage so it stops re-ordering. If the domain is a shared one like sslip.io, you cannot fix it from your side. Move the hostnames under a domain you own, ideally with a wildcard certificate.

### Does a wildcard certificate count as one certificate?

Yes. A certificate for `*.example.com` counts once against `example.com`, no matter how many subdomains it serves. That is why wildcards are the standard answer for platforms that create many hostnames.

### Is sslip.io safe to use for HTTPS?

The hostnames work and certificates can be issued, but the shared rate limit means issuance often fails at busy times. Use sslip.io or nip.io for quick tests over HTTP, and a domain you own for anything that should stay up.

### Do Let's Encrypt staging certificates count toward production limits?

No. Staging has separate, much higher limits and its certificates are not trusted by browsers. It is the right place to test a new proxy configuration.

If you want wildcard certificates, DNS records and renewals handled from one wizard on your own server, [install LogiStack](/#install) and choose your own wildcard domain during setup. The [features page](/features/) lists the rest of what it covers.

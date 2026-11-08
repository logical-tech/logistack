---
title: "Netlify alternatives for static sites and web apps"
description: "Compare Netlify alternatives for static sites, Jamstack and full-stack apps, from edge hosts to self-hosted PaaS, and learn how to move redirects and forms."
date: 2026-11-08
category: Comparisons
keywords: netlify alternatives, static site hosting, netlify vs cloudflare pages, self-hosted static site, jamstack hosting
---

Netlify made deploying a static site feel like magic: connect a repository, and every push builds, every branch gets a preview, and the result sits on a CDN. Then a traffic spike meters through your bandwidth allowance, a form needs more than the built-in handler offers, or the site grows a backend that wants a database and a long-running process. This guide compares Netlify alternatives by the kind of site you run, and shows how to move the parts that are specific to Netlify, such as redirects and forms.

## What Netlify does well

Netlify is a managed platform for frontends. Its core features:

- Builds from Git with deploy previews for every pull request and branch deploys.
- A global CDN for the built files.
- Serverless functions and edge functions for dynamic routes.
- Redirects and headers in `_redirects` or `netlify.toml`.
- Netlify Forms, which collects HTML form submissions with no backend code.
- Adapters for frameworks such as Next.js, Astro, SvelteKit and Nuxt.

For a marketing site or documentation, that covers almost everything. The pressure points come from metering and from scope. Plans meter bandwidth, build minutes and function use, so a viral post or a bot crawl can cost real money. And Netlify is not designed to host a database or a worker process.

## When to look for a Netlify alternative

- **Unpredictable bills.** Your traffic is spiky or large, and you want a fixed cost or a bigger free allowance.
- **A real backend.** You need Postgres, a queue, WebSockets or jobs that run for minutes.
- **Lock-in worries.** Forms, identity and functions tie your site to one vendor's runtime.
- **Data location.** You must serve from a region or hardware you choose.
- **Build limits.** Large sites outgrow build time or memory limits on lower tiers.

## How to choose: control versus convenience

Picture a line. At one end, a managed edge platform: no servers, global caching, metered usage. At the other end, your own server: fixed cost, full control, and you are responsible for it. Most alternatives sit at one end, and the right one depends on which end your site belongs to.

| Your site | Better fit |
| --- | --- |
| Static, global audience, little backend | Edge host (Cloudflare, GitHub Pages, Firebase) |
| Static plus a few functions | Edge host or Vercel |
| Full-stack app with a database | Managed PaaS (Render, Railway) or self-hosted PaaS |
| Many sites for clients, fixed budget | Self-hosted PaaS |

## Netlify alternatives compared

| Platform | Type | Free tier | Functions | Databases | Self-hostable |
| --- | --- | --- | --- | --- | --- |
| Cloudflare Workers and Pages | Managed edge | Yes | Workers | D1, KV, R2 | No |
| Vercel | Managed edge | Hobby, non-commercial | Yes | Via partners | No |
| GitHub Pages | Static only | Yes, public repos | No | No | No |
| Firebase Hosting | Managed | Yes | Cloud Functions | Firestore | No |
| AWS Amplify Hosting | Managed on AWS | Limited | Via AWS | AWS services | No |
| Render | Managed PaaS | Static sites free | Web services | Postgres | No |
| LogiStack | Self-hosted PaaS | Free software | Any container | Six engines | Yes |
| Coolify | Self-hosted PaaS | Free software | Any container | One-click | Yes |

## Edge and static hosts

### Cloudflare Workers and Pages

Cloudflare serves static assets and runs code in V8 isolates across its network, with a generous free tier and no bandwidth charges for static assets. For new projects Cloudflare points you to Workers with static assets rather than Pages. Storage includes D1, KV and R2. It is the closest match for a global static site with light dynamic parts. The runtime is not full Node.js, so check your dependencies.

### Vercel

Vercel offers the same branch-preview workflow with the best Next.js support available, since it builds the framework. Its Hobby plan is for non-commercial use. See [Vercel alternatives](/blog/vercel-alternatives/) for the full picture.

### GitHub Pages

GitHub Pages serves a static site straight from a repository or a GitHub Actions build. It is free for public repositories, simple and reliable. It has no functions, no server-side redirects beyond basic rules, and no previews per pull request without extra work.

### Firebase Hosting

Firebase Hosting serves static files on Google's CDN and pairs with Cloud Functions, Firestore and Firebase Auth. It fits apps already built on Firebase. Preview channels give you temporary URLs per branch through the CLI or GitHub Actions.

### AWS Amplify Hosting

Amplify Hosting builds and serves frontends on AWS with branch previews. Choose it when the rest of your stack runs on AWS.

## Full-stack and self-hosted alternatives

If your site has grown a backend, a pure static host will push you toward a patchwork of services. A PaaS keeps frontend, API and database together.

### Render

Render hosts static sites alongside web services, workers, cron jobs and managed Postgres, with pull request previews. It is a calm managed option when the backend matters as much as the frontend. See [Render alternatives](/blog/render-alternatives/).

### LogiStack

LogiStack is an open-source, self-hosted PaaS under Apache 2.0, running on Docker Swarm with Caddy. For Netlify users, its **Static site** builder is the direct replacement: it installs dependencies with the package manager your lockfile names, runs your `build` script, and serves the publish folder with Caddy, with zstd or gzip compression and a fallback to `index.html` so single-page app routes work on reload. Set the publish directory to `dist` for Vite, `build` for Docusaurus, `out` for a Next.js static export or `public` for Hugo. See [build types](/docs/deploy/build-types/).

Around that you get what Netlify users expect, on your own server:

- Deploy on push from GitHub, GitLab, Gitea or Bitbucket, with watch paths that skip a deploy when a commit touches nothing the site uses.
- [Preview environments](/docs/deploy/preview-environments/) for every pull request, with their own URL.
- Automatic HTTPS through Let's Encrypt, including wildcard certificates over DNS-01, and www-to-apex redirects.
- Build-time variables, with secret ones mounted only during the build and never stored in the image.

And what Netlify does not host: Postgres, MySQL, MariaDB, MongoDB, Redis and libSQL with a built-in editor, background workers, scheduled jobs and S3-compatible storage. One server can host many small client sites for a fixed monthly cost.

The honest trade-offs: there is no global CDN built in, so your site is served from wherever your servers are. You can put Cloudflare in front, and LogiStack can issue Cloudflare origin certificates for that setup. LogiStack is young, its community is small, and you maintain the server.

### Coolify

Coolify is a widely used open-source dashboard with static site support, Nixpacks builds and a big one-click catalog. Compare it in [Coolify alternatives](/blog/coolify-alternatives/).

## Moving Netlify-specific features

### Redirects and headers

Netlify reads `_redirects` and `netlify.toml`. On another host you rewrite those rules in its own format. On a self-hosted platform with Caddy, a short Caddyfile covers redirects, custom headers and a real 404 page:

```text
:80 {
	root * /usr/share/caddy
	encode zstd gzip

	redir /blog/old-post /blog/new-post 301
	header /assets/* Cache-Control "public, max-age=31536000, immutable"

	handle_errors {
		rewrite * /404.html
		file_server
	}

	file_server
}
```

Ship it with your build in a small image:

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build

FROM caddy:2.10-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /usr/share/caddy
EXPOSE 80
```

### Forms

Netlify Forms has no drop-in replacement on other hosts. Your options: a hosted form service, a function on an edge platform, or a small API endpoint next to your site that writes to a database and sends an email. On a PaaS with databases built in, that endpoint takes an afternoon.

### Functions

Netlify Functions are AWS Lambda-style handlers. Port them to the new platform's function format, or fold them into one small API service. A single service is often simpler to test and cheaper to run than many functions.

### DNS

Lower your TTL a day before the switch. Point the domain at the new host, wait for the certificate to issue, check every important URL, and only then remove the site from Netlify.

## FAQ

### What is the best free alternative to Netlify?

For static sites, Cloudflare and GitHub Pages have free tiers that cover most projects. If you also need a backend, self-hosted platforms such as LogiStack and Coolify are free software and cost only the server.

### Is Cloudflare Pages better than Netlify?

For global static delivery with a large free allowance, Cloudflare is very strong. Netlify has a more mature build and forms workflow. Test both with your real site before deciding.

### Can I self-host a Netlify-style workflow?

Yes. A self-hosted PaaS gives you deploy on push, previews per pull request and automatic HTTPS. LogiStack's Static site builder serves your built files with Caddy without a Dockerfile.

### How do I replace Netlify redirects?

Rewrite each rule in your new host's format. With Caddy, `redir` handles redirects and `header` sets headers, and `handle_errors` serves a custom 404 page.

If your static site has grown into an app with a database, and you want previews, HTTPS and backups on servers you control, try LogiStack. Check the [features](/features/) or run the [install command](/#install) on a fresh server.

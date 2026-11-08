---
title: "How to deploy a static site on your own server with Caddy"
description: "Deploy a static site built with Vite, Astro or Hugo on your own server: build once, serve with Caddy, get HTTPS, caching, SPA routing and real 404 pages."
date: 2026-11-08
category: Deployment
keywords: deploy static site, host static website, vite deploy, astro deploy, caddy static site
---

A static site is the simplest thing you can put on the web: a folder of HTML, CSS and JavaScript. Yet the easy hosts come with limits, like build-minute quotas, bandwidth caps, per-seat pricing or a vendor you'd rather not depend on for a marketing site and three internal dashboards. If you already run a server, you can deploy a static site there in a few minutes, with automatic HTTPS, compression and proper caching.

This guide covers how static builds work for Vite, Astro and similar tools, how to serve them with Caddy, and the details that separate a quick upload from a solid setup: cache headers, single-page app routing, 404 pages and build-time variables.

## Static site vs server-rendered app

First, check that your project is actually static. A build is static when it produces plain files and needs no server code at request time.

| Framework | Static output | Folder |
| --- | --- | --- |
| Vite (React, Vue, Svelte, Solid) | `vite build` | `dist` |
| Astro (default `output: "static"`) | `astro build` | `dist` |
| Next.js with `output: "export"` | `next build` | `out` |
| Docusaurus | `docusaurus build` | `build` |
| Hugo | `hugo` | `public` |
| Eleventy | `eleventy` | `_site` |
| SvelteKit with `adapter-static` | `vite build` | `build` |

If your Astro site uses an SSR adapter, or your Next.js app uses server actions, API routes or ISR, it isn't static. Deploy it as a Node.js service instead; for Next.js, see [self-hosting Next.js](/blog/deploy-nextjs-self-hosted/).

## Why Caddy for static files

Any web server can serve a folder. Caddy is a good fit because the things you'd configure by hand in Nginx are defaults or one-liners:

- Automatic HTTPS with Let's Encrypt, including renewals.
- `encode zstd gzip` for compression in one directive.
- `try_files` for single-page app fallbacks.
- A short, readable config file.

If you're new to it, [what is Caddy](/blog/what-is-caddy/) covers the basics.

## Build once, serve the output

The pattern is a two-stage Docker image: Node builds the site, Caddy serves the result. Node never ships to production.

```dockerfile title="Dockerfile"
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_API_URL
RUN npm run build

FROM caddy:2.10-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
EXPOSE 80
```

And a Caddyfile tuned for a static build:

```text title="Caddyfile"
:80 {
	root * /srv
	encode zstd gzip

	# Hashed assets never change: cache them for a year.
	@hashed path /assets/*
	header @hashed Cache-Control "public, max-age=31536000, immutable"

	# Everything else (HTML above all) revalidates, so new deploys show up at once.
	@other not path /assets/*
	header @other Cache-Control "no-cache"

	header {
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
		-Server
	}

	try_files {path} {path}/ {path}.html
	file_server

	handle_errors 404 {
		rewrite * /404.html
		file_server
	}
}
```

The site listens on plain `:80` inside the container. HTTPS is handled by the proxy in front of it, so the container never needs certificates.

### Cache headers that don't bite you

Vite and Astro put content hashes in asset filenames (`index-4f8a2c.js`), so a new build produces new names. Those files can be cached forever. HTML files keep stable names, so they must not be cached long, or visitors keep loading old HTML that points at assets that no longer exist. The two header rules above encode exactly that. Astro uses `/_astro/` instead of `/assets/` for hashed files; adjust the matcher to your framework.

### Single-page apps vs multi-page sites

The `try_files` line above serves `/about` from `about.html` or `about/index.html`, which suits Astro, Hugo and other multi-page builds. Real 404s go to `404.html`.

A single-page app (a React or Vue app with client-side routing) needs the opposite: every unknown path should return `index.html`, so the router can handle `/settings/billing` on reload. Replace the `try_files` line with:

```text
try_files {path} /index.html
```

The trade-off: a missing page now returns your app shell with status 200, not a 404. Handle "not found" in your router.

## Build-time environment variables

Static sites have no runtime. Every variable is read during the build and written into the JavaScript. Two consequences:

- **Prefixes matter.** Vite exposes only variables starting with `VITE_` to client code; Astro uses `PUBLIC_` for client-visible ones. Anything else stays on the build machine.
- **Never put secrets in them.** A `VITE_STRIPE_SECRET` ends up in a public `.js` file that anyone can read. Client-side code gets publishable keys only.

Change a variable and you must rebuild. If you need one build for several environments, load a small `config.json` at startup instead, and serve a different file per environment.

## Deploy a static site with LogiStack

[LogiStack](/features/) is an open-source, self-hosted PaaS on Docker Swarm, and it uses Caddy as its proxy. It has a dedicated **Static site** builder, so for most sites you don't write the Dockerfile above at all.

**1. Install LogiStack** on your server:

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

**2. Create a Git service.** Open your project, select **New service**, choose **Git repository**, and pick the repository and branch. See [Deploy from Git](/docs/deploy/from-git/).

**3. Choose Static site.** Set **Build with** to **Static site** and **Container port** to `80`. Under **Settings** › **Source and build**, set **Publish directory** if your output isn't `dist`: `build` for Docusaurus, `out` for a Next.js export, `public` for Hugo, or `.` for files at the root of the repository.

What the builder does, according to the [Build types](/docs/deploy/build-types/) docs:

- If there's a `package.json`, it installs dependencies with the package manager your lockfile names (pnpm, Yarn, Bun or npm), using Node.js 22.
- If `package.json` has a `build` script, it runs it.
- It copies the publish directory into a Caddy image that compresses responses with zstd or gzip and serves `index.html` for any path that matches no file, so client-side routes work on reload.

**4. Add build variables.** In the **Environment** tab, add `VITE_API_URL` (or `PUBLIC_...` for Astro) and check **Build** so it reaches the build step.

**5. Add a domain.** Add `www.example.com` in the **Domains** tab. LogiStack issues a Let's Encrypt certificate and redirects HTTP to HTTPS. To send `example.com` to `www.example.com` (or the reverse), add the other hostname as a domain with **Redirect to** set; the proxy answers with a 308 and keeps the path.

Each push to the branch rebuilds the site and replaces the container with no downtime, and earlier builds stay one click away in the **Deployments** tab. In a monorepo, set **Root directory** to the site's folder and add **Watch paths** so a commit to the API doesn't rebuild the docs.

### When to use your own Dockerfile instead

The built-in builder serves `index.html` for every unknown path. That's right for single-page apps, but on a content site a typo in a URL shows the home page instead of a 404, which is bad for visitors and search engines. When you need real 404 pages, custom cache headers or redirects, use the Dockerfile and Caddyfile from earlier in this post, set **Build with** to **Dockerfile** and **Container port** to `80`. The docs describe this as the "own Caddy image" option.

### Preview every pull request

Static sites are a natural fit for preview environments: every pull request gets its own build and URL, posted as a comment, and removed when the pull request closes. See [preview environments](/blog/preview-environments/) for how they work.

![The Domains tab of a service with an active domain and its certificate](/docs/screens/service-domains.webp)

## Static hosting options compared

| Option | Good at | Watch out for |
| --- | --- | --- |
| Netlify, Vercel, Cloudflare Pages | Global CDN, zero setup, generous free tiers | Usage-based limits, vendor-specific config |
| Object storage + CDN | Huge traffic, low cost per GB | More pieces to wire, SPA routing needs CDN rules |
| Your own server with Caddy | Flat cost, same place as your apps, full control | One region unless you add a CDN |

If your audience is worldwide and the site is your main product, a managed host or a CDN in front of your server is worth it. If it's a marketing site, docs or an internal tool next to apps you already run, your own server is simpler. The [Netlify alternatives](/blog/netlify-alternatives/) post compares more options.

## FAQ

### What is the cheapest way to host a static website?

If you already run a server, adding a static site to it costs nothing extra; a static site needs very little CPU or memory. Without a server, the free tiers of managed static hosts are hard to beat for small sites.

### Do I need Node.js on the server to host a Vite or Astro site?

No. Node.js runs only during the build. The production container holds the built files and a web server like Caddy.

### How do I fix 404 errors on refresh in a React or Vue app?

The server must return `index.html` for unknown paths so the client-side router can take over. In Caddy that's `try_files {path} /index.html`. LogiStack's Static site builder does this by default.

### Can I put a CDN in front of my own server?

Yes. Point the CDN at your domain and keep the long cache headers on hashed assets. If you use Cloudflare's proxy, set SSL/TLS mode to Full (strict), or you'll get a redirect loop.

A static site needs a build step, a web server and sensible cache headers. To get those on your own server with push-to-deploy, previews and automatic HTTPS, [install LogiStack](/#install) and choose the Static site builder.

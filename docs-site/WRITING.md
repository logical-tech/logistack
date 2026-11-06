# Writing the LogiStack docs

The docs live in `content/docs/**.mdx` and are served at https://stack.logicaltech.it/docs/.
Navigation order comes from each folder's `meta.json`; a page missing from `pages` is hidden, so add new pages there.

## Truth first

- Document only what the code ships. Read the dashboard route (`apps/web/src/routes/_app/...`), its components, the zod contracts (`packages/contracts`) and the server route (`apps/server/src/routes`) before writing about a feature. Labels, button names, step names and field names must match the UI exactly.
- Never invent flags, env vars, limits or defaults. If you cannot confirm something, leave it out.
- Internal design notes in `docs/` (PIANO.md is Italian), `docs/plans/*.md`, `docs/INSTALL.md`, `docs/MANIFEST.md`, `docs/DOMAIN.md` are good sources, but the code wins when they disagree.

## Style

- English, second person, present tense, active voice. Short sentences. Google developer documentation style.
- Every page opens with one paragraph saying what the feature is and when you need it. No marketing tone, no "seamless", "powerful", "effortless", no em-dash chains.
- Tasks are numbered `<Steps>`: one action per `<Step>`, starting with `### ` and an imperative heading (`### Open the Domains tab`). Say where to click with the exact label in **bold**: "Select **Deploy**".
- After the steps, say how to check it worked, then common problems.
- Give concrete examples with realistic values (`shop.example.com`, `ghcr.io/acme/api:1.4.2`, a real `docker-compose.yml`, a cron expression). Code blocks have a language and, when useful, a `title="..."`.
- Use callouts sparingly: `<Callout type="warn">` for data loss or downtime, `<Callout type="info">` for context, `<Callout>` for tips.
- Link related pages with relative paths to the .mdx file, e.g. `[Domains](../networking/domains.mdx)`.

## Screenshots

Screenshots come from the dashboard's mock data (`bun run screenshots`, see `scripts/screenshots.ts`). Reference them as Markdown images with a descriptive alt text that says what the screen shows:

```mdx
![The Domains tab of a service, listing shop.acme-retail.it with an active certificate](/screens/service-domains.webp)
```

Available names (file `public/screens/<name>.webp`): see the `shots` map in `scripts/screenshots.ts`. Use only names that exist. Put a screenshot right after the step that opens that screen. If a screen you need is missing, add an entry to the `shots` map instead of describing it without one.

## Frontmatter and SEO

```mdx
---
title: Deploy an app from Git
description: Connect a GitHub, GitLab, Gitea or Bitbucket repository to LogiStack and deploy every push with zero downtime.
---
```

- `title`: what a person would search for, under 60 characters, no "LogiStack" prefix (the template adds it).
- `description`: 120–160 characters, one sentence, says the outcome and names the key terms.
- One `#`-less body: the title is the H1. Use `##` for sections, `###` inside steps. Headings describe content (they become anchors and search results).
- Available MDX components: `Callout`, `Cards`/`Card`, `Steps`/`Step`, `Tabs`/`Tab` (`<Tabs items={["GitHub","GitLab"]}>`), `Accordions`/`Accordion`, `TypeTable`, `Files`/`Folder`/`File`.

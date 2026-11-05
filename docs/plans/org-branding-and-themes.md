# Organization branding and themes plan

Two independent features:

1. **Organization profile.** Admins edit the organization's name and logo. The active organization's logo replaces the LogiStack mark in the sidebar and becomes the favicon. The tab title becomes `LogiStack - <Organization name>`.
2. **Themes.** A theme picker next to the light/dark/system mode, in the style of VS Code color themes (Catppuccin, Rosé Pine, …). `LogiStack Default` is always the first choice and the fallback.

They ship as three PRs: BR-1 and BR-2 for branding, TH-1 for themes. TH-1 does not depend on BR-1/BR-2.

## What already exists

- `organization` table (better-auth, `packages/db/src/schema/auth.ts`) already has `name`, `slug` and a `logo text` column, unused. No migration needed.
- `apps/server/src/routes/organization.ts` holds `/me` and `/organization/two-factor`, using `mutation()` for audit and `requirePermission("admin", inOrganization)`.
- `OrgSwitcher` in `apps/web/src/components/shell/app-sidebar.tsx` always renders `<LogoMark />`, picks the active org from local state or `orgs[0]` (not from the session), and shows each org in the dropdown as an initial on `bg-muted`.
- `apps/web/index.html` hardcodes `<title>LogiStack</title>` and `/favicon.svg`, and runs a pre-paint script that sets `.dark` from `localStorage["ls-theme"]`.
- `apps/web/src/lib/theme.ts` handles mode only (`light | dark | system`). Consumers: `theme-toggle.tsx`, `command-menu.tsx`, `ui/sonner.tsx`.
- `apps/web/src/styles/index.css` defines every token on `:root` and `.dark`: surfaces, sidebar, status (`--ok`/`--ok-text`, …), `--chart-1..5`, `--log-*`, `--ansi-0..15`. Everything else derives from these. That makes a theme a token override set and nothing more.

## BR-1: organization profile API and settings panel

Server (`routes/organization.ts`):

- `GET /organization` → `{ id, name, slug, logo }`, `requirePermission("read", inOrganization)`.
- `PATCH /organization` (`mutation("organization.update", …)`, `requirePermission("admin", inOrganization)`), body `{ name?, logo? }`. `logo: null` removes it. Audit diff records `name` and whether the logo changed, not the image bytes.
- Logo validation at the boundary (zod, rule 7): a `data:image/png|webp|jpeg;base64,…` URL, decoded size ≤ 128 KB. SVG is refused: it can carry scripts and the favicon path would render it.
- Logo storage: the data URL goes into `organization.logo`. shortcut: images live in Postgres and travel with every org list, fine at ≤ 128 KB × a handful of orgs; move to `GET /organization/:id/logo` with ETag if orgs or sizes grow.
- Slug stays read-only. Docker names derive from IDs (rule 5), but the slug is shown elsewhere and renaming it is a separate decision.
- Check that better-auth's own `/organization/update` cannot bypass LogiStack permissions: block it in the `before` hook in `auth.ts` the same way other organization endpoints are guarded.
- Tests: PATCH by admin, PATCH by member → 403, oversize logo → 400, SVG → 400, audit row written.

Web (`routes/_app/settings/general.tsx`):

- New "Organization" panel above "Instance": name field, logo field with preview, Upload (click or drop), Remove, Save.
- The browser center-crops and resizes the image to 256×256 WebP on a `<canvas>` before upload, so any photo the user picks fits the 128 KB limit.
- Monogram fallback (initial on a tinted square) when there is no logo.
- On success invalidate `["organizations"]`, `/me` and instance settings (its `organizationName`).
- Visible to everyone, editable by admins only (`isOrgAdmin`).

## BR-2: active organization in the shell, favicon and title

- `OrgAvatar({ org, className })` component: `<img>` of the logo, monogram otherwise. Used in the sidebar trigger (replaces `LogoMark`), in each dropdown row, and in the General panel preview.
- `OrgSwitcher` reads the active organization from `/me.organizationId` instead of local state plus `orgs[0]`. After `setActiveOrganization`, invalidate all queries so the app reloads in the new org.
- `useDocumentBranding(org)` in the `_app` layout: sets `document.title = "LogiStack - " + org.name` and points `link[rel=icon]` at the logo (or `/favicon.svg` with no logo). On unmount (sign-out, `_auth` routes) it restores `LogiStack` and `/favicon.svg`.
- The switcher shows the member's real organization-wide role under the org name, instead of a hardcoded "Owner".
- Out of scope: per-page titles (`Services · LogiStack - Acme`).

## TH-1: themes

Status (2026-11-05): BR-1, BR-2 and TH-1 are built together on `feat/branding-themes`.

Model:

- A theme is `{ id, label, group, radius?, light, dark }` (`apps/web/src/lib/themes/`). Each variant is a token map. Mode (`light | dark | system`) and theme are two independent preferences.
- 65 choices: LogiStack Default, five editor classics, and the 59 presets published at shadcn.io/theme.

| Group | Themes |
| --- | --- |
| Default | LogiStack Default (the tokens in `index.css`) |
| Editor classics | Catppuccin (Latte/Mocha), Rosé Pine (Dawn/Moon), Gruvbox, Solarized, Tokyo Night (Day/Night) |
| shadcn presets | Inspired by (14), Colors (7), Minimal (7), Playful (7), Warm & natural (10), Night & glow (8), Retro & bold (6) |

- Editor classics also recolour the status vocabulary, the terminal (`--ansi-*`) and the log viewer.
- The shadcn presets bring surfaces, accent, sidebar and radius. Their fonts and chart colours are left out: LogiStack keeps Mona Sans and its categorical chart palette. `shadcn-presets.ts` was generated once from the published CSS, with every value checked against a strict colour pattern.
- The accent becomes `--brand` too. Every text token (`foreground`, `muted-foreground`, `primary-foreground`, `sidebar-foreground`, the `*-text` status colours) is nudged in OKLCH lightness until it reaches 4.5:1 on its surfaces. `themes.test.ts` checks completeness and contrast for every theme in both variants.

Implementation:

- No CSS file per theme. `lib/theme.ts` sets the chosen variant's tokens as inline custom properties on `<html>` and sets `data-theme`. It caches both variants in `localStorage` (`ls-theme-name`, `ls-theme-vars`), so `index.html` applies them before first paint and a mode switch needs no lookup. The theme registry is its own lazy chunk. On load it refreshes the cache from the current list, and falls back to the default when a theme is gone.
- `index.css` also scopes the defaults to `.theme-default`, so a preview card resets to LogiStack's tokens before its inline variables paint another theme.
- The terminal re-reads its colours when `class` or `data-theme` changes on `<html>`.
- Persistence is per browser. shortcut: not synced across devices; add a user preference column when someone asks.

UI:

- Settings → Appearance, registered in `lib/nav` so it is also in the command palette. It has Mode as a `Segmented` control, a filter field, and the themes by group as native radio cards. Each card is a live render of the app in that theme (sidebar, card, status dots, primary button, radius). Arrow keys move between themes. "Back to LogiStack Default" appears when another theme is active.
- The theme menu in the top bar links to it ("More themes…").

Out of scope: importing a VS Code theme JSON, user-made themes, a per-organization default theme, the presets' fonts.

## Open questions

- Should the shadcn presets also bring their fonts? Today they keep Mona Sans.
- Should the theme follow the user across devices (server-side preference) from day one?
- Should the setup wizard ask for the organization logo, or is Settings enough?

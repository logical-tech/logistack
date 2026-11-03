# LogiStack web: design system

Operate-mode product UI in the Vercel / better-auth register: quiet surfaces, one ink, colour spent on status.

## Type

- **Mona Sans** (variable, width axis), self-hosted via Fontsource. A workhorse grotesk with tabular figures and open shapes at 13 to 14 px, from GitHub's developer-tool lineage, and not Vercel's own Geist. Headings run at `font-stretch: 108%` for a little authority without a second family.
- **Monaspace Neon** only for data: commit SHAs, image refs, hostnames, DNS records, IPs. Sized down with `font-size-adjust: 0.47` because it is ~26% wider.
- Fixed rem scale, no fluid type: 11 / 12 / 13 / 14 (body) / 16 / 18 / 22 / 28. Self-hosting means the UI works on air-gapped servers.

## Colour

Tokens live in `src/styles/index.css` on `:root` and `.dark` (OKLCH).

- Two neutral layers: `--sidebar` (chrome) and `--background` (content), cards one step up. Slight cool tint (hue 258–262).
- `--primary` is ink: near-black in light, near-white in dark. Primary buttons are ink, never brand.
- `--brand` cobalt for focus rings, the active wizard step and selection only.
- Status vocabulary, each with a solid (`--ok`) and a text variant (`--ok-text`, ≥4.5:1): `ok` running/ready, `busy` starting/building, `info` deploying, `warn` unhealthy/draining, `bad` failed/down, `idle` stopped/cancelled. The mapping is one registry, `src/lib/status.ts`.

## Signature

The **signal strip** (`components/signal-strip.tsx`): one cell per service, worst first, coloured by status. It appears on Home, project cards and environment tabs, and the logo mark is three of its cells.

## Motion

Tokens from transitions-dev in `src/styles/motion.css`: 150 ms close, 250 ms open, 400 ms reveal, `cubic-bezier(0.22, 1, 0.36, 1)`. Dialogs scale from 0.96, menus grow from their trigger at 0.97, tabs slide an underline, changed digits pop in, status labels cross-blur on change, toasts rise, wizard steps slide in their direction. Buttons press to 0.96. `prefers-reduced-motion` collapses every animation to 1 ms.

## Components

- `Wizard` (`components/wizard/`) is the only way to build a setup flow: steps rail, per-step zod schema, `test` steps that gate Continue, `Summary` with edit links, Enter to continue and Alt+Left to go back, step in the URL, non-secret answers in sessionStorage.
- `EmptyState`, `Panel` + `SkeletonRows`, `StatusDot`/`ServiceStatus`, `AnimatedNumber`, `SlidingTabs`, `DataTable` (TanStack Table v9).
- Sections are registered once in `src/lib/nav.ts`; sidebar, command palette and placeholder pages read it.

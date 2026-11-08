# Open-source launch

Status: prepared on 2026-11-08, not published. Nothing in this plan has been posted, and the repository is still private. Every step that changes visibility, settings or posts anything is for the owner to run.

Why now: Coolify (~66k stars) and Dokploy (~38k) win on distribution, not on features (`docs/research/competitors-2026-11.md`, section 5, P2). LogiStack's differentiators (no shell strings, a reconciler, label-scoped cleanup, no license gates, a migration wizard from both) only count once people can see the code.

## 1. License

Recommendation: **keep Apache-2.0**, which `LICENSE`, `NOTICE` and the image annotations in `release.yml` already use.

- It matches rule 9 ("no feature gated behind a license") and the "No license gates" docs page. A single permissive license is the simplest promise to keep.
- Its patent grant protects users and contributors, which MIT does not spell out.
- It is the license of Coolify and of most of Dokploy, so moving between them raises no license question, and the templates adapted from Coolify (Apache-2.0) and Dokploy (MIT) stay compatible. `NOTICE` already lists that attribution.
- AGPL would deter the hosting providers we want as partners (research, P2 item 16) and buys nothing for a self-hosted tool. A source-available license (DSAL, BSL) is exactly what the launch argues against.

Before launch, confirm one thing with a lawyer if in doubt: Logical Tech holds the copyright of every commit (single author identity `info@logicaltech.it`), so no relicensing consent is needed. Outside contributions after launch come in under Apache-2.0 section 5; no CLA is needed.

## 2. Prerequisites (blocking)

Do not launch until all of these are true:

- [ ] **P0 security merged** into `main`: the instance-admin role (any org admin can update the instance today, `routes/updates.ts`, `routes/instance-settings.ts`), SSRF DNS pinning, API key rate limits, unique indexes on SSO and 2FA rows (research, P0 items 3 and 4). A launch that leads with a security page cannot ship with a known authorization gap of the kind it criticises.
- [ ] **Real VPS validation, by the owner**: a clean install on a fresh VPS, the setup wizard with `--public-setup`, a deploy from GitHub, a domain with Let's Encrypt, a backup and restore, an in-app update between two published releases.
- [ ] **Multi-node validation, by the owner**: a 3-node Swarm, a node added from the dashboard, a service spread across nodes, a node drained and lost, backups and schedules on the node that holds the data.
- [ ] **Migrations on real installs, by the owner**: the wizard run on a real Dokploy and a real Coolify server, end to end through **Remove**. These are the main acquisition channel; the ten-minute guide must hold.
- [ ] **A stable release tagged** on `main` with these changes, its images public on ghcr.io (one-time click per package, `docs/INSTALL.md`, "Publishing a release"), and `install.sh` served from `stack.logicaltech.it`.
- [ ] **Release channels live**: `release.yml` with the nightly schedule is on `main` (schedules run only from the default branch's copy), one nightly and one beta have published, and an instance on each channel sees them.
- [ ] **Secrets and history checked**: `gitleaks detect` (or GitHub secret scanning once public) over the whole history, no customer names in fixtures, no internal hostnames in docs. Rotate anything found before the repository goes public; rewriting history is not enough.
- [ ] **Docs and site deployed** with the three launch pages: Security model, Migrate in 10 minutes, No license gates.
- [ ] **The research numbers re-checked** on launch day: the advisory counts on the Security model page, the README and the site are dated "12 months up to November 2026". Update them, or the date, if the launch slips.

## 3. GitHub settings to change (owner only)

None of these were changed. In `logical-tech/logistack` › **Settings**:

- [ ] **General › Features**: turn on **Discussions** (the issue template's config links to it), keep **Issues**, turn off **Wiki** and **Projects** unless used.
- [ ] **General › Pull Requests**: allow squash merging only, default message "Pull request title and description", turn on "Always suggest updating pull request branches" and "Automatically delete head branches".
- [ ] **Code security**: turn on **Private vulnerability reporting** (`SECURITY.md` and the issue template link to it), **Dependency graph**, **Dependabot alerts**, **Dependabot security updates**, **Secret scanning** and **Push protection**, and **CodeQL** default setup for JavaScript/TypeScript and Actions.
- [ ] **Branches**: a ruleset on `main` and `develop`: require a pull request, require the `ci` checks, block force pushes and deletion.
- [ ] **Actions › General**: "Require approval for all outside collaborators" for workflows from forks; default `GITHUB_TOKEN` permissions read-only (the workflows already declare their own).
- [ ] **Discussions** categories: Announcements (maintainers only), Q&A, Ideas, Show and tell, Migrations.
- [ ] **About**: description "Open-source self-hosted PaaS on Docker Swarm. A reconciler, no shell strings, no license gates.", website `https://stack.logicaltech.it`, topics `paas`, `self-hosted`, `docker-swarm`, `caddy`, `heroku-alternative`, `dokploy-alternative`, `coolify-alternative`, `devops`.
- [ ] **Social preview** image: the site's Open Graph image.
- [ ] **Packages**: each of the four ghcr.io packages linked to the repository and public.
- [ ] Finally, **Danger Zone › Change visibility** to public.

## 4. Repository hygiene (done in this branch)

- `README.md`: try it in 60 seconds with the setup token, screenshots from the web mock, features, a comparison table.
- `SECURITY.md` (process and channels), `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md` (rule against license gates added).
- `.github/ISSUE_TEMPLATE/config.yml` (security and Discussions links, blank issues off), `.github/pull_request_template.md`.
- Release channels stable / beta / nightly in **Settings › Updates**, with the changelog of every release an update crosses and its breaking changes shown first.

Left out on purpose: a `GOVERNANCE.md` and a `MAINTAINERS` file. With one maintainer they would describe nothing; write them when a second maintainer joins.

## 5. Launch checklist

Day order matters: the post that brings traffic goes out only when everything it links to works.

**One week before**

- [ ] Write the technical blog post (section 6) and have someone outside the project read it.
- [ ] Record a 60-second screen capture: install with `--public-setup`, open the link, deploy a template, add a domain. Use it in the README and the post.
- [ ] Seed Discussions with three real Q&A threads (install next to Dokploy, wildcard DNS, backups to S3).
- [ ] Label 10 to 15 issues `good first issue` with enough context to start.

**Launch day (a Tuesday or Wednesday, 15:00 to 16:00 CET, which is morning in the US)**

- [ ] Make the repository public; check the README renders, the install command works from a clean VPS, and ghcr.io images pull without credentials.
- [ ] **Show HN**: "Show HN: LogiStack, a self-hosted PaaS with a reconciler and no shell strings". The first comment, written in advance, says who builds it, why, what is different, what is not done yet (no HA control plane yet, young project), and links the security model and the migration guide. Stay in the thread for the first four hours and answer everything, critics first.
- [ ] **r/selfhosted**: a text post, not a link post, following the subreddit's self-promotion rules: what it is, screenshots, the migration path, the license, an honest "what's missing" list. Post a few hours after Show HN, not at the same time.
- [ ] Publish the blog post on the site and cross-post it to dev.to or Hashnode with a canonical link.

**The week after**

- [ ] Answer every issue and discussion within a day. First impressions of maintainer response decide whether people stay.
- [ ] Turn recurring questions into FAQ entries and docs fixes.
- [ ] Post a short follow-up on what changed from the feedback, in Discussions › Announcements.
- [ ] Later, separately: r/docker, r/devops, lobste.rs (needs an invite), the Awesome-Selfhosted list (pull request once the project has a release history), Product Hunt only if there is a hosted demo.

**Do not**: post in Dokploy's or Coolify's own Discord, Discussions or issues; compare in titles ("Dokploy killer"); quote advisory counts outside the factual pages that link them.

## 6. Technical blog post

Working title: **"Why our PaaS never runs a shell command: a reconciler instead of scripts"**.

Outline:

1. The problem, with numbers: in 12 months, the two most popular self-hosted PaaS tools published about 115 security advisories between them, most of them a value (a branch name, a volume name) reaching a shell string that runs as root. Link both advisory pages. No names in the title, no mockery in the text; the point is the class of bug.
2. Why shell strings are the default: they are the fastest way to wrap Docker, and they work until a value has a quote in it.
3. What we do instead: the Docker Engine API over the Unix socket, `Bun.spawn([...argv])`, secrets through env and stdin. A short before/after code sample, written for the post, not taken from any other project.
4. The reconciler: desired state in Postgres, a 30-second loop, idempotent operations, pure compilers with snapshot tests. Why it also fixes drift and half-finished deploys.
5. Label-scoped cleanup: why `docker system prune` on a shared server is dangerous, and how `logistack.managed=true` limits the blast radius.
6. Migrations that only add, so an update can roll back.
7. What this does not solve: authorization still has to be right on every route, admins are root by design, and the project is younger and less tested in the wild. Link `SECURITY.md`.
8. Try it: the one-line install, the migration guide.

Length: 1,500 to 2,000 words, one diagram of the reconcile loop (reuse the site's figure), code in TypeScript.

## 7. After launch

- Watch the advisory inbox daily for the first month. A first advisory handled quickly and openly is worth more than none.
- Add `stable`, `beta` and `nightly` badges to the README once all three channels have published.
- Nightly images pile up on ghcr.io: `release.yml` prunes nightly GitHub releases (keeps 14) but not their images. Add a package cleanup (for example a scheduled `actions/delete-package-versions` on tags matching `-nightly.`) within the first month.

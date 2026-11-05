/**
 * Converts Coolify and Dokploy templates into the LogiStack catalog.
 *
 *   bun packages/templates/scripts/convert.ts --coolify <coolify repo> --dokploy <templates repo> [--resolve]
 *
 * Writes one `<id>.json` per template, `index.json` for the gallery, `logos/` and
 * `skipped.json` (every template left out, and why) into `packages/templates/catalog/`.
 * Floating image tags are pinned to digests from `pins.json`; `--resolve` asks the
 * registries for the ones it lacks and records them, so reruns are offline and stable.
 */
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";
import { parseArgs } from "node:util";
import {
	floatingTags,
	PinnedImage,
	Template,
	type TemplateCategory,
	type TemplateSummary,
} from "@logistack/contracts";
import { type Reason, Skip } from "../src/compose.ts";
import { fromCoolify } from "./coolify.ts";
import { fromDokploy } from "./dokploy.ts";
import type { Draft } from "./draft.ts";

const CATEGORY: Record<string, TemplateCategory> = {
	ai: "ai",
	llm: "ai",
	mcp: "ai",
	chatbot: "ai",
	analytics: "analytics",
	automation: "automation",
	workflow: "automation",
	cms: "cms",
	blog: "cms",
	website: "cms",
	messaging: "communication",
	email: "communication",
	mail: "communication",
	chat: "communication",
	helpdesk: "communication",
	communication: "communication",
	rss: "communication",
	database: "database",
	databases: "database",
	postgres: "database",
	backend: "devtools",
	devtools: "devtools",
	development: "devtools",
	"developer-tools": "devtools",
	git: "devtools",
	ci: "devtools",
	api: "devtools",
	finance: "finance",
	media: "media",
	games: "media",
	video: "media",
	streaming: "media",
	music: "media",
	monitoring: "monitoring",
	observability: "monitoring",
	proxy: "networking",
	vpn: "networking",
	networking: "networking",
	auth: "security",
	security: "security",
	authentication: "security",
	storage: "storage",
	"file-sharing": "storage",
	s3: "storage",
	backup: "storage",
	productivity: "productivity",
	notes: "productivity",
	documentation: "productivity",
	search: "productivity",
	bookmarks: "productivity",
	collaboration: "productivity",
};

const LOGO_TYPES = new Set([".svg", ".png", ".jpg", ".jpeg", ".webp"]);
const MAX_LOGO_BYTES = 48 * 1024;

type Skipped = { source: string; path: string; reasons: Reason[] };

function category(hints: string[]): TemplateCategory {
	for (const h of hints.flatMap((x) => x.toLowerCase().split(/[,\s]+/)))
		if (CATEGORY[h]) return CATEGORY[h];
	return "other";
}

/** Drops the upstream platform's own pitch ("Self-host it with Dokploy...") from a description. */
function plainDescription(d: string): string {
	const sentences = d.match(/[^.!?]+[.!?]*\s*/g) ?? [];
	return sentences
		.filter((s) => !/dokploy|coolify/i.test(s))
		.join("")
		.trim()
		.slice(0, 1000);
}

const ACRONYMS = new Set([
	"db",
	"url",
	"api",
	"smtp",
	"jwt",
	"id",
	"s3",
	"aws",
	"ssl",
	"tls",
	"dns",
	"ip",
	"ui",
	"ldap",
	"oidc",
	"sso",
	"http",
	"https",
]);

/** `DB_PASSWORD` / `main_domain` to `DB password` / `Main domain`. */
export function humanize(label: string): string {
	const words = label
		.split(/[_\s-]+/)
		.filter(Boolean)
		.map((w) =>
			ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.toLowerCase(),
		);
	const first = words[0] ?? "";
	return [
		first.charAt(0).toUpperCase() + first.slice(1),
		...words.slice(1),
	].join(" ");
}

function cleanUrl(u: string | undefined): string | undefined {
	const url = u ? URL.parse(u.trim()) : null;
	if (!url || !/^https?:$/.test(url.protocol)) return undefined;
	for (const k of [...url.searchParams.keys()])
		if (k.startsWith("utm_")) url.searchParams.delete(k);
	return url.href;
}

/** `nginx` → `registry-1.docker.io`, `library/nginx`, `latest`. */
function imageParts(image: string) {
	const at = image.indexOf("@");
	const name = at >= 0 ? image.slice(0, at) : image;
	const slash = name.lastIndexOf("/");
	const colon = name.lastIndexOf(":");
	const repo = colon > slash ? name.slice(0, colon) : name;
	const tag = colon > slash ? name.slice(colon + 1) : "latest";
	const [first = "", ...rest] = repo.split("/");
	const hasRegistry =
		rest.length > 0 &&
		(first.includes(".") || first.includes(":") || first === "localhost");
	const registry = hasRegistry
		? first === "docker.io"
			? "registry-1.docker.io"
			: first
		: "registry-1.docker.io";
	let repository = hasRegistry ? rest.join("/") : repo;
	if (registry === "registry-1.docker.io" && !repository.includes("/"))
		repository = `library/${repository}`;
	return { repo, tag, registry, repository };
}

const MANIFEST_TYPES = [
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/** The digest a tag points at now, via an anonymous pull token. */
async function resolveDigest(image: string): Promise<string | undefined> {
	const { registry, repository, tag } = imageParts(image);
	const url = `https://${registry}/v2/${repository}/manifests/${tag}`;
	const head = (token?: string) =>
		fetch(url, {
			method: "HEAD",
			headers: {
				accept: MANIFEST_TYPES,
				...(token && { authorization: `Bearer ${token}` }),
			},
			signal: AbortSignal.timeout(15_000),
		});
	try {
		let res = await head();
		const challenge = res.headers.get("www-authenticate");
		if (res.status === 401 && challenge?.startsWith("Bearer ")) {
			const p = Object.fromEntries(
				[...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
			);
			const realm = new URL(p.realm as string);
			if (p.service) realm.searchParams.set("service", p.service);
			realm.searchParams.set(
				"scope",
				p.scope ?? `repository:${repository}:pull`,
			);
			const t = (await (
				await fetch(realm, { signal: AbortSignal.timeout(15_000) })
			).json()) as {
				token?: string;
				access_token?: string;
			};
			res = await head(t.token ?? t.access_token);
		}
		const digest = res.headers.get("docker-content-digest");
		return res.ok && digest?.startsWith("sha256:") ? digest : undefined;
	} catch {
		return undefined;
	}
}

/** A floating image is one PinnedImage refuses: `latest`, no tag, or a moving tag such as `stable`. */
const isFloating = (image: string) => !PinnedImage.safeParse(image).success;

/** Numeric parts of a tag, for "newer pinned image" comparisons; digests sort below any tag. */
function tagVersion(image: string): number[] {
	if (image.includes("@")) return [-1];
	return [...imageParts(image).tag.matchAll(/\d+/g)].map((m) => Number(m[0]));
}
function compareVersions(a: number[], b: number[]): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const d = (a[i] ?? 0) - (b[i] ?? 0);
		if (d) return d;
	}
	return 0;
}

const primaryImage = (t: Template) => {
	const s =
		t.services.find(
			(x) =>
				x.kind === "application" &&
				x.public &&
				t.inputs.some(
					(i) =>
						i.type === "domain" &&
						i.role === "primary" &&
						i.key === x.public?.domain,
				),
		) ?? t.services[0];
	return s?.kind === "application"
		? s.image
		: s
			? `${s.engine}:${s.version}`
			: "";
};

async function main() {
	const { values: args } = parseArgs({
		options: {
			coolify: { type: "string" },
			dokploy: { type: "string" },
			out: { type: "string", default: join(import.meta.dir, "../catalog") },
			resolve: { type: "boolean", default: false },
		},
	});
	const out = args.out as string;
	const pinsPath = join(import.meta.dir, "pins.json");
	const pins: Record<string, string> = existsSync(pinsPath)
		? JSON.parse(readFileSync(pinsPath, "utf8"))
		: {};
	const skipped: Skipped[] = [];
	const drafts: { draft: Draft; root: string }[] = [];
	let attempted = 0;
	const attempt = (
		source: string,
		path: string,
		root: string,
		run: () => Draft,
	) => {
		attempted++;
		try {
			drafts.push({ draft: run(), root });
		} catch (e) {
			skipped.push({
				source,
				path,
				reasons:
					e instanceof Skip
						? e.reasons
						: [{ code: "invalid", detail: (e as Error).message }],
			});
		}
	};

	if (args.coolify) {
		const dir = join(args.coolify, "templates/compose");
		for (const f of readdirSync(dir)
			.filter((f) => /\.ya?ml$/.test(f))
			.sort())
			attempt("coolify", `templates/compose/${f}`, args.coolify, () =>
				fromCoolify(
					f.replace(/\.ya?ml$/, ""),
					readFileSync(join(dir, f), "utf8"),
				),
			);
	}
	if (args.dokploy) {
		const dir = join(args.dokploy, "blueprints");
		for (const folder of readdirSync(dir).sort()) {
			const p = (f: string) => join(dir, folder, f);
			if (!existsSync(p("docker-compose.yml"))) continue;
			attempt("dokploy", `blueprints/${folder}`, args.dokploy, () =>
				fromDokploy({
					folder,
					meta: existsSync(p("meta.json"))
						? JSON.parse(readFileSync(p("meta.json"), "utf8"))
						: {},
					toml: existsSync(p("template.toml"))
						? readFileSync(p("template.toml"), "utf8")
						: "",
					compose: readFileSync(p("docker-compose.yml"), "utf8"),
				}),
			);
		}
	}

	// Pin every floating image: from pins.json, else from the registry with --resolve.
	const floating = new Set(
		drafts.flatMap(({ draft }) =>
			draft.services.flatMap((s) =>
				s.kind === "application" && isFloating(s.image) ? [s.image] : [],
			),
		),
	);
	if (args.resolve) {
		const todo = [...floating].filter(
			(i) => !pins[i] && !i.includes("${") && !i.includes("@"),
		);
		for (let i = 0; i < todo.length; i += 8)
			await Promise.all(
				todo.slice(i, i + 8).map(async (image) => {
					const d = await resolveDigest(image);
					if (d) pins[image] = d;
				}),
			);
		writeFileSync(
			pinsPath,
			`${JSON.stringify(Object.fromEntries(Object.entries(pins).sort()), null, "\t")}\n`,
		);
	}

	const built: { template: Template; logoFrom?: string }[] = [];
	for (const { draft, root } of drafts) {
		const reasons: Reason[] = [];
		for (const s of draft.services) {
			if (s.kind !== "application" || !isFloating(s.image)) continue;
			const digest = pins[s.image];
			if (digest) s.image = `${imageParts(s.image).repo}@${digest}`;
			else
				reasons.push({
					code: "unpinned",
					detail: `${s.image} has no pinned tag or digest`,
				});
		}
		const { categoryHint, logoFile, version, ...rest } = draft;
		const logoFrom =
			logoFile &&
			[join(root, logoFile), join(root, "public", logoFile)].find(
				(p) => existsSync(p) && statSync(p).isFile(),
			);
		const ext = logoFrom ? extname(logoFrom).toLowerCase() : "";
		const logoOk =
			logoFrom &&
			LOGO_TYPES.has(ext) &&
			statSync(logoFrom).size <= MAX_LOGO_BYTES;
		const candidate = {
			...rest,
			schema: 1 as const,
			name: rest.name.slice(0, 100),
			description: plainDescription(rest.description),
			tags: [...new Set(rest.tags)].filter((t) => t.length <= 40).slice(0, 20),
			category: category(categoryHint),
			inputs: rest.inputs.map((i) => ({ ...i, label: humanize(i.label) })),
			...(cleanUrl(rest.website)
				? { website: cleanUrl(rest.website) }
				: { website: undefined }),
			...(cleanUrl(rest.docs)
				? { docs: cleanUrl(rest.docs) }
				: { docs: undefined }),
			...(logoOk && {
				logo: `logos/${rest.id}${ext === ".jpeg" ? ".jpg" : ext}`,
			}),
			version: "pending",
		};
		const t0 = {
			...candidate,
			version: version && !floatingTags.has(version) ? version : "",
		};
		const primary = primaryImage(t0 as Template);
		const tag = primary.includes("@")
			? primary.slice(primary.indexOf("@") + 1, primary.indexOf("@") + 20)
			: imageParts(primary).tag;
		const parsed = Template.safeParse({ ...t0, version: t0.version || tag });
		if (!parsed.success)
			reasons.push(
				...parsed.error.issues.map((i) => ({
					code: "schema",
					detail: `${i.path.join(".")}: ${i.message}`,
				})),
			);
		if (reasons.length || !parsed.success) {
			skipped.push({
				source: rest.source.kind,
				path: rest.source.path,
				reasons,
			});
			continue;
		}
		built.push({ template: parsed.data, ...(logoOk && { logoFrom }) });
	}

	// One template per id: the newer pinned primary image wins, the other fills missing metadata.
	const byId = new Map<string, (typeof built)[number]>();
	let merged = 0;
	for (const b of built) {
		const other = byId.get(b.template.id);
		if (!other) {
			byId.set(b.template.id, b);
			continue;
		}
		merged++;
		const [win, lose] =
			compareVersions(
				tagVersion(primaryImage(b.template)),
				tagVersion(primaryImage(other.template)),
			) > 0
				? [b, other]
				: [other, b];
		const w = win.template;
		const l = lose.template;
		byId.set(w.id, {
			template: {
				...w,
				description: w.description || l.description,
				tags: [...new Set([...w.tags, ...l.tags])].slice(0, 20),
				...((w.website ?? l.website) && { website: w.website ?? l.website }),
				...((w.docs ?? l.docs) && { docs: w.docs ?? l.docs }),
				...(w.logo || l.logo ? { logo: w.logo ?? l.logo } : {}),
				category: w.category === "other" ? l.category : w.category,
			},
			...((win.logoFrom ?? lose.logoFrom) && {
				logoFrom: win.logoFrom ?? lose.logoFrom,
			}),
		});
	}

	rmSync(out, { recursive: true, force: true });
	mkdirSync(join(out, "logos"), { recursive: true });
	const index: TemplateSummary[] = [];
	for (const { template: t, logoFrom } of [...byId.values()].sort((a, b) =>
		a.template.id.localeCompare(b.template.id),
	)) {
		if (t.logo && logoFrom) copyFileSync(logoFrom, join(out, t.logo));
		writeFileSync(
			join(out, `${t.id}.json`),
			`${JSON.stringify(t, null, "\t")}\n`,
		);
		const short =
			t.description.length > 160
				? `${t.description.slice(0, 157).replace(/\s+\S*$/, "")}…`
				: t.description;
		index.push({
			id: t.id,
			name: t.name,
			description: short,
			category: t.category,
			tags: t.tags,
			...(t.logo && { logo: t.logo }),
			source: t.source.kind,
			services: t.services.length,
		});
	}
	writeFileSync(
		join(out, "index.json"),
		`${JSON.stringify(index, null, "\t")}\n`,
	);

	const counts: Record<string, number> = {};
	for (const s of skipped)
		for (const code of new Set(s.reasons.map((r) => r.code)))
			counts[code] = (counts[code] ?? 0) + 1;
	const sources = {
		coolify: skipped.filter((s) => s.source === "coolify").length,
		dokploy: skipped.filter((s) => s.source === "dokploy").length,
	};
	writeFileSync(
		join(out, "skipped.json"),
		`${JSON.stringify({ counts: Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1])), skipped: skipped.sort((a, b) => a.path.localeCompare(b.path)) }, null, "\t")}\n`,
	);
	console.log(
		JSON.stringify(
			{
				read: attempted,
				converted: built.length,
				catalog: index.length,
				mergedDuplicates: merged,
				skipped: { total: skipped.length, ...sources },
				byReason: counts,
			},
			null,
			2,
		),
	);
}

await main();

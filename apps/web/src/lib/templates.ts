/*
 * Pure logic behind the template flow: gallery search, how each input is presented,
 * the deploy request built from the form, and the name-conflict check.
 */
import {
	Hostname,
	secretInputTypes,
	type Template,
	type TemplateCategory,
	type TemplateInput,
	type TemplateSummary,
} from "@logistack/contracts";
import { z } from "zod";

export const CATEGORY_LABEL: Record<TemplateCategory, string> = {
	ai: "AI",
	analytics: "Analytics",
	automation: "Automation",
	cms: "CMS",
	communication: "Communication",
	database: "Databases",
	devtools: "Dev tools",
	finance: "Finance",
	media: "Media",
	monitoring: "Monitoring",
	networking: "Networking",
	productivity: "Productivity",
	security: "Security",
	storage: "Storage",
	other: "Other",
};

const fold = (s: string) =>
	s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

const words = (s: string) => s.split(/[^a-z0-9]+/).filter(Boolean);

/** Every character of `needle` appears in `hay` in order: "mnflx" finds "miniflux". */
function isSubsequence(needle: string, hay: string) {
	let i = 0;
	for (const c of hay) if (c === needle[i]) i += 1;
	return i === needle.length;
}

/** How well one query word matches a template; 0 means it does not. Name beats tags beats prose. */
function wordScore(t: TemplateSummary, w: string): number {
	const name = fold(t.name);
	const nameWords = words(name);
	const tags = t.tags.map(fold);
	if (name === w || t.id === w) return 100;
	if (name.startsWith(w) || t.id.startsWith(w)) return 80;
	if (nameWords.some((p) => p.startsWith(w))) return 60;
	if (tags.includes(w)) return 50;
	if (name.includes(w) || t.id.includes(w)) return 40;
	if (tags.some((tag) => words(tag).some((p) => p.startsWith(w)))) return 30;
	if (words(fold(t.description)).some((p) => p.startsWith(w))) return 15;
	if (w.length >= 3 && isSubsequence(w, t.id)) return 8;
	return 0;
}

/** Templates matching every word of `query`, best first; the whole list by name when it is empty. */
export function searchTemplates(
	list: TemplateSummary[],
	query: string,
): TemplateSummary[] {
	const q = words(fold(query));
	if (!q.length) return [...list].sort((a, b) => a.name.localeCompare(b.name));
	const scored: { t: TemplateSummary; score: number }[] = [];
	for (const t of list) {
		let score = 0;
		for (const w of q) {
			const s = wordScore(t, w);
			if (!s) {
				score = 0;
				break;
			}
			score += s;
		}
		if (score) scored.push({ t, score });
	}
	return scored
		.sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name))
		.map((s) => s.t);
}

export function categoryCounts(list: TemplateSummary[]) {
	const counts = new Map<TemplateCategory, number>();
	for (const t of list)
		counts.set(t.category, (counts.get(t.category) ?? 0) + 1);
	return counts;
}

/** Two letters for a template without a logo: initials of a multi-word name, else its first two. */
export function monogram(name: string) {
	const parts = name.match(/[A-Za-z0-9]+/g) ?? ["?"];
	const letters =
		parts.length > 1
			? `${parts[0]?.[0]}${parts[1]?.[0]}`
			: (parts[0] ?? "?").slice(0, 2);
	return letters.toUpperCase();
}

/**
 * How the form presents an input. `required` is text with no default; `optional` is text
 * with one; `generated` is everything the server fills in when left empty.
 */
export type InputGroup = "domain" | "required" | "generated" | "optional";

export function inputGroup(i: TemplateInput): InputGroup {
	if (i.type === "domain") return "domain";
	if (i.type === "text")
		return i.default === undefined ? "required" : "optional";
	return "generated";
}

export const isSecretInput = (i: TemplateInput) =>
	secretInputTypes.includes(i.type);

const hostnameOk = (v: string) =>
	!v.startsWith("*.") && Hostname.safeParse(v).success;

/** The inputs step's validation, with the same rules the server applies. */
export function inputsSchema(t: Template) {
	const shape: Record<string, z.ZodType> = {};
	for (const i of t.inputs) {
		const group = inputGroup(i);
		if (group === "required")
			shape[i.key] = z
				.string({ error: `Enter ${i.label.toLowerCase()}.` })
				.trim()
				.min(1, `Enter ${i.label.toLowerCase()}.`);
		if (group === "domain")
			shape[i.key] = z
				.string()
				.trim()
				.optional()
				.refine(
					(v) => !v || hostnameOk(v),
					"Use a hostname like app.example.com, or leave it empty.",
				);
	}
	return z.object(shape);
}

/** The deploy request's `inputs`: only what was typed; empty ones are left for the server to fill. */
export function deployInputs(
	t: Template,
	values: Record<string, string | undefined>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const i of t.inputs) {
		const raw = values[i.key] ?? "";
		if (!raw.trim()) continue;
		// Typed credentials are sent as typed; names and hostnames lose stray spaces.
		out[i.key] = isSecretInput(i)
			? raw
			: i.type === "domain"
				? raw.trim().toLowerCase()
				: raw.trim();
	}
	return out;
}

type Existing = { slug: string; importedFrom?: string | null };

/** The environment already runs an instance with this name; the server answers a repeat with it. */
export const isRepeat = (instance: string, existing: Existing[]) =>
	existing.some(
		(s) => s.importedFrom?.match(/^template:[^:]+:(.+)\//)?.[1] === instance,
	);

/**
 * Template service names the environment already uses; each service keeps its name as its
 * DNS alias. None for a repeat of the same instance, which creates nothing.
 */
export function nameConflicts(
	t: Pick<Template, "id" | "services">,
	existing: Existing[],
	instance = t.id,
): string[] {
	if (isRepeat(instance, existing)) return [];
	const taken = new Set(existing.map((s) => s.slug));
	return t.services.map((s) => s.name).filter((n) => taken.has(n));
}

export type PublicRoute = {
	service: string;
	port: number;
	input: Extract<TemplateInput, { type: "domain" }>;
};

/** Services reachable from the internet, the primary one first. */
export function publicRoutes(t: Template): PublicRoute[] {
	const routes: PublicRoute[] = [];
	for (const s of t.services) {
		if (s.kind !== "application" || !s.public) continue;
		const input = t.inputs.find((i) => i.key === s.public?.domain);
		if (input?.type === "domain")
			routes.push({ service: s.name, port: s.public.port, input });
	}
	return routes.sort(
		(a, b) =>
			Number(b.input.role === "primary") - Number(a.input.role === "primary"),
	);
}

/** What a service runs: its image, or `engine:version` for a managed database. */
export const serviceImage = (s: Template["services"][number]) =>
	s.kind === "application" ? s.image : `${s.engine}:${s.version}`;

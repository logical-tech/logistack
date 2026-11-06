import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Read at build time so what the site shows is what the catalog ships. */
export const catalogDir = join(
	process.cwd(),
	"..",
	"packages",
	"templates",
	"catalog",
);

export type TemplateSummary = {
	id: string;
	name: string;
	description: string;
	category: string;
	tags: string[];
	logo?: string;
	services: number;
};

type Input = {
	key: string;
	label: string;
	type: string;
	role?: "primary" | "extra";
	default?: string;
};

type Service =
	| {
			kind: "application";
			name: string;
			image: string;
			volumes: unknown[];
			public?: { port: number };
	  }
	| {
			kind: "database";
			name: string;
			engine: string;
			version: string;
			volumes: unknown[];
	  };

export type Template = TemplateSummary & {
	website?: string;
	docs?: string;
	source: { kind: "coolify" | "dokploy"; path: string; license: string };
	inputs: Input[];
	services: Service[];
};

export const categories: Record<string, string> = {
	productivity: "Productivity",
	devtools: "Developer tools",
	media: "Media",
	ai: "AI",
	communication: "Communication",
	monitoring: "Monitoring",
	cms: "CMS and sites",
	storage: "Storage",
	security: "Security",
	database: "Databases",
	analytics: "Analytics",
	finance: "Finance",
	automation: "Automation",
	networking: "Networking",
	other: "Other",
};

export const categoryLabel = (c: string) => categories[c] ?? c;

let index: TemplateSummary[] | undefined;

export function catalogIndex(): TemplateSummary[] {
	index ??= (
		JSON.parse(
			readFileSync(join(catalogDir, "index.json"), "utf8"),
		) as TemplateSummary[]
	).sort((a, b) => a.name.localeCompare(b.name, "en"));
	if (index.length === 0) throw new Error(`no templates in ${catalogDir}`);
	return index;
}

export const templateCount = () => catalogIndex().length;

export function readTemplate(id: string): Template {
	if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`bad template id ${id}`);
	return JSON.parse(
		readFileSync(join(catalogDir, `${id}.json`), "utf8"),
	) as Template;
}

/** `logos/n8n.svg` in the catalog is served at `/logos/n8n.svg`. */
export const logoUrl = (logo?: string) => (logo ? `/${logo}` : undefined);

/** Inputs LogiStack fills in itself when left empty. */
export const generatedTypes = new Set([
	"password",
	"secret",
	"username",
	"base64",
	"uuid",
]);

/** `wordpress@sha256:…` or `ghcr.io/x/y:1.2` → the readable image name and tag. */
export function imageName(image: string): string {
	const [name] = image.split("@");
	return (name ?? image).replace(/^docker\.io\/(library\/)?/, "");
}

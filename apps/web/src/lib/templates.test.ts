import { expect, test } from "bun:test";
import type { Template, TemplateSummary } from "@logistack/contracts";
import {
	categoryCounts,
	deployInputs,
	inputGroup,
	inputsSchema,
	monogram,
	nameConflicts,
	publicRoutes,
	searchTemplates,
} from "./templates";

const row = (
	id: string,
	name: string,
	description: string,
	tags: string[] = [],
	category: TemplateSummary["category"] = "other",
): TemplateSummary => ({
	id,
	name,
	description,
	category,
	tags,
	source: "coolify",
	services: 1,
});

const catalog = [
	row(
		"n8n",
		"n8n",
		"Workflow automation for technical teams.",
		["workflow"],
		"automation",
	),
	row(
		"n8n-with-postgres",
		"n8n with PostgreSQL",
		"n8n backed by Postgres.",
		[],
		"automation",
	),
	row(
		"miniflux",
		"Miniflux",
		"A minimalist feed reader.",
		["rss"],
		"communication",
	),
	row(
		"postgresus",
		"Postgresus",
		"Backups for PostgreSQL.",
		["backup"],
		"database",
	),
	row(
		"umami",
		"Umami",
		"Privacy-friendly analytics; works with postgres.",
		["analytics"],
		"analytics",
	),
	row(
		"plausible",
		"Plausible",
		"Simple web analytics.",
		["analytics", "privacy"],
		"analytics",
	),
];

const ids = (q: string) => searchTemplates(catalog, q).map((t) => t.id);

test("an exact name wins over names that only start with it", () => {
	expect(ids("n8n").slice(0, 2)).toEqual(["n8n", "n8n-with-postgres"]);
});

test("name prefixes outrank tags, which outrank the description", () => {
	expect(ids("post")).toEqual(["postgresus", "n8n-with-postgres", "umami"]);
	expect(ids("analytics")).toEqual(["plausible", "umami"]);
});

test("every word must match", () => {
	expect(ids("n8n postgres")).toEqual(["n8n-with-postgres"]);
	expect(ids("miniflux postgres")).toEqual([]);
});

test("a dropped letter still finds the template", () => {
	expect(ids("mnflx")).toEqual(["miniflux"]);
});

test("an empty query lists everything by name", () => {
	expect(ids("  ")).toEqual([
		"miniflux",
		"n8n",
		"n8n-with-postgres",
		"plausible",
		"postgresus",
		"umami",
	]);
});

test("categories are counted", () => {
	const counts = categoryCounts(catalog);
	expect(counts.get("analytics")).toBe(2);
	expect(counts.get("media")).toBeUndefined();
});

test("monograms take initials of a multi-word name", () => {
	expect(monogram("AdGuard Home")).toBe("AH");
	expect(monogram("umami")).toBe("UM");
});

const template = {
	schema: 1,
	id: "rallly",
	name: "Rallly",
	description: "",
	category: "productivity",
	tags: [],
	version: "4.0.0",
	source: {
		kind: "coolify",
		path: "templates/compose/rallly.yaml",
		license: "Apache-2.0",
	},
	inputs: [
		{ key: "appDomain", label: "App domain", type: "domain", role: "primary" },
		{
			key: "dbPassword",
			label: "Database password",
			type: "password",
			length: 32,
		},
		{ key: "smtpHost", label: "SMTP host", type: "text" },
		{ key: "supportEmail", label: "Support email", type: "text", default: "" },
	],
	services: [
		{
			name: "rallly",
			kind: "application",
			image: "lukevella/rallly:4.0.0",
			dependsOn: ["postgres"],
			env: {},
			volumes: [],
			files: [],
			ports: [],
			public: { port: 3000, domain: "appDomain" },
		},
		{
			name: "postgres",
			kind: "database",
			engine: "postgres",
			version: "17",
			dependsOn: [],
			env: {},
			volumes: [],
			files: [],
		},
	],
} as Template;

test("inputs are grouped by how the form shows them", () => {
	expect(template.inputs.map(inputGroup)).toEqual([
		"domain",
		"generated",
		"required",
		"optional",
	]);
});

test("the request carries only what was typed", () => {
	expect(
		deployInputs(template, {
			appDomain: " Polls.Example.com ",
			dbPassword: "",
			smtpHost: " smtp.example.com",
			supportEmail: "   ",
		}),
	).toEqual({ appDomain: "polls.example.com", smtpHost: "smtp.example.com" });
});

test("a typed password is sent exactly as typed", () => {
	expect(
		deployInputs(template, { dbPassword: " s3cret ", smtpHost: "x" }),
	).toEqual({ dbPassword: " s3cret ", smtpHost: "x" });
});

test("required text and hostnames are validated like the server does", () => {
	const schema = inputsSchema(template);
	expect(schema.safeParse({ smtpHost: "smtp" }).success).toBe(true);
	expect(schema.safeParse({ smtpHost: "  " }).success).toBe(false);
	expect(
		schema.safeParse({ smtpHost: "smtp", appDomain: "not a host" }).success,
	).toBe(false);
	expect(
		schema.safeParse({ smtpHost: "smtp", appDomain: "*.example.com" }).success,
	).toBe(false);
	expect(schema.safeParse({ smtpHost: "smtp", appDomain: "" }).success).toBe(
		true,
	);
});

test("conflicts are the template's service names already in the environment", () => {
	expect(
		nameConflicts(template, [{ slug: "web" }, { slug: "postgres" }]),
	).toEqual(["postgres"]);
	expect(nameConflicts(template, [{ slug: "rallly-db" }])).toEqual([]);
});

test("a repeat of the same instance is not a conflict", () => {
	const deployed = [
		{ slug: "rallly", importedFrom: "template:rallly:rallly/rallly" },
		{ slug: "postgres", importedFrom: "template:rallly:rallly/postgres" },
	];
	expect(nameConflicts(template, deployed)).toEqual([]);
	expect(nameConflicts(template, deployed, "polls")).toEqual([
		"rallly",
		"postgres",
	]);
	expect(
		nameConflicts(template, [
			{ slug: "postgres", importedFrom: "template:umami:umami/postgres" },
		]),
	).toEqual(["postgres"]);
});

test("the primary public route comes first", () => {
	expect(publicRoutes(template)).toEqual([
		{ service: "rallly", port: 3000, input: template.inputs[0] as never },
	]);
});

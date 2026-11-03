import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Template, TemplateSummary } from "@logistack/contracts";
import { linkHosts, Skip, shellSplit } from "../scripts/compose.ts";
import { fromCoolify } from "../scripts/coolify.ts";
import { fromDokploy } from "../scripts/dokploy.ts";
import type { Draft } from "../scripts/draft.ts";
import {
	catalogDir,
	catalogIndex,
	logoPath,
	readTemplate,
} from "../src/index.ts";

const fixtures = join(import.meta.dir, "fixtures");
const read = (p: string) => readFileSync(join(fixtures, p), "utf8");

/** A draft as the converter finalizes it, minus the network and filesystem steps. */
function finalize(d: Draft): Template {
	const { categoryHint: _c, logoFile: _l, version, ...rest } = d;
	return Template.parse({
		...rest,
		schema: 1,
		category: "other",
		version: version ?? "1",
	});
}

describe("coolify", () => {
	const draft = fromCoolify("notes", read("coolify/notes.yaml"));
	const t = finalize(draft);
	const app = t.services.find((s) => s.name === "app");
	const db = t.services.find((s) => s.name === "postgres");

	test("magic variables become typed inputs", () => {
		expect(t.inputs).toEqual([
			{
				key: "appDomain",
				type: "domain",
				role: "primary",
				label: "APP domain",
			},
			{ key: "postgresUser", type: "username", label: "POSTGRES user" },
			{
				key: "postgresPassword",
				type: "password",
				length: 32,
				label: "POSTGRES password",
			},
			{
				key: "sessionSecret",
				type: "secret",
				length: 64,
				charset: "alnum",
				label: "SESSION secret",
			},
			{ key: "smtpHost", type: "text", label: "SMTP_HOST", default: "" },
			{ key: "adminEmail", type: "text", label: "ADMIN_EMAIL" },
		]);
	});

	test("env references inputs and siblings through expressions, defaults inline", () => {
		expect(app?.env).toEqual({
			PUBLIC_URL: "https://${{ inputs.appDomain }}",
			DATABASE_URL:
				"postgres://${{ inputs.postgresUser }}:${{ inputs.postgresPassword }}@${{ services.postgres.host }}:5432/notes",
			SESSION_SECRET: "${{ inputs.sessionSecret }}",
			TZ: "UTC",
			SMTP_HOST: "${{ inputs.smtpHost }}",
			ADMIN_EMAIL: "${{ inputs.adminEmail }}",
		});
	});

	test("the declared URL makes its service public on the declared port", () => {
		expect(app).toMatchObject({
			kind: "application",
			image: "ghcr.io/example/notes:1.4.2",
			public: { port: 3000, domain: "appDomain" },
			dependsOn: ["postgres"],
			volumes: [{ name: "notes-uploads", target: "/app/uploads" }],
			healthcheck: {
				type: "command",
				command: ["sh", "-c", "wget -qO- http://127.0.0.1:3000/health"],
			},
		});
	});

	test("an official postgres with its data volume becomes a managed database", () => {
		expect(db).toMatchObject({
			kind: "database",
			engine: "postgres",
			version: "16-alpine",
		});
	});

	test("headers carry metadata and attribution", () => {
		expect(draft).toMatchObject({
			id: "notes",
			name: "Notes",
			categoryHint: ["productivity", "notes", "wiki"],
			logoFile: "svgs/notes.svg",
			source: {
				kind: "coolify",
				path: "templates/compose/notes.yaml",
				license: "Apache-2.0",
			},
		});
	});

	test("build, privileged and host binds are refused with every reason", () => {
		let reasons: string[] = [];
		try {
			fromCoolify("builder", read("coolify/builder.yaml"));
		} catch (e) {
			if (e instanceof Skip) reasons = e.reasons.map((r) => r.code);
		}
		expect(reasons.sort()).toEqual(["bind", "build", "image", "privileged"]);
	});
});

describe("dokploy", () => {
	const dir = "dokploy/demo";
	const draft = fromDokploy({
		folder: "demo",
		meta: JSON.parse(read(`${dir}/meta.json`)),
		toml: read(`${dir}/template.toml`),
		compose: read(`${dir}/docker-compose.yml`),
	});
	const t = finalize(draft);
	const web = t.services.find((s) => s.name === "web");

	test("helpers in variables and env become typed inputs", () => {
		expect(t.inputs).toEqual([
			{
				key: "mainDomain",
				type: "domain",
				role: "primary",
				label: "main_domain",
			},
			{ key: "secretKey", type: "base64", bytes: 48, label: "secret_key" },
			{ key: "dbPassword", type: "password", length: 24, label: "DB_PASSWORD" },
			{ key: "adminUser", type: "username", label: "admin_user" },
		]);
	});

	test("compose `${KEY}` resolves through .env to expressions; hosts link to siblings", () => {
		expect(web?.env).toEqual({
			APP_URL: "https://${{ inputs.mainDomain }}",
			SECRET_KEY: "${{ inputs.secretKey }}",
			DATABASE_URL:
				"mysql://demo:${{ inputs.dbPassword }}@${{ services.mysql.host }}:3306/demo",
			REDIS_HOST: "${{ services.cache.host }}",
			ADMIN_USER: "${{ inputs.adminUser }}",
		});
	});

	test("routed domain, shipped file, volumes and argv command", () => {
		expect(web).toMatchObject({
			public: { port: 8080, domain: "mainDomain" },
			command: ["serve", "--config", "/etc/demo/config.yml"],
			files: [
				{
					target: "/etc/demo/config.yml",
					content: "url: https://${{ inputs.mainDomain }}\n",
				},
			],
			volumes: [{ name: "demo-data", target: "/var/lib/demo" }],
			ports: [{ target: 8080, protocol: "tcp" }],
			restart: "any",
			dependsOn: ["mysql", "cache"],
		});
	});

	test("mysql becomes a database, redis without a password stays an application", () => {
		expect(t.services.map((s) => [s.name, s.kind])).toEqual([
			["web", "application"],
			["mysql", "database"],
			["cache", "application"],
		]);
	});

	test("metadata and attribution", () => {
		expect(draft).toMatchObject({
			id: "demo",
			name: "Demo Board",
			version: "2.1.0",
			website: "https://demo.example.org/",
			tags: ["productivity", "kanban"],
			logoFile: "blueprints/demo/demo.svg",
			source: { kind: "dokploy", path: "blueprints/demo", license: "MIT" },
		});
	});
});

describe("helpers", () => {
	test("host linking leaves userinfo and unrelated words alone", () => {
		const hosts = new Map([["db", "db"]]);
		expect(linkHosts("URL", "postgres://db:pw@db:5432/db", hosts)).toBe(
			"postgres://db:pw@${{ services.db.host }}:5432/db",
		);
		expect(linkHosts("DB_NAME", "db", hosts)).toBe("db");
		expect(linkHosts("DB_HOST", "db", hosts)).toBe("${{ services.db.host }}");
		expect(linkHosts("ADDR", "db:6379", hosts)).toBe(
			"${{ services.db.host }}:6379",
		);
	});

	test("shell splitting keeps quoted words", () => {
		expect(shellSplit(`sh -c 'echo "a b"' --x="1 2"`)).toEqual([
			"sh",
			"-c",
			'echo "a b"',
			"--x=1 2",
		]);
	});
});

describe("generated catalog", () => {
	const files = readdirSync(catalogDir).filter(
		(f) => f.endsWith(".json") && f !== "index.json" && f !== "skipped.json",
	);

	test("every template parses against schema v1", () => {
		expect(files.length).toBeGreaterThan(300);
		for (const f of files) {
			const r = Template.safeParse(
				JSON.parse(readFileSync(join(catalogDir, f), "utf8")),
			);
			if (!r.success) throw new Error(`${f}: ${r.error.message}`);
			expect(`${r.data.id}.json`).toBe(f);
		}
	});

	test("the index lists exactly the templates, with logos that exist", () => {
		const index = catalogIndex();
		expect(index.map((s) => `${s.id}.json`).sort()).toEqual([...files].sort());
		for (const s of index) {
			TemplateSummary.parse(s);
			if (s.logo) expect(logoPath(s.logo)).toBeDefined();
		}
	});

	test("no image floats", () => {
		for (const s of catalogIndex()) {
			const t = readTemplate(s.id);
			for (const svc of t?.services ?? [])
				if (svc.kind === "application")
					expect(svc.image).not.toMatch(/:latest$|^[^:@]+$/);
		}
	});
});

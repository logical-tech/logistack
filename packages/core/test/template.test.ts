import { describe, expect, test } from "bun:test";
import { Template } from "@logistack/contracts";
import { compileService } from "../src/compile-service.ts";
import { generateInput, planTemplate } from "../src/template.ts";

const template = Template.parse({
	schema: 1,
	id: "notes",
	name: "Notes",
	description: "",
	category: "productivity",
	tags: [],
	version: "1.4.2",
	source: {
		kind: "coolify",
		path: "templates/compose/notes.yaml",
		license: "Apache-2.0",
	},
	inputs: [
		{ key: "appDomain", type: "domain", role: "primary", label: "Domain" },
		{ key: "dbUser", type: "username", label: "DB user" },
		{ key: "dbPassword", type: "password", length: 24, label: "DB password" },
		{ key: "tz", type: "text", default: "UTC", label: "Time zone" },
	],
	services: [
		{
			name: "app",
			kind: "application",
			image: "ghcr.io/example/notes:1.4.2",
			dependsOn: ["db"],
			env: {
				DATABASE_URL:
					"postgres://${{ inputs.dbUser }}:${{ inputs.dbPassword }}@${{ services.db.host }}:5432/notes",
				PUBLIC_URL: "https://${{ inputs.appDomain }}",
				TZ: "${{ inputs.tz }}",
			},
			command: ["serve", "--url", "https://${{ inputs.appDomain }}"],
			volumes: [{ name: "uploads", target: "/app/uploads" }],
			files: [
				{
					target: "/etc/notes.yml",
					content: "host: ${{ inputs.appDomain }}\n",
				},
			],
			public: { port: 3000, domain: "appDomain" },
		},
		{
			name: "db",
			kind: "database",
			engine: "postgres",
			version: "16-alpine",
			env: {
				POSTGRES_USER: "${{ inputs.dbUser }}",
				POSTGRES_PASSWORD: "${{ inputs.dbPassword }}",
			},
			volumes: [{ name: "data", target: "/var/lib/postgresql/data" }],
		},
	],
});

const values = {
	appDomain: "notes.example.com",
	dbUser: "notes",
	dbPassword: "pw-24",
	tz: "UTC",
};

describe("planTemplate", () => {
	const plan = planTemplate(template, values);
	const [db, app] = plan;

	test("dependencies first", () => {
		expect(plan.map((p) => p.name)).toEqual(["db", "app"]);
	});

	test("expressions expand; values from secret inputs are secret env vars", () => {
		expect(app?.env).toEqual([
			{
				key: "DATABASE_URL",
				value: "postgres://notes:pw-24@db:5432/notes",
				isSecret: true,
			},
			{
				key: "PUBLIC_URL",
				value: "https://notes.example.com",
				isSecret: false,
			},
			{ key: "TZ", value: "UTC", isSecret: false },
		]);
		expect(app?.spec).toMatchObject({
			kind: "application",
			command: ["serve", "--url", "https://notes.example.com"],
		});
	});

	test("public service gets its domain, files become configs, volumes stay volumes", () => {
		expect(app?.domain).toEqual({ hostname: "notes.example.com", port: 3000 });
		expect(app?.mounts).toEqual([
			{
				kind: "volume",
				target: "/app/uploads",
				volumeName: "uploads",
				readOnly: false,
			},
			{
				kind: "config",
				target: "/etc/notes.yml",
				content: "host: notes.example.com\n",
				readOnly: true,
			},
		]);
	});

	test("a database keeps its engine volume only once", () => {
		expect(db?.spec).toEqual({
			kind: "database",
			engine: "postgres",
			version: "16-alpine",
			credentialsRef: "env",
			resources: {},
		});
		expect(db?.mounts).toEqual([]);
	});

	test("on Postgres 18 the engine volume is the parent of PGDATA", () => {
		const [db18] = planTemplate(
			{
				...template,
				services: template.services.map((s) =>
					s.kind === "database"
						? {
								...s,
								version: "18-alpine",
								volumes: [{ name: "data", target: "/var/lib/postgresql" }],
							}
						: s,
				),
			},
			values,
		);
		expect(db18?.mounts).toEqual([]);
	});

	test("missing inputs are an error", () => {
		expect(() =>
			planTemplate(template, { ...values, dbPassword: undefined } as never),
		).toThrow("missing inputs: dbPassword");
	});

	test("siblings reach each other by template name on the environment network", () => {
		const compiled = plan.map((p, i) =>
			compileService({
				service: {
					id: `svc_${p.name.padEnd(24, "0")}`,
					organizationId: "org_acme",
					environmentId: "env_tpl000000000000000000000",
					slug: p.name,
					desiredState: "running",
					spec: p.spec,
				},
				deploymentId: `dep_${i}`.padEnd(28, "0"),
				context: { project: "p", environment: "e", service: "s", domains: [] },
				...(p.spec.kind === "application" &&
					p.spec.source.type === "image" && { image: p.spec.source.image }),
				env: Object.fromEntries(p.env.map((e) => [e.key, e.value])),
				mounts: [],
				domains: p.domain ? [{ port: p.domain.port }] : [],
				networks: { environment: "net-env", ingress: "net-ingress" },
				pinNodeId: "node-1",
				fileIds: {},
			}),
		);
		expect(
			compiled.map((s) => ({
				name: s.Name,
				networks: s.TaskTemplate.Networks,
				env: s.TaskTemplate.ContainerSpec.Env,
			})),
		).toMatchSnapshot();
	});
});

describe("generateInput", () => {
	test("each generator has the shape it promises", () => {
		const of = (i: Template["inputs"][number]) => generateInput(i) ?? "";
		expect(of({ key: "a", label: "a", type: "password", length: 40 })).toMatch(
			/^[A-Za-z0-9]{40}$/,
		);
		expect(
			of({ key: "a", label: "a", type: "secret", length: 64, charset: "hex" }),
		).toMatch(/^[0-9a-f]{64}$/);
		expect(of({ key: "a", label: "a", type: "username" })).toMatch(
			/^[a-z]{12}$/,
		);
		expect(
			atob(of({ key: "a", label: "a", type: "base64", bytes: 48 })).length,
		).toBe(48);
		expect(of({ key: "a", label: "a", type: "uuid" })).toMatch(
			/^[0-9a-f-]{36}$/,
		);
		expect(
			generateInput({ key: "a", label: "a", type: "domain", role: "primary" }),
		).toBeUndefined();
	});

	test("two calls never collide", () => {
		const p = { key: "a", label: "a", type: "password", length: 32 } as const;
		expect(generateInput(p)).not.toBe(generateInput(p));
	});
});

describe("schema", () => {
	const base = JSON.parse(JSON.stringify(template));
	const fails = (mut: (t: typeof base) => void, message: string) => {
		const t = structuredClone(base);
		mut(t);
		const r = Template.safeParse(t);
		expect(r.success).toBe(false);
		expect(r.error?.issues.map((i) => i.message).join("\n")).toContain(message);
	};

	test("floating images are refused", () => {
		fails(
			(t) => (t.services[0].image = "ghcr.io/example/notes:latest"),
			"pinned",
		);
		fails((t) => (t.services[0].image = "ghcr.io/example/notes"), "pinned");
	});

	test("references must exist", () => {
		fails(
			(t) => (t.services[0].env.X = "${{ inputs.nope }}"),
			"unknown input nope",
		);
		fails(
			(t) => (t.services[0].env.X = "${{ services.nope.host }}"),
			"unknown service nope",
		);
		fails((t) => (t.services[0].dependsOn = ["nope"]), "unknown service nope");
	});

	test("a secret never reaches the command line", () => {
		fails(
			(t) => (t.services[0].command = ["--pw", "${{ inputs.dbPassword }}"]),
			"on the command line",
		);
	});

	test("dependency cycles are refused", () => {
		fails((t) => (t.services[1].dependsOn = ["app"]), "dependency cycle");
	});

	test("every domain input routes exactly one public service", () => {
		fails(
			(t) => delete t.services[0].public,
			"must route exactly one public service",
		);
	});
});

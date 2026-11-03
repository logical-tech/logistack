import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	auditLog,
	deployment,
	domain,
	envVar,
	folder,
	organization,
	project,
	service,
} from "@logistack/db";
import { eq } from "drizzle-orm";
import { type ImportOptions, runImport } from "../scripts/import-dokploy.ts";
import { dokployComposes, fakeSecrets } from "./fixtures/dokploy.ts";
import { type Harness, hasDocker, setupBody, startHarness } from "./harness.ts";

describe.skipIf(!hasDocker)("Dokploy importer against Postgres", () => {
	let h: Harness;
	let source: string;
	let opts: ImportOptions;

	const run = async (overrides: Partial<ImportOptions> = {}) => {
		const lines: string[] = [];
		const summary = await runImport(h.deps, { ...opts, ...overrides }, (l) =>
			lines.push(l),
		);
		return { summary, output: lines.join("\n") };
	};

	beforeAll(async () => {
		h = await startHarness({ area: "import", label: "import" });
		const orgId = (await h.call("POST", "/api/setup", { body: setupBody })).json
			.organizationId;
		const [org] = await h.deps.db
			.select({ slug: organization.slug })
			.from(organization)
			.where(eq(organization.id, orgId));
		source = mkdtempSync(join(tmpdir(), "ls-test-import-"));
		for (const [appName, f] of Object.entries(dokployComposes)) {
			const code = join(source, appName, "code");
			mkdirSync(code, { recursive: true });
			writeFileSync(join(code, "docker-compose.yml"), f.compose);
			writeFileSync(join(code, ".env"), f.env);
		}
		mkdirSync(join(source, "builder-z9y8x7", "code"), { recursive: true });
		writeFileSync(
			join(source, "builder-z9y8x7", "code", "docker-compose.yml"),
			"services:\n  app:\n    build: .\n",
		);
		opts = {
			source,
			org: org?.slug as string,
			folder: "Imported from Dokploy",
			dryRun: false,
			deploy: true,
			stopped: ["minecraft-p2m7rt"],
			allowSensitive: true,
		};
	}, 60_000);
	afterAll(async () => {
		await h?.close();
		if (source) rmSync(source, { recursive: true, force: true });
	});

	test("dry run prints the plan with env keys, never values, and writes nothing", async () => {
		const { summary, output } = await run({ dryRun: true });
		expect(summary).toEqual({ created: 0, skipped: 0, refused: 1, failed: 0 });
		expect(output).toContain(
			"plan    factorio-server (dokploy factorio-server-o8zeig)",
		);
		expect(output).toContain("34197:34197/udp host");
		expect(output).toContain("PANEL_PASSWORD (secret)");
		expect(output).toContain("RCON_PASSWORD (secret)");
		expect(output).toContain("panel.example.com -> 80 (https auto)");
		expect(output).toContain(
			"refuse  builder (dokploy builder-z9y8x7): unsupported services.app.build",
		);
		for (const secret of fakeSecrets) expect(output).not.toContain(secret);
		expect(await h.deps.db.$count(service)).toBe(0);
		expect(await h.deps.db.$count(folder)).toBe(0);
	});

	test("the plan pins an image to the one Dokploy's container runs", async () => {
		const { output } = await run({
			dryRun: true,
			images: {
				running: async (appName) =>
					appName === "factorio-server-o8zeig"
						? { repoDigests: [], env: ["VERSION=2.0.77"], labels: {} }
						: undefined,
				tagExists: async (ref) => ref === "factoriotools/factorio:2.0.77",
			},
		});
		expect(output).toContain(
			"  pinned   factoriotools/factorio:stable -> factoriotools/factorio:2.0.77 (VERSION env of the running image)",
		);
		expect(output).toContain("image ghcr.io/example/panel:1.4.2");
	});

	test("creates one project per compose in the folder, through the audited routes", async () => {
		const { summary, output } = await run();
		expect(output).not.toContain("failed ");
		expect(summary).toEqual({ created: 3, skipped: 0, refused: 1, failed: 0 });
		for (const secret of fakeSecrets) expect(output).not.toContain(secret);

		const [dir] = await h.deps.db.select().from(folder);
		expect(dir?.name).toBe("Imported from Dokploy");
		const projects = await h.deps.db.select().from(project);
		expect(projects.map((p) => p.name).sort()).toEqual([
			"factorio-server",
			"minecraft",
			"panel",
		]);
		expect(projects.every((p) => p.folderId === dir?.id)).toBe(true);

		const services = await h.deps.db.select().from(service);
		const by = (marker: string) => {
			const s = services.find((x) => x.importedFrom === marker);
			if (!s) throw new Error(`${marker} not imported`);
			return s;
		};
		const factorio = by("dokploy:factorio-server-o8zeig/factorio");
		const panel = by("dokploy:panel-k3x9qa/panel");
		const minecraft = by("dokploy:minecraft-p2m7rt/minecraft");
		expect(factorio.spec.kind === "application" && factorio.spec.ports).toEqual(
			[{ target: 34197, published: 34197, protocol: "udp", mode: "host" }],
		);
		expect(minecraft.desiredState).toBe("stopped");
		expect(factorio.desiredState).toBe("running");

		const vars = await h.deps.db
			.select()
			.from(envVar)
			.where(eq(envVar.scopeId, panel.id));
		expect(vars.map((v) => [v.scope, v.key, v.isSecret]).sort()).toEqual([
			["service", "PANEL_PASSWORD", true],
			["service", "PANEL_THEME", false],
			["service", "PANEL_URL", true],
		]);
		expect(vars.some((v) => v.valueEncrypted.includes("fake-panel"))).toBe(
			false,
		);

		const domains = await h.deps.db.select().from(domain);
		expect(
			domains.map((d) => [d.serviceId, d.hostname, d.port, d.https, d.cert]),
		).toEqual([[panel.id, "panel.example.com", 80, true, "auto"]]);

		const deployments = await h.deps.db.select().from(deployment);
		expect(deployments.map((d) => d.serviceId).sort()).toEqual(
			[factorio.id, panel.id].sort(),
		);

		const audit = await h.deps.db
			.select()
			.from(auditLog)
			.where(eq(auditLog.actorId, "import-dokploy"));
		expect(new Set(audit.map((a) => a.actorKind))).toEqual(new Set(["system"]));
		expect(audit.filter((a) => a.action === "service.create")).toHaveLength(3);
		expect(audit.every((a) => a.outcome === "success")).toBe(true);
	});

	test("a re-run skips every imported service and changes nothing", async () => {
		const counts = async () =>
			Promise.all(
				[project, service, envVar, domain, deployment, folder].map((t) =>
					h.deps.db.$count(t),
				),
			);
		const before = await counts();
		const { summary, output } = await run();
		expect(summary).toEqual({ created: 0, skipped: 3, refused: 1, failed: 0 });
		expect(output).toContain(
			"skip    panel (dokploy panel-k3x9qa): already imported",
		);
		expect(await counts()).toEqual(before);
	});
});

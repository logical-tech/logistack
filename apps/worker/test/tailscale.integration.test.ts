import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { encrypt, importMasterKey } from "@logistack/core";
import {
	createDb,
	environment,
	organization,
	project,
	service,
	tailscaleNetwork,
	tailscalePublication,
} from "@logistack/db";
import { createDockerClient } from "@logistack/docker";
import { eq } from "drizzle-orm";
import type { Ctx } from "../src/ctx.ts";
import { envNetworkName } from "../src/load.ts";
import { syncTailscale, TAILSCALE_LABEL } from "../src/tailscale.ts";
import { cleanup, hasDocker, startInfra, workerConfig } from "./harness.ts";

// A fake auth key: tailscaled never joins, so this checks what LogiStack creates and removes.
// Joining a real tailnet and the test step's `tailscale ping` need a real key (docs-site page).
const AREA = "tailscale";
const LABEL = { "logistack.test": AREA };

describe.skipIf(!hasDocker)("tailscale sync on the local swarm", () => {
	let ctx: Ctx;
	let orgId: string;
	let pubId: string;
	const docker = createDockerClient();
	const ours = async () => {
		const label = [`${TAILSCALE_LABEL}=true`, "logistack.test=tailscale"];
		return {
			services: (await docker.services.list({ label })).map((s) => s.Spec),
			configs: (await docker.configs.list({ label })).map((c) => c.Spec.Name),
		};
	};

	beforeAll(async () => {
		await cleanup(AREA);
		const infra = await startInfra(AREA);
		const cfg = await workerConfig(infra, AREA);
		ctx = {
			cfg,
			db: createDb(cfg.DATABASE_URL, { onnotice: () => {} }),
			docker,
			masterKey: await importMasterKey(cfg.LOGISTACK_MASTER_KEY),
		} as Ctx;
		orgId = `org-${crypto.randomUUID()}`;
		await ctx.db
			.insert(organization)
			.values({ id: orgId, name: "T", slug: orgId, createdAt: new Date() });
		const [p] = await ctx.db
			.insert(project)
			.values({ organizationId: orgId, name: "P", slug: "p" })
			.returning();
		const [e] = await ctx.db
			.insert(environment)
			.values({
				projectId: p?.id as string,
				name: "Prod",
				slug: "prod",
				kind: "production",
				isDefault: true,
			})
			.returning();
		const [s] = await ctx.db
			.insert(service)
			.values({
				environmentId: e?.id as string,
				name: "web",
				slug: "web",
				kind: "application",
				desiredState: "running",
				spec: {
					kind: "application",
					source: { type: "image", image: "busybox:1.37" },
					build: { type: "image" },
					ports: [],
					replicas: 1,
					resources: {},
					placement: [],
				},
			})
			.returning();
		await docker.networks.create({
			Name: envNetworkName(ctx, e?.id as string),
			Driver: "overlay",
			Attachable: true,
			Labels: LABEL,
		});
		await ctx.db.insert(tailscaleNetwork).values({
			organizationId: orgId,
			authKeyEncrypted: await encrypt(ctx.masterKey, "tskey-auth-fake"),
		});
		const [pub] = await ctx.db
			.insert(tailscalePublication)
			.values({
				organizationId: orgId,
				serviceId: s?.id as string,
				hostname: "web",
				port: 8080,
			})
			.returning();
		pubId = pub?.id as string;
	}, 180_000);

	afterAll(() => cleanup(AREA), 120_000);

	test("creates labelled tailscaled and publisher, idempotently, and removes them on disable", async () => {
		await syncTailscale(ctx);
		const first = await ours();
		expect(
			first.services.map((s) => Object.keys(s.Mode ?? {})[0]).sort(),
		).toEqual(["Global", "Replicated"]);
		expect(first.configs).toHaveLength(1);
		for (const s of first.services)
			expect(s.Labels?.["logistack.managed"]).toBe("true");
		const [net] = await ctx.db.select().from(tailscaleNetwork);
		expect(net?.nodeServiceId).toBeTruthy();
		expect(net?.statusMessage).toBeNull();
		const [pub] = await ctx.db.select().from(tailscalePublication);
		expect(pub?.statusMessage).toBeNull();

		// No change, no update: the spec hash is unchanged.
		const before = await docker.services.list({
			label: [`${TAILSCALE_LABEL}=true`, "logistack.test=tailscale"],
		});
		await syncTailscale(ctx);
		const after = await docker.services.list({
			label: [`${TAILSCALE_LABEL}=true`, "logistack.test=tailscale"],
		});
		expect(after.map((s) => s.Version.Index).sort()).toEqual(
			before.map((s) => s.Version.Index).sort(),
		);

		// A port change rolls the publisher onto a new config and drops the old one.
		await ctx.db
			.update(tailscalePublication)
			.set({ port: 9090 })
			.where(eq(tailscalePublication.id, pubId));
		await syncTailscale(ctx);
		for (let i = 0; i < 40 && (await ours()).configs.length > 1; i++) {
			await Bun.sleep(500);
			await syncTailscale(ctx);
		}
		const rolled = await ours();
		expect(rolled.configs).toHaveLength(1);
		expect(rolled.configs[0]).not.toBe(first.configs[0]);

		// Turning it off: rows gone, every labelled service and config gone.
		await ctx.db
			.delete(tailscaleNetwork)
			.where(eq(tailscaleNetwork.organizationId, orgId));
		await ctx.db
			.delete(tailscalePublication)
			.where(eq(tailscalePublication.organizationId, orgId));
		await syncTailscale(ctx);
		for (let i = 0; i < 40 && (await ours()).configs.length; i++) {
			await Bun.sleep(500);
			await syncTailscale(ctx);
		}
		expect(await ours()).toEqual({ services: [], configs: [] });
	}, 120_000);
});

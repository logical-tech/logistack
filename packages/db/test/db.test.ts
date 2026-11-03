// Runs only with TEST_DATABASE_URL pointing at a disposable Postgres (17+).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ServiceSpec } from "@logistack/contracts";
import { newId } from "@logistack/core";
import { eq } from "drizzle-orm";
import {
	auditLog,
	createDb,
	type Db,
	environment,
	folder,
	organization,
	project,
	runMigrations,
	service,
} from "../src/index.ts";

const url = process.env.TEST_DATABASE_URL;

/** Postgres error message, unwrapped from drizzle's query error. */
async function pgError(p: PromiseLike<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		const err = e as { cause?: { message?: string }; message: string };
		return err.cause?.message ?? err.message;
	}
	throw new Error("expected the statement to fail");
}

const spec: ServiceSpec = {
	kind: "application",
	source: { type: "image", image: "nginx:1.27" },
	build: { type: "image" },
	ports: [{ target: 80, protocol: "tcp" }],
	replicas: 1,
	resources: {},
	placement: [],
};

describe.skipIf(!url)("db against real Postgres", () => {
	let db: Db;
	const orgId = newId("evt").replace("evt_", "org_");

	beforeAll(async () => {
		await runMigrations(url as string);
		await runMigrations(url as string);
		db = createDb(url as string, { onnotice: () => {} });
		await db
			.insert(organization)
			.values({ id: orgId, name: "Acme", slug: orgId, createdAt: new Date() });
	});

	afterAll(async () => {
		await db?.$client.end();
	});

	test("org > folder > subfolder > project > environment > service", async () => {
		const [top] = await db
			.insert(folder)
			.values({ organizationId: orgId, name: "Clients", slug: "clients" })
			.returning();
		const [sub] = await db
			.insert(folder)
			.values({
				organizationId: orgId,
				parentId: top?.id,
				name: "Acme",
				slug: "acme",
			})
			.returning();
		const [prj] = await db
			.insert(project)
			.values({
				organizationId: orgId,
				folderId: sub?.id,
				name: "Web",
				slug: "web",
			})
			.returning();
		const [env] = await db
			.insert(environment)
			.values({
				projectId: prj?.id as string,
				name: "Production",
				slug: "production",
				kind: "production",
				isDefault: true,
			})
			.returning();
		const [svc] = await db
			.insert(service)
			.values({
				environmentId: env?.id as string,
				name: "nginx",
				slug: "nginx",
				kind: "application",
				spec,
			})
			.returning();

		expect(top?.id).toMatch(/^fld_/);
		expect(prj?.id).toMatch(/^prj_/);
		expect(svc?.id).toMatch(/^svc_/);
		const [row] = await db
			.select()
			.from(service)
			.where(eq(service.id, svc?.id as string));
		expect(row?.spec).toEqual(spec);
		expect(row?.desiredState).toBe("running");

		expect(
			await pgError(
				db.insert(folder).values({
					organizationId: orgId,
					parentId: sub?.id,
					name: "Too deep",
					slug: "deep",
				}),
			),
		).toContain("folder depth exceeds 2");

		const [otherTop] = await db
			.insert(folder)
			.values({ organizationId: orgId, name: "Other", slug: "other" })
			.returning();
		expect(
			await pgError(
				db
					.update(folder)
					.set({ parentId: otherTop?.id })
					.where(eq(folder.id, top?.id as string)),
			),
		).toContain("has subfolders");
	});

	test("service spec kind must match service kind", async () => {
		const [prj] = await db
			.insert(project)
			.values({ organizationId: orgId, name: "P", slug: newId("prj") })
			.returning();
		const [env] = await db
			.insert(environment)
			.values({
				projectId: prj?.id as string,
				name: "Staging",
				slug: "staging",
				kind: "staging",
			})
			.returning();
		expect(
			await pgError(
				db.insert(service).values({
					environmentId: env?.id as string,
					name: "db",
					slug: "db",
					kind: "database",
					spec,
				}),
			),
		).toContain("service_spec_kind_check");
	});

	test("audit_log rejects updates", async () => {
		const [entry] = await db
			.insert(auditLog)
			.values({
				organizationId: orgId,
				actorKind: "system",
				actorId: "reconciler",
				action: "service.create",
				resourceType: "service",
				outcome: "success",
			})
			.returning();
		expect(
			await pgError(
				db
					.update(auditLog)
					.set({ outcome: "error" })
					.where(eq(auditLog.id, entry?.id as string)),
			),
		).toContain("append-only");
	});
});

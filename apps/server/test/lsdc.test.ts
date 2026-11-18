import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decrypt } from "@logistack/core";
import { deployment, envVar, service } from "@logistack/db";
import { and, eq } from "drizzle-orm";
import { instanceSlug } from "../src/routes/lsdc.ts";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

test("instance slugs are DNS labels named after the customer", () => {
	expect(instanceSlug("Acme S.r.l.")).toBe("lsdc-acme-s-r-l");
	expect(instanceSlug("Caffè Nero")).toBe("lsdc-caffe-nero");
	expect(instanceSlug("!!!")).toBe("lsdc-instance");
	expect(instanceSlug("x".repeat(200)).length).toBeLessThanOrEqual(63);
});

describe.skipIf(!hasDocker)("LSDC API", () => {
	let h: Harness;
	let cookie: string;
	let envId: string;
	const as = () => ({ headers: { cookie } });
	const limits = { cpu: 0.5, ramMb: 512, storageMb: 2048 };

	beforeAll(async () => {
		h = await startHarness({ area: "lsdc", label: "lsdc" });
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		const project = await h.call("POST", "/api/projects", {
			...as(),
			body: { name: "Customers" },
		});
		envId = (
			await h.call("GET", `/api/projects/${project.json.id}/environments`, as())
		).json[0].id;
	}, 60_000);
	afterAll(() => h?.close());

	let id: string;
	let serviceId: string;

	test("provisioning deploys a managed instance with its limits and a key", async () => {
		const res = await h.call("POST", `/api/environments/${envId}/lsdc`, {
			...as(),
			body: {
				customer: "Acme S.r.l.",
				domain: "acme.invalid",
				adminEmail: "boss@acme.test",
				limits,
				priceCents: 2900,
			},
		});
		expect(res.status).toBe(201);
		expect(res.json.adminPassword).toHaveLength(24);
		expect(res.json.instance).toMatchObject({
			name: "lsdc-acme-s-r-l",
			hostname: "acme.invalid",
			customer: "Acme S.r.l.",
			priceCents: 2900,
			currency: "EUR",
			limits,
			managed: true,
		});
		id = res.json.instance.id;
		serviceId = res.json.instance.serviceId;

		const [svc] = await h.deps.db
			.select()
			.from(service)
			.where(eq(service.id, serviceId));
		expect(svc?.spec.kind === "application" && svc.spec.resources).toEqual({
			cpu: 0.5,
			memoryMb: 512,
		});
		const [key] = await h.deps.db
			.select()
			.from(envVar)
			.where(
				and(
					eq(envVar.scopeId, serviceId),
					eq(envVar.key, "LSDC_MANAGEMENT_KEY"),
				),
			);
		expect(key?.isSecret).toBe(true);
		expect(await decrypt(h.deps.masterKey, key?.valueEncrypted ?? "")).toMatch(
			/^[0-9a-f]{64}$/,
		);

		const again = await h.call("POST", `/api/environments/${envId}/lsdc`, {
			...as(),
			body: { customer: "acme s r l", limits },
		});
		expect(again.status).toBe(409);
	});

	test("the list shows it; an unreachable instance reports why", async () => {
		const list = await h.call("GET", "/api/lsdc/instances", as());
		expect(list.json.map((i: { id: string }) => i.id)).toEqual([id]);
		const usage = await h.call("GET", `/api/lsdc/instances/${id}/usage`, as());
		expect(usage.status).toBe(200);
		expect(usage.json.reachable).toBe(false);
		expect((await h.call("GET", "/api/lsdc/instances")).status).toBe(401);
	});

	test("new limits rewrite resources and env and redeploy; price alone does not", async () => {
		const before = (
			await h.deps.db
				.select()
				.from(deployment)
				.where(eq(deployment.serviceId, serviceId))
		).length;
		const priced = await h.call("PATCH", `/api/lsdc/instances/${id}`, {
			...as(),
			body: { priceCents: 3900, currency: "USD" },
		});
		expect(priced.json).toMatchObject({ priceCents: 3900, currency: "USD" });
		const bigger = { cpu: 1, ramMb: 1024, storageMb: 4096 };
		const res = await h.call("PATCH", `/api/lsdc/instances/${id}`, {
			...as(),
			body: { limits: bigger },
		});
		expect(res.status).toBe(200);
		expect(res.json.limits).toEqual(bigger);
		const after = await h.deps.db
			.select()
			.from(deployment)
			.where(eq(deployment.serviceId, serviceId));
		expect(after.length).toBe(before + 1);
	});
});

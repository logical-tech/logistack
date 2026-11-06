import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { seededResourceProfiles } from "@logistack/core";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const app = {
	kind: "application",
	source: { type: "image", image: "nginx:1.27" },
	build: { type: "image" },
	ports: [],
	replicas: 1,
	resources: {},
	placement: [],
};

const profiles = {
	profiles: [
		{ name: "Small", cpu: 0.5, memoryMb: 512 },
		{ name: "Big", cpu: 4, memoryMb: 8192 },
	],
	defaultProfile: "Small",
};

describe.skipIf(!hasDocker)("resource profiles", () => {
	let h: Harness;
	let envId: string;
	let cookie: string;
	let devKey: string;
	const asOwner = () => ({ headers: { cookie } });
	const asDev = () => ({ headers: { authorization: `Bearer ${devKey}` } });
	const create = (body: Record<string, unknown>) =>
		h.call("POST", `/api/environments/${envId}/services`, {
			...asOwner(),
			body,
		});

	beforeAll(async () => {
		h = await startHarness({ area: "rprof", label: "rprof" });
		const orgId = (await h.call("POST", "/api/setup", { body: setupBody })).json
			.organizationId;
		cookie = await h.signIn(owner.email, owner.password);
		const project = await h.call("POST", "/api/projects", {
			...asOwner(),
			body: { name: "Sized" },
		});
		envId = (
			await h.call(
				"GET",
				`/api/projects/${project.json.id}/environments`,
				asOwner(),
			)
		).json[0].id;
		devKey = (
			await h.call("POST", "/api/api-keys", {
				...asOwner(),
				body: {
					name: "dev",
					scopes: [
						{ role: "developer", scope: { kind: "organization", id: orgId } },
					],
				},
			})
		).json.key;
	}, 90_000);
	afterAll(() => h?.close());

	test("an organization starts with the seeded profiles and no default", async () => {
		const res = await h.call(
			"GET",
			"/api/organization/resource-profiles",
			asOwner(),
		);
		expect(res.status).toBe(200);
		expect(res.json).toEqual(seededResourceProfiles);
		expect(
			(await create({ name: "plain", spec: app })).json.spec.resources,
		).toEqual({});
	});

	test("only an admin replaces them, and a default outside the list is refused", async () => {
		const path = "/api/organization/resource-profiles";
		expect(
			(await h.call("PUT", path, { ...asDev(), body: profiles })).status,
		).toBe(403);
		expect(
			(
				await h.call("PUT", path, {
					...asOwner(),
					body: { ...profiles, defaultProfile: "Huge" },
				})
			).status,
		).toBe(400);
		const saved = await h.call("PUT", path, { ...asOwner(), body: profiles });
		expect(saved.status).toBe(200);
		expect((await h.call("GET", path, asDev())).json).toEqual(profiles);
	});

	test("a new service copies the default, a named profile, or opts out", async () => {
		const sized = async (body: Record<string, unknown>) =>
			(await create({ spec: app, ...body })).json.spec.resources;
		expect(await sized({ name: "default" })).toEqual({
			cpu: 0.5,
			memoryMb: 512,
		});
		expect(await sized({ name: "big", resourceProfile: "Big" })).toEqual({
			cpu: 4,
			memoryMb: 8192,
		});
		expect(await sized({ name: "unlimited", resourceProfile: null })).toEqual(
			{},
		);
		expect(
			await sized({
				name: "explicit",
				spec: { ...app, resources: { memoryMb: 128 } },
			}),
		).toEqual({ memoryMb: 128 });
		const unknown = await create({
			name: "unknown",
			spec: app,
			resourceProfile: "Huge",
		});
		expect(unknown.status).toBe(400);
	});

	test("editing a profile leaves services created from it unchanged", async () => {
		const svc = (
			await create({ name: "snapshot", spec: app, resourceProfile: "Small" })
		).json;
		await h.call("PUT", "/api/organization/resource-profiles", {
			...asOwner(),
			body: {
				profiles: [{ name: "Small", cpu: 1, memoryMb: 1024 }],
				defaultProfile: null,
			},
		});
		const after = await h.call("GET", `/api/services/${svc.id}`, asOwner());
		expect(after.json.spec.resources).toEqual({ cpu: 0.5, memoryMb: 512 });
	});
});

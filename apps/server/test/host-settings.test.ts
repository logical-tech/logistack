import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { node, service } from "@logistack/db";
import { eq } from "drizzle-orm";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const image = (extra: Record<string, unknown>) => ({
	kind: "application",
	source: { type: "image", image: "factoriotools/factorio:stable" },
	build: { type: "image" },
	ports: [],
	replicas: 1,
	resources: {},
	placement: [],
	...extra,
});
const factorio = image({
	ports: [{ target: 34197, published: 34197, protocol: "udp" }],
	mounts: [
		{ kind: "bind", hostPath: "/home/gaming/factorio", target: "/factorio" },
	],
	restart: "any",
});

describe.skipIf(!hasDocker)("host-level service settings", () => {
	let h: Harness;
	let envId: string;
	let managerId: string;
	let ownerCookie: string;
	let devKey: string;
	const asOwner = () => ({ headers: { cookie: ownerCookie } });
	const asDev = () => ({ headers: { authorization: `Bearer ${devKey}` } });
	const create = (
		name: string,
		spec: unknown,
		as: { headers: Record<string, string> } = asOwner(),
	) =>
		h.call("POST", `/api/environments/${envId}/services`, {
			...as,
			body: { name, spec },
		});

	beforeAll(async () => {
		h = await startHarness({ area: "hostset", label: "hostset" });
		const orgId = (await h.call("POST", "/api/setup", { body: setupBody })).json
			.organizationId;
		ownerCookie = await h.signIn(owner.email, owner.password);
		const project = await h.call("POST", "/api/projects", {
			...asOwner(),
			body: { name: "Gaming" },
		});
		envId = (
			await h.call(
				"GET",
				`/api/projects/${project.json.id}/environments`,
				asOwner(),
			)
		).json[0].id;
		const rows = await h.deps.db
			.insert(node)
			.values(
				(["worker", "manager"] as const).map((role) => ({
					organizationId: orgId,
					swarmNodeId: `swarm-${role}`,
					hostname: role,
					address: "10.0.0.1",
					role,
				})),
			)
			.returning();
		managerId = rows.find((r) => r.role === "manager")?.id as string;
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

	test("bind mounts pin to the only manager and need admin", async () => {
		expect((await create("Denied", factorio, asDev())).status).toBe(403);
		const res = await create("Factorio", factorio);
		expect(res.status).toBe(201);
		expect(res.json.nodeId).toBe(managerId);

		// A developer may still edit other fields of the service, not its bind mounts.
		const rename = await h.call("PATCH", `/api/services/${res.json.id}`, {
			...asDev(),
			body: { name: "Factorio 2", spec: factorio },
		});
		expect(rename.status).toBe(200);
		const moved = await h.call("PATCH", `/api/services/${res.json.id}`, {
			...asDev(),
			body: {
				spec: {
					...factorio,
					mounts: [{ kind: "bind", hostPath: "/srv", target: "/factorio" }],
				},
			},
		});
		expect(moved.status).toBe(403);
	});

	test("capabilities beyond Docker's defaults need admin", async () => {
		const caps = (capAdd: string[]) => image({ capAdd });
		expect(
			(await create("Bind80", caps(["NET_BIND_SERVICE"]), asDev())).status,
		).toBe(201);
		for (const cap of ["SYS_ADMIN", "ALL", "NET_ADMIN"])
			expect((await create(`Esc ${cap}`, caps([cap]), asDev())).status).toBe(
				403,
			);
		const plain = await create("Plain", image({}), asDev());
		const escalate = await h.call("PATCH", `/api/services/${plain.json.id}`, {
			...asDev(),
			body: { spec: caps(["SYS_PTRACE"]) },
		});
		expect(escalate.status).toBe(403);
		expect((await create("Admin caps", caps(["SYS_ADMIN"]))).status).toBe(201);
	});

	test("sensitive host paths are refused without the explicit confirmation", async () => {
		const sock = (extra = {}) =>
			image({
				mounts: [
					{
						kind: "bind",
						hostPath: "/var/run/docker.sock",
						target: "/var/run/docker.sock",
						...extra,
					},
				],
			});
		expect((await create("Sock", sock())).status).toBe(400);
		expect(
			(await create("Sock", sock({ allowSensitiveHostPath: true }))).status,
		).toBe(201);
	});

	test("a published port already held on the node is a conflict", async () => {
		const clash = await create("Factorio copy", factorio);
		expect(clash.status).toBe(409);
		expect(clash.json.error.message).toBe(
			"port 34197/udp is already published by another service",
		);
		const tcp = await create(
			"Factorio tcp",
			image({ ports: [{ target: 34197, published: 34197, protocol: "tcp" }] }),
		);
		expect(tcp.status).toBe(201);
		const caddy = await create(
			"Https",
			image({ ports: [{ target: 8443, published: 443, protocol: "tcp" }] }),
		);
		expect(caddy.status).toBe(409);
		const [stored] = await h.deps.db
			.select()
			.from(service)
			.where(eq(service.name, "Https"));
		expect(stored).toBeUndefined();
	});
});

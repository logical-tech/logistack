import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { auditLog, project as projectTable } from "@logistack/db";
import { and, eq } from "drizzle-orm";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const dev = {
	name: "Dana Dev",
	email: "dana@example.com",
	password: "dana password 12",
};

const imageSpec = {
	kind: "application",
	source: { type: "image", image: "nginx:1.27" },
	build: { type: "image" },
	ports: [{ target: 80, protocol: "tcp" }],
	replicas: 1,
	resources: {},
	placement: [],
};

describe.skipIf(!hasDocker)("access control", () => {
	let h: Harness;
	let orgId: string;
	let ownerCookie: string;
	let devCookie: string;
	let devUserId: string;
	let clientsFolder: string;
	/** Service in project Acme Site, under Clients/Acme. */
	let insideService: string;
	/** Service in project Internal, in no folder. */
	let outsideService: string;
	let insideProject: string;
	const asOwner = () => ({ headers: { cookie: ownerCookie } });
	const asDev = () => ({ headers: { cookie: devCookie } });
	const bearer = (key: string) => ({
		headers: { authorization: `Bearer ${key}` },
	});

	async function serviceIn(projectId: string) {
		const envs = await h.call(
			"GET",
			`/api/projects/${projectId}/environments`,
			asOwner(),
		);
		const svc = await h.call(
			"POST",
			`/api/environments/${envs.json[0].id}/services`,
			{ ...asOwner(), body: { name: "Web", spec: imageSpec } },
		);
		expect(svc.status).toBe(201);
		return svc.json.id as string;
	}

	beforeAll(async () => {
		h = await startHarness();
		orgId = (await h.call("POST", "/api/setup", { body: setupBody })).json
			.organizationId;
		ownerCookie = await h.signIn(owner.email, owner.password);

		const folder = (name: string, parentId?: string) =>
			h.call("POST", "/api/folders", {
				...asOwner(),
				body: { name, parentId },
			});
		clientsFolder = (await folder("Clients")).json.id;
		const acme = (await folder("Acme", clientsFolder)).json.id;
		const proj = (name: string, folderId?: string) =>
			h.call("POST", "/api/projects", {
				...asOwner(),
				body: { name, folderId },
			});
		insideProject = (await proj("Acme Site", acme)).json.id;
		const outsideProject = (await proj("Internal")).json.id;
		insideService = await serviceIn(insideProject);
		outsideService = await serviceIn(outsideProject);
	}, 90_000);
	afterAll(() => h?.close());

	test("an invited viewer accepts through better-auth", async () => {
		const invite = await h.call("POST", "/api/invitations", {
			...asOwner(),
			body: { email: dev.email, role: "viewer" },
		});
		expect(invite.status).toBe(201);
		expect(invite.json.url).toBe(
			`https://ls.example.com/accept-invitation/${invite.json.id}`,
		);
		const pending = await h.call("GET", "/api/invitations", asOwner());
		expect(pending.json.map((i: { id: string }) => i.id)).toEqual([
			invite.json.id,
		]);

		expect(
			(await h.call("POST", "/api/auth/sign-up/email", { body: dev })).status,
		).toBe(200);
		devCookie = await h.signIn(dev.email, dev.password);
		const accepted = await h.call(
			"POST",
			"/api/auth/organization/accept-invitation",
			{ ...asDev(), body: { invitationId: invite.json.id } },
		);
		expect(accepted.status).toBe(200);
		const me = await h.call("GET", "/api/me", asDev());
		expect(me.json).toMatchObject({ organizationId: orgId, roles: ["viewer"] });
		devUserId = me.json.userId;
		expect((await h.call("GET", "/api/invitations", asOwner())).json).toEqual(
			[],
		);
	});

	test("a developer grant on a folder reaches services in its subprojects, not elsewhere", async () => {
		const deploy = (serviceId: string) =>
			h.call("POST", `/api/services/${serviceId}/deploy`, asDev());
		expect((await deploy(insideService)).status).toBe(403);

		const grant = await h.call("POST", "/api/grants", {
			...asOwner(),
			body: {
				userId: devUserId,
				role: "developer",
				scope: { kind: "folder", id: clientsFolder },
			},
		});
		expect(grant.status).toBe(201);
		expect(grant.json.scopeLabel).toBe("Clients");

		expect((await deploy(insideService)).status).toBe(202);
		expect((await deploy(outsideService)).status).toBe(403);
		// Developer is not admin: it cannot hand out grants on the folder it holds.
		const regrant = await h.call("POST", "/api/grants", {
			...asDev(),
			body: {
				userId: devUserId,
				role: "admin",
				scope: { kind: "folder", id: clientsFolder },
			},
		});
		expect(regrant.status).toBe(403);
		const listed = await h.call(
			"GET",
			`/api/grants?userId=${devUserId}`,
			asOwner(),
		);
		expect(listed.json).toHaveLength(1);
	});

	test("custom roles: create, grant on a project, delete only when unused", async () => {
		const created = await h.call("POST", "/api/roles", {
			...asOwner(),
			body: { name: "deployer", actions: ["deploy", "read"] },
		});
		expect(created.status).toBe(201);
		expect(created.json.actions).toEqual(["read", "deploy"]);
		expect(
			(
				await h.call("POST", "/api/roles", {
					...asOwner(),
					body: { name: "viewer", actions: ["read"] },
				})
			).status,
		).toBe(400);
		const g = await h.call("POST", "/api/grants", {
			...asOwner(),
			body: {
				userId: devUserId,
				role: "deployer",
				scope: { kind: "project", id: insideProject },
			},
		});
		expect(g.status).toBe(201);
		expect(
			(await h.call("DELETE", "/api/roles/deployer", asOwner())).status,
		).toBe(409);
		expect(
			(await h.call("DELETE", `/api/grants/${g.json.id}`, asOwner())).status,
		).toBe(204);
		expect(
			(await h.call("DELETE", "/api/roles/deployer", asOwner())).status,
		).toBe(204);
	});

	test("a scoped key gets the intersection of its owner's grants and its scopes", async () => {
		const key = await h.call("POST", "/api/api-keys", {
			...asOwner(),
			body: {
				name: "clients-ci",
				scopes: [
					{ role: "developer", scope: { kind: "folder", id: clientsFolder } },
				],
			},
		});
		expect(key.status).toBe(201);
		const k = bearer(key.json.key);
		expect(
			(await h.call("POST", `/api/services/${insideService}/deploy`, k)).status,
		).toBe(202);
		// The owner may deploy anywhere; the key only under Clients.
		expect(
			(await h.call("POST", `/api/services/${outsideService}/deploy`, k))
				.status,
		).toBe(403);
		expect(
			(await h.call("POST", "/api/projects", { ...k, body: { name: "X" } }))
				.status,
		).toBe(403);
		const me = await h.call("GET", "/api/me", k);
		expect(me.json.keyScopes).toEqual([
			{ role: "developer", scope: { kind: "folder", id: clientsFolder } },
		]);

		// The developer cannot mint a key wider than their own grants.
		const wider = await h.call("POST", "/api/api-keys", {
			...asDev(),
			body: {
				name: "too-wide",
				scopes: [
					{ role: "developer", scope: { kind: "organization", id: orgId } },
				],
			},
		});
		expect(wider.status).toBe(403);
		expect(wider.json.error.details.missing).toEqual(["deploy", "write"]);
		// A key the developer owns stays within the developer's grants, scopes or not.
		const devKey = await h.call("POST", "/api/api-keys", {
			...asDev(),
			body: { name: "dev-all" },
		});
		expect(
			(
				await h.call(
					"POST",
					`/api/services/${outsideService}/deploy`,
					bearer(devKey.json.key),
				)
			).status,
		).toBe(403);
	});

	test("keys record last use and IP, rotate and revoke", async () => {
		const key = await h.call("POST", "/api/api-keys", {
			...asOwner(),
			body: { name: "rotating", expiresInDays: 30 },
		});
		await h.call("GET", "/api/me", {
			headers: {
				authorization: `Bearer ${key.json.key}`,
				"x-forwarded-for": "198.51.100.23",
			},
		});
		const listed = await h.call("GET", "/api/api-keys", asOwner());
		const row = listed.json.find((r: { id: string }) => r.id === key.json.id);
		expect(row).toMatchObject({ lastIp: "198.51.100.23", enabled: true });
		expect(row.lastUsedAt).toBeTruthy();
		expect(JSON.stringify(listed.json)).not.toContain(key.json.key);

		const rotated = await h.call(
			"POST",
			`/api/api-keys/${key.json.id}/rotate`,
			asOwner(),
		);
		expect(rotated.status).toBe(201);
		expect(rotated.json.key).not.toBe(key.json.key);
		const days = (Date.parse(rotated.json.expiresAt) - Date.now()) / 86_400_000;
		expect(Math.round(days)).toBe(30);
		expect((await h.call("GET", "/api/me", bearer(key.json.key))).status).toBe(
			401,
		);
		expect(
			(await h.call("GET", "/api/me", bearer(rotated.json.key))).status,
		).toBe(200);
		expect(
			(await h.call("DELETE", `/api/api-keys/${rotated.json.id}`, asOwner()))
				.status,
		).toBe(204);
		expect(
			(await h.call("GET", "/api/me", bearer(rotated.json.key))).status,
		).toBe(401);
	});

	test("service accounts own keys and act as machines", async () => {
		const sa = await h.call("POST", "/api/service-accounts", {
			...asOwner(),
			body: { name: "GitHub Actions", role: "viewer" },
		});
		expect(sa.status).toBe(201);
		// Only admins create keys for a service account.
		expect(
			(
				await h.call("POST", "/api/api-keys", {
					...asDev(),
					body: { name: "steal", ownerId: sa.json.id },
				})
			).status,
		).toBe(403);
		const key = await h.call("POST", "/api/api-keys", {
			...asOwner(),
			body: { name: "deploy", ownerId: sa.json.id },
		});
		expect(key.json.owner).toMatchObject({ id: sa.json.id, kind: "machine" });
		const me = await h.call("GET", "/api/me", bearer(key.json.key));
		expect(me.json).toMatchObject({
			kind: "machine",
			id: sa.json.id,
			roles: ["viewer"],
		});
		const list = await h.call("GET", "/api/service-accounts", asOwner());
		expect(list.json).toMatchObject([{ name: "GitHub Actions", keyCount: 1 }]);
		// Service accounts are not people: the Members list leaves them out.
		const people = await h.call("GET", "/api/members", asOwner());
		expect(people.json.map((m: { name: string }) => m.name)).not.toContain(
			"GitHub Actions",
		);
		expect(
			(await h.call("DELETE", `/api/service-accounts/${sa.json.id}`, asOwner()))
				.status,
		).toBe(204);
		expect((await h.call("GET", "/api/me", bearer(key.json.key))).status).toBe(
			401,
		);
	});

	test("SSH keys: generated on the server, private half never returned", async () => {
		const gen = await h.call("POST", "/api/ssh-keys", {
			...asOwner(),
			body: { name: "deploy key" },
		});
		expect(gen.status).toBe(201);
		expect(gen.json.publicKey).toMatch(
			/^ssh-ed25519 \S+ deploy-key@logistack$/,
		);
		expect(gen.json.fingerprint).toMatch(/^SHA256:/);
		const list = await h.call("GET", "/api/ssh-keys", asDev());
		expect(JSON.stringify(list.json)).not.toContain("PRIVATE");
		expect(
			(
				await h.call("POST", "/api/ssh-keys", {
					...asOwner(),
					body: { name: "bad", privateKey: "nope" },
				})
			).status,
		).toBe(400);
		expect(
			(
				await h.call("POST", "/api/ssh-keys", {
					...asDev(),
					body: { name: "x" },
				})
			).status,
		).toBe(403);
	});

	describe("MCP", () => {
		let key: string;
		let keyId: string;
		const rpc = async (method: string, params: unknown, auth = key) => {
			const res = await h.app.request("/mcp", {
				method: "POST",
				headers: {
					authorization: `Bearer ${auth}`,
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
			});
			// biome-ignore lint/suspicious/noExplicitAny: JSON-RPC payloads are poked at freely.
			const body: any = await res.json();
			return { status: res.status, body };
		};
		const callTool = async (name: string, args: unknown) =>
			(await rpc("tools/call", { name, arguments: args })).body.result;

		beforeAll(async () => {
			const created = await h.call("POST", "/api/api-keys", {
				...asOwner(),
				body: { name: "claude" },
			});
			key = created.json.key;
			keyId = created.json.id;
		});

		test("refuses requests without an API key", async () => {
			const res = await h.app.request("/mcp", {
				method: "POST",
				headers: { cookie: ownerCookie, "content-type": "application/json" },
				body: "{}",
			});
			expect(res.status).toBe(401);
			expect((await rpc("tools/list", {}, "lsk_nope")).status).toBe(401);
		});

		test("initializes and lists one tool per OpenAPI operation", async () => {
			const init = await rpc("initialize", {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "test", version: "1" },
			});
			expect(init.body.result.serverInfo.name).toBe("logistack");
			const { tools } = (await rpc("tools/list", {})).body.result;
			const doc = (await h.call("GET", "/api/openapi.json")).json;
			const operations = Object.entries(doc.paths).flatMap(([, item]) =>
				Object.values(item as Record<string, { tags?: string[] }>).filter(
					(op) => !op.tags?.includes("setup"),
				),
			);
			expect(tools.length).toBe(operations.length);
			const byName = Object.fromEntries(
				tools.map((t: { name: string }) => [t.name, t]),
			);
			expect(byName.project_create.inputSchema.required).toContain("body");
			for (const t of ["create", "test", "delete"])
				expect(byName[`backup_destination_${t}`]).toBeDefined();
			expect(byName.backup_destination_delete.annotations).toMatchObject({
				destructiveHint: true,
			});
			expect(byName.project_delete.annotations).toMatchObject({
				destructiveHint: true,
			});
			expect(byName.project_delete.inputSchema.required).toContain("confirm");
			expect(byName.database_restore.inputSchema.required).toContain("confirm");
			expect(byName.get_projects.annotations.readOnlyHint).toBe(true);
			// Schemas are self-contained for clients that do not resolve $ref.
			expect(JSON.stringify(tools)).not.toContain("#/components");
		});

		test("a call runs through the API and is audited with the key as actor", async () => {
			const result = await callTool("project_create", {
				body: { name: "From Claude" },
			});
			expect(result.isError).toBe(false);
			const created = JSON.parse(result.content[0].text);
			const rows = await h.deps.db
				.select()
				.from(auditLog)
				.where(
					and(
						eq(auditLog.action, "project.create"),
						eq(auditLog.resourceId, created.id),
					),
				);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				actorKind: "apikey",
				actorId: keyId,
				outcome: "success",
			});
			expect(rows[0]?.userAgent).toStartWith("logistack-mcp");

			const refused = await callTool("project_delete", { id: created.id });
			expect(refused.isError).toBe(true);
			expect(refused.content[0].text).toContain("confirm");
			const still = await h.deps.db
				.select()
				.from(projectTable)
				.where(eq(projectTable.id, created.id));
			expect(still).toHaveLength(1);

			const deleted = await callTool("project_delete", {
				id: created.id,
				confirm: true,
			});
			expect(deleted.isError).toBe(false);
			const gone = await h.deps.db
				.select()
				.from(projectTable)
				.where(eq(projectTable.id, created.id));
			expect(gone).toHaveLength(0);
		});

		test("a forbidden call comes back as a tool error", async () => {
			const scoped = await h.call("POST", "/api/api-keys", {
				...asOwner(),
				body: {
					name: "read-only",
					scopes: [
						{ role: "viewer", scope: { kind: "organization", id: orgId } },
					],
				},
			});
			const res = await rpc(
				"tools/call",
				{ name: "project_create", arguments: { body: { name: "Nope" } } },
				scoped.json.key,
			);
			expect(res.body.result.isError).toBe(true);
			expect(res.body.result.content[0].text).toContain("forbidden");
		});
	});

	test("audit log exports as CSV and JSON with the same filters", async () => {
		const csv = await h.app.request(
			"/api/audit-log/export?format=csv&action=grant.create",
			{ headers: { cookie: ownerCookie } },
		);
		expect(csv.status).toBe(200);
		expect(csv.headers.get("content-type")).toContain("text/csv");
		expect(csv.headers.get("content-disposition")).toContain("attachment");
		const lines = (await csv.text()).trim().split("\r\n");
		expect(lines[0]).toBe(
			"at,actorKind,actorId,actorName,action,resourceType,resourceId,outcome,ip,userAgent,requestId,diff",
		);
		// Two successful grants and the developer's denied attempt.
		expect(lines).toHaveLength(4);
		expect(lines.slice(1).every((l) => l.includes('"grant.create"'))).toBe(
			true,
		);
		const json = await h.call(
			"GET",
			"/api/audit-log/export?format=json&action=grant.create&outcome=denied",
			asOwner(),
		);
		expect(json.json).toHaveLength(1);
		expect(json.json[0]).toMatchObject({
			actorName: dev.name,
			outcome: "denied",
		});
		const page = await h.call("GET", "/api/audit-log?limit=2", asOwner());
		expect(page.json.items).toHaveLength(2);
		expect(page.json.nextCursor).toBeTruthy();
		const facets = await h.call("GET", "/api/audit-log/facets", asOwner());
		expect(facets.json.actions).toContain("grant.create");
		expect((await h.call("GET", "/api/audit-log/export", asDev())).status).toBe(
			403,
		);
	});
});

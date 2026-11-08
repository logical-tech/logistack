import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const ada = {
	name: "Ada Admin",
	email: "ada@example.com",
	password: "ada password 1234",
};

const node = "00000000-0000-0000-0000-000000000000";

/** Every instance-level route, with a body that passes validation. */
const instanceRoutes: [string, string, unknown?][] = [
	["POST", "/api/instance/update", {}],
	["PUT", "/api/instance/update/auto-check", { enabled: false }],
	["PUT", "/api/instance/update/beta", { enabled: false }],
	["PUT", "/api/instance/update/channel", { channel: "stable" }],
	["PATCH", "/api/instance/settings", { allowPrivateHosts: true }],
	["GET", "/api/instance/admins"],
	["POST", "/api/instance/admins", { email: "ada@example.com" }],
	["DELETE", `/api/instance/admins/${node}`],
	["PUT", "/api/instance/sponsor", { key: "x" }],
	["DELETE", "/api/instance/sponsor"],
	["PUT", "/api/plugins/policy", { policy: "any" }],
	[
		"POST",
		"/api/plugins/indexes",
		{
			url: "https://index.example.com",
			publicKeys: { k: Buffer.alloc(32).toString("base64") },
		},
	],
	["DELETE", `/api/plugins/indexes/${node}`],
	["PUT", "/api/certificates/issuer", { directory: "staging" }],
	["PUT", "/api/registries/local", { enabled: false }],
	["POST", "/api/build-platforms/check", {}],
	["POST", "/api/build-platforms/emulation", { enabled: true }],
	["GET", `/api/nodes/${node}/host-dirs`],
	["POST", `/api/nodes/${node}/disk/prune`, {}],
	["PATCH", `/api/nodes/${node}`, { labels: {} }],
	["DELETE", `/api/nodes/${node}`],
	["POST", "/api/nodes/joins", {}],
	["PUT", `/api/nodes/joins/${node}`, {}],
	["POST", `/api/nodes/joins/${node}/steps`, {}],
	["GET", "/api/migrations/source"],
	["POST", "/api/migrations", {}],
	["POST", `/api/nodes/${node}/patches/scan`, {}],
	["POST", "/api/patching/runs", {}],
	["POST", `/api/patching/runs/${node}/cancel`, {}],
	["PUT", "/api/patching/policy", {}],
	["GET", `/api/migrations/${node}`],
	["POST", `/api/migrations/${node}/import`, {}],
	["POST", `/api/migrations/${node}/proxy-switch`, {}],
	["POST", `/api/migrations/${node}/unfreeze`, {}],
	["POST", `/api/migrations/${node}/decommission`, {}],
];

describe.skipIf(!hasDocker)("instance admins", () => {
	let h: Harness;
	let ownerCookie: string;
	let adaCookie: string;
	let adaId: string;
	let ownerId: string;
	let adaKey: string;
	const asOwner = () => ({ headers: { cookie: ownerCookie } });
	const asAda = () => ({ headers: { cookie: adaCookie } });

	beforeAll(async () => {
		h = await startHarness({ area: "iadm", label: "iadm" });
		await h.call("POST", "/api/setup", { body: setupBody });
		ownerCookie = await h.signIn(owner.email, owner.password);
		const invite = await h.call("POST", "/api/invitations", {
			...asOwner(),
			body: { email: ada.email, role: "admin" },
		});
		expect(invite.status).toBe(201);
		await h.call("POST", "/api/auth/sign-up/email", { body: ada });
		adaCookie = await h.signIn(ada.email, ada.password);
		await h.call("POST", "/api/auth/organization/accept-invitation", {
			...asAda(),
			body: { invitationId: invite.json.id },
		});
		const me = await h.call("GET", "/api/me", asAda());
		expect(me.json.roles).toEqual(["admin"]);
		adaId = me.json.userId;
		ownerId = (await h.call("GET", "/api/me", asOwner())).json.userId;
		const key = await h.call("POST", "/api/api-keys", {
			...asAda(),
			body: { name: "ada" },
		});
		expect(key.status).toBe(201);
		adaKey = key.json.key;
	}, 90_000);
	afterAll(() => h?.close());

	test("setup made the owner the only instance admin", async () => {
		expect((await h.call("GET", "/api/me", asOwner())).json.instanceAdmin).toBe(
			true,
		);
		expect((await h.call("GET", "/api/me", asAda())).json.instanceAdmin).toBe(
			false,
		);
		const admins = await h.call("GET", "/api/instance/admins", asOwner());
		expect(admins.json.map((a: { id: string }) => a.id)).toEqual([ownerId]);
	});

	test("an organization admin without the flag gets 403 on every instance route", async () => {
		const failures: string[] = [];
		for (const [method, path, body] of instanceRoutes)
			for (const headers of [
				asAda().headers,
				{ authorization: `Bearer ${adaKey}` },
			]) {
				const res = await h.call(method, path, { body, headers });
				if (
					res.status !== 403 ||
					res.json.error?.message !== "only an instance admin can do this"
				)
					failures.push(`${method} ${path}: ${res.status}`);
			}
		expect(failures).toEqual([]);
	});

	test("the same admin still manages the organization", async () => {
		expect((await h.call("GET", "/api/nodes", asAda())).status).toBe(200);
		expect(
			(await h.call("GET", "/api/instance/settings", asAda())).status,
		).toBe(200);
	});

	test("instance-wide retention needs the flag; the organization's thresholds do not", async () => {
		const current = (await h.call("GET", "/api/monitoring/settings", asAda()))
			.json;
		const body = { retention: current.retention, thresholds: [] };
		expect(
			(await h.call("PUT", "/api/monitoring/settings", { ...asAda(), body }))
				.status,
		).toBe(200);
		const longer = {
			...body,
			retention: { ...current.retention, hourDays: 400 },
		};
		expect(
			(
				await h.call("PUT", "/api/monitoring/settings", {
					...asAda(),
					body: longer,
				})
			).status,
		).toBe(403);
	});

	test("better-auth's role endpoints are closed; roles change through /api", async () => {
		const res = await h.call("POST", "/api/auth/admin/set-role", {
			...asOwner(),
			body: { userId: adaId, role: "admin" },
		});
		expect(res.status).toBe(404);
	});

	test("the last instance admin cannot be removed", async () => {
		const res = await h.call(
			"DELETE",
			`/api/instance/admins/${ownerId}`,
			asOwner(),
		);
		expect(res.status).toBe(409);
	});

	test("an admin adds another by email, who then passes the guard", async () => {
		const added = await h.call("POST", "/api/instance/admins", {
			...asOwner(),
			body: { email: "ADA@example.com" },
		});
		expect(added.status).toBe(200);
		expect(added.json.map((a: { id: string }) => a.id).sort()).toEqual(
			[adaId, ownerId].sort(),
		);
		const ok = await h.call("PUT", "/api/instance/update/auto-check", {
			...asAda(),
			body: { enabled: true },
		});
		expect(ok.status).toBe(200);
		const unknown = await h.call("POST", "/api/instance/admins", {
			...asOwner(),
			body: { email: "nobody@example.com" },
		});
		expect(unknown.status).toBe(404);
	});

	test("two admins removing each other at once leave one", async () => {
		const results = await Promise.all([
			h.call("DELETE", `/api/instance/admins/${adaId}`, asOwner()),
			h.call("DELETE", `/api/instance/admins/${ownerId}`, asAda()),
		]);
		const statuses = results.map((r) => r.status).sort();
		// The loser either finds itself already removed (403) or would empty the list (409).
		expect(statuses[0]).toBe(200);
		expect([403, 409]).toContain(statuses[1] as number);
		const left = await h.call(
			"GET",
			"/api/instance/admins",
			results[0]?.status === 200 ? asOwner() : asAda(),
		);
		expect(left.json).toHaveLength(1);
	});
});

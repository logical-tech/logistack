import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { auditLog } from "@logistack/db";
import { and, eq } from "drizzle-orm";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

// A 1×1 transparent PNG.
const PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

describe.skipIf(!hasDocker)("organization profile", () => {
	let h: Harness;
	let orgId: string;
	let cookie: string;
	let viewerCookie: string;
	const viewer = {
		name: "Viewer",
		email: "viewer@orgprof.example.com",
		password: "viewer-password-123",
	};
	const asOwner = () => ({ headers: { cookie } });

	beforeAll(async () => {
		h = await startHarness({ area: "orgprof", label: "orgprof" });
		orgId = (await h.call("POST", "/api/setup", { body: setupBody })).json
			.organizationId;
		cookie = await h.signIn(owner.email, owner.password);
		const invite = await h.call("POST", "/api/invitations", {
			...asOwner(),
			body: { email: viewer.email, role: "viewer" },
		});
		await h.call("POST", "/api/auth/sign-up/email", { body: viewer });
		viewerCookie = await h.signIn(viewer.email, viewer.password);
		await h.call("POST", "/api/auth/organization/accept-invitation", {
			headers: { cookie: viewerCookie },
			body: { invitationId: invite.json.id },
		});
	}, 90_000);
	afterAll(() => h?.close());

	test("reads the active organization", async () => {
		const res = await h.call("GET", "/api/organization", asOwner());
		expect(res.status).toBe(200);
		expect(res.json).toMatchObject({ id: orgId, logo: null });
	});

	test("an admin renames it and sets a logo, audited without the image", async () => {
		const res = await h.call("PATCH", "/api/organization", {
			...asOwner(),
			body: { name: "Acme Inc", logo: PNG },
		});
		expect(res.status).toBe(200);
		expect(res.json).toMatchObject({ name: "Acme Inc", logo: PNG });
		const [row] = await h.deps.db
			.select()
			.from(auditLog)
			.where(
				and(
					eq(auditLog.organizationId, orgId),
					eq(auditLog.action, "organization.update"),
				),
			);
		expect(row?.outcome).toBe("success");
		expect(JSON.stringify(row?.diff)).not.toContain("base64");
		expect(row?.diff).toMatchObject({ after: { name: "Acme Inc" } });
	});

	test("null removes the logo", async () => {
		const res = await h.call("PATCH", "/api/organization", {
			...asOwner(),
			body: { logo: null },
		});
		expect(res.json).toMatchObject({ name: "Acme Inc", logo: null });
	});

	test("refuses SVG and oversize images", async () => {
		const svg = await h.call("PATCH", "/api/organization", {
			...asOwner(),
			body: { logo: `data:image/svg+xml;base64,${btoa("<svg/>")}` },
		});
		expect(svg.status).toBe(400);
		const big = await h.call("PATCH", "/api/organization", {
			...asOwner(),
			body: { logo: `data:image/png;base64,${"A".repeat(200_000)}` },
		});
		expect(big.status).toBe(400);
	});

	test("a viewer reads it but cannot change it", async () => {
		const asViewer = { headers: { cookie: viewerCookie } };
		expect((await h.call("GET", "/api/organization", asViewer)).status).toBe(
			200,
		);
		const res = await h.call("PATCH", "/api/organization", {
			...asViewer,
			body: { name: "Mine now" },
		});
		expect(res.status).toBe(403);
	});

	test("better-auth's own update endpoint is closed", async () => {
		const res = await h.call("POST", "/api/auth/organization/update", {
			...asOwner(),
			body: { data: { logo: "https://tracker.example.com/pixel.png" } },
		});
		expect(res.status).toBe(404);
	});
});

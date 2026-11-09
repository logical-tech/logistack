import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { workField, workFieldValue, workProject } from "@logistack/db";
import { eq } from "drizzle-orm";
import { hasDocker } from "./harness.ts";
import {
	seedTask,
	type WorkHarness,
	workHarness,
} from "./work-extras-b-fixtures.ts";

describe.skipIf(!hasDocker)("work share links", () => {
	let w: WorkHarness;
	let p: { id: string; key: string; listId: string };
	let fieldId: string;

	const page = async (path: string, cookie?: string) => {
		const res = await w.h.app.request(path, {
			headers: cookie ? { cookie } : {},
		});
		return { status: res.status, text: await res.text(), headers: res.headers };
	};
	const tokenOf = (url: string) =>
		new URL(url).pathname.split("/")[2] as string;

	beforeAll(async () => {
		w = await workHarness("shares");
		p = await w.newProject("Client site");
		const [f] = await w.h.deps.db
			.insert(workField)
			.values({
				projectId: p.id,
				name: "Budget",
				kind: "text",
				config: { kind: "text" },
				position: "a0",
			})
			.returning();
		const [hidden] = await w.h.deps.db
			.insert(workField)
			.values({
				projectId: p.id,
				name: "Internal note",
				kind: "text",
				config: { kind: "text" },
				position: "a1",
			})
			.returning();
		fieldId = f?.id as string;
		const t = await seedTask(w.h.deps.db, p, "Homepage hero <script>");
		await w.h.deps.db.insert(workFieldValue).values([
			{ taskId: t.id, fieldId, value: "4k EUR" },
			{ taskId: t.id, fieldId: hidden?.id as string, value: "do not leak" },
		]);
	}, 90_000);
	afterAll(() => w?.h.close());

	test("creating a link needs allowShareLinks", async () => {
		const res = await w.h.call("POST", `/api/work/projects/${p.id}/shares`, {
			...w.as(),
			body: { name: "Client", listId: p.listId },
		});
		expect(res.status).toBe(409);
		await w.h.deps.db
			.update(workProject)
			.set({ allowShareLinks: true })
			.where(eq(workProject.projectId, p.id));
	});

	test("an open link renders the list with allowed fields only, noindex and no referrer", async () => {
		const res = await w.h.call("POST", `/api/work/projects/${p.id}/shares`, {
			...w.as(),
			body: { name: "Client", listId: p.listId, fieldIds: [fieldId] },
		});
		expect(res.status).toBe(201);
		expect(res.json.share).toMatchObject({
			hasPassword: false,
			viewCount: 0,
			fieldIds: [fieldId],
		});
		const token = tokenOf(res.json.url);
		const list = await page(`/share/${token}`);
		expect(list.status).toBe(200);
		expect(list.headers.get("x-robots-tag")).toBe("noindex, nofollow");
		expect(list.headers.get("referrer-policy")).toBe("no-referrer");
		expect(list.text).toContain(
			'<meta name="robots" content="noindex,nofollow">',
		);
		expect(list.text).toContain("Homepage hero &lt;script&gt;");
		expect(list.text).toContain("Budget: 4k EUR");
		expect(list.text).not.toContain("do not leak");
		const detail = await page(`/share/${token}/t/1`);
		expect(detail.status).toBe(200);
		expect(detail.text).toContain("4k EUR");
		expect((await page(`/share/${token}/t/99`)).status).toBe(404);

		const listed = await w.h.call(
			"GET",
			`/api/work/projects/${p.id}/shares`,
			w.as(),
		);
		expect(listed.json[0]).toMatchObject({ viewCount: 1 });
		expect(listed.json[0].lastViewedAt).not.toBeNull();

		expect(
			(
				await w.h.call(
					"DELETE",
					`/api/work/shares/${res.json.share.id}`,
					w.as(),
				)
			).status,
		).toBe(204);
		expect((await page(`/share/${token}`)).status).toBe(404);
	});

	test("a password link asks first, then sets a cookie scoped to the share", async () => {
		const res = await w.h.call("POST", `/api/work/projects/${p.id}/shares`, {
			...w.as(),
			body: { name: "Locked", listId: p.listId, password: "hunter22" },
		});
		const token = tokenOf(res.json.url);
		const gate = await page(`/share/${token}`);
		expect(gate.status).toBe(401);
		expect(gate.text).toContain('type="password"');
		expect(gate.text).not.toContain("Homepage");
		const post = (password: string) =>
			w.h.app.request(`/share/${token}`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ password }).toString(),
			});
		expect((await post("wrong")).status).toBe(401);
		const ok = await post("hunter22");
		expect(ok.status).toBe(303);
		const set = ok.headers.get("set-cookie") ?? "";
		expect(set).toContain(`Path=/share/${token}`);
		expect(set).toContain("HttpOnly");
		const cookie = set.split(";")[0] as string;
		expect((await page(`/share/${token}`, cookie)).status).toBe(200);
		// A forged cookie doesn't open it.
		expect(
			(
				await page(
					`/share/${token}`,
					`${cookie.split("=")[0]}=${Date.now() + 1e6}.00`,
				)
			).status,
		).toBe(401);
	});

	test("expired links and unknown tokens are gone; turning sharing off closes every link", async () => {
		const res = await w.h.call("POST", `/api/work/projects/${p.id}/shares`, {
			...w.as(),
			body: {
				name: "Old",
				listId: p.listId,
				expiresAt: new Date(Date.now() - 1000).toISOString(),
			},
		});
		expect((await page(`/share/${tokenOf(res.json.url)}`)).status).toBe(404);
		expect((await page(`/share/${"x".repeat(43)}`)).status).toBe(404);
		const open = await w.h.call("POST", `/api/work/projects/${p.id}/shares`, {
			...w.as(),
			body: { name: "Open", listId: p.listId },
		});
		await w.h.deps.db
			.update(workProject)
			.set({ allowShareLinks: false })
			.where(eq(workProject.projectId, p.id));
		expect((await page(`/share/${tokenOf(open.json.url)}`)).status).toBe(404);
		await w.h.deps.db
			.update(workProject)
			.set({ allowShareLinks: true })
			.where(eq(workProject.projectId, p.id));
	});

	test("creating and revoking are audited", async () => {
		const audit = await w.h.call("GET", "/api/audit-log?limit=100", w.as());
		const actions = (audit.json.items ?? audit.json).map(
			(r: { action: string }) => r.action,
		);
		expect(actions).toContain("work_share.create");
		expect(actions).toContain("work_share.revoke");
	});
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	invitationGrant,
	roleGrant,
	workList,
	workProject,
	workStatus,
	workTag,
} from "@logistack/db";
import { and, eq } from "drizzle-orm";
import { grantsFor } from "../src/actor.ts";
import { Failure } from "../src/errors.ts";
import { locate } from "../src/scope.ts";
import {
	guestCreateDefaults,
	guestProjectIds,
	visiblePeople,
} from "../src/work/guests.ts";
import { hasDocker } from "./harness.ts";
import {
	acceptAs,
	type WorkHarness,
	workHarness,
} from "./work-extras-b-fixtures.ts";

const guest = {
	name: "Cara Client",
	email: "cara@client.example",
	password: "cara password 12",
};
const dev = {
	name: "Dev Dan",
	email: "dan@example.com",
	password: "dan password 1234",
};

describe.skipIf(!hasDocker)("work guests", () => {
	let w: WorkHarness;
	let shop: { id: string; key: string; listId: string };
	let other: { id: string; key: string; listId: string };
	let guestCookie: string;
	let guestId: string;

	const actorOf = async (userId: string) => ({
		kind: "user" as const,
		id: userId,
		userId,
		organizationId: w.orgId,
		grants: (await grantsFor(w.h.deps.db, userId, userId, w.orgId)) ?? [],
	});

	beforeAll(async () => {
		w = await workHarness("guests");
		shop = await w.newProject("Shop");
		other = await w.newProject("Secret project");
	}, 90_000);
	afterAll(() => w?.h.close());

	test("invite guest → project-scoped grant on acceptance, nothing org-wide", async () => {
		const res = await w.h.call("POST", `/api/work/projects/${shop.id}/guests`, {
			...w.as(),
			body: { email: guest.email, canCreate: true },
		});
		expect(res.status).toBe(201);
		expect(res.json).toMatchObject({ emailed: false });
		expect(res.json.url).toBe(
			`https://ls.example.com/accept-invitation/${res.json.invitationId}`,
		);
		expect(
			await w.h.deps.db
				.select()
				.from(invitationGrant)
				.where(eq(invitationGrant.invitationId, res.json.invitationId)),
		).toMatchObject([
			{ role: "guest", scopeKind: "project", scopeId: shop.id },
		]);
		const [wp] = await w.h.deps.db
			.select()
			.from(workProject)
			.where(eq(workProject.projectId, shop.id));
		expect(wp?.guestsCanCreate).toBe(true);

		guestCookie = await acceptAs(w.h, guest, res.json.invitationId);
		const me = await w.h.call("GET", "/api/me", w.as(guestCookie));
		guestId = me.json.userId;
		expect(me.json.surfaces).toEqual(["work"]);
		expect(
			await w.h.deps.db
				.select()
				.from(roleGrant)
				.where(eq(roleGrant.userId, guestId)),
		).toMatchObject([
			{ role: "guest", scopeKind: "project", scopeId: shop.id },
		]);
	});

	test("a guest sees nothing ops and no other project", async () => {
		const actor = await actorOf(guestId);
		expect(guestProjectIds(actor)).toEqual([shop.id]);
		for (const path of [
			`/api/projects/${other.id}`,
			`/api/projects/${shop.id}`,
			"/api/members",
		])
			expect([403, 404]).toContain(
				(await w.h.call("GET", path, w.as(guestCookie))).status,
			);
		expect(
			(
				await w.h.call(
					"GET",
					`/api/work/projects/${other.id}/shares`,
					w.as(guestCookie),
				)
			).status,
		).toBe(403);
		// Guests don't hold `work`, so they can't manage share links even on their project.
		expect(
			(
				await w.h.call(
					"GET",
					`/api/work/projects/${shop.id}/shares`,
					w.as(guestCookie),
				)
			).status,
		).toBe(403);
	});

	test("people pickers: a guest sees only people on their projects", async () => {
		const inv = await w.h.call("POST", "/api/invitations", {
			...w.as(),
			body: {
				email: dev.email,
				role: "guest",
				grants: [
					{ role: "developer", scope: { kind: "project", id: other.id } },
				],
			},
		});
		expect(inv.status).toBe(201);
		const devCookie = await acceptAs(w.h, dev, inv.json.id);
		const devId = (await w.h.call("GET", "/api/me", w.as(devCookie))).json
			.userId;
		const ownerId = (await w.h.call("GET", "/api/me", w.as())).json.userId;
		const seen = await visiblePeople(w.h.deps.db, await actorOf(guestId));
		expect(seen?.has(guestId)).toBe(true);
		expect(seen?.has(ownerId)).toBe(true);
		expect(seen?.has(devId)).toBe(false);
		expect(await visiblePeople(w.h.deps.db, await actorOf(ownerId))).toBeNull();
	});

	test("GET /projects/:id/people: a guest gets only visible people", async () => {
		const ownerId = (await w.h.call("GET", "/api/me", w.as())).json.userId;
		const res = await w.h.call(
			"GET",
			`/api/work/projects/${shop.id}/people`,
			w.as(guestCookie),
		);
		expect(res.status).toBe(200);
		const ids = res.json.map((p: { userId: string }) => p.userId).sort();
		expect(ids).toEqual([guestId, ownerId].sort());
		const seen = await visiblePeople(w.h.deps.db, await actorOf(guestId));
		for (const id of ids) expect(seen?.has(id)).toBe(true);
	});

	test("POST /tasks as a guest: forced into the default list's backlog with the guest tag", async () => {
		const [extra] = await w.h.deps.db
			.insert(workList)
			.values({
				projectId: shop.id,
				name: "Internal",
				position: "z",
			})
			.returning();
		const [active] = await w.h.deps.db
			.select()
			.from(workStatus)
			.where(
				and(
					eq(workStatus.projectId, shop.id),
					eq(workStatus.category, "active"),
				),
			);
		const res = await w.h.call("POST", "/api/work/tasks", {
			...w.as(guestCookie),
			body: {
				listId: extra?.id,
				statusId: active?.id,
				title: "The logo is blurry",
			},
		});
		expect(res.status).toBe(201);
		const [backlog] = await w.h.deps.db
			.select()
			.from(workStatus)
			.where(eq(workStatus.id, res.json.statusId));
		expect(backlog?.category).toBe("backlog");
		expect(res.json.listId).toBe(shop.listId);
		const [tag] = await w.h.deps.db
			.select()
			.from(workTag)
			.where(eq(workTag.id, res.json.tagIds[0]));
		expect(tag?.name).toBe("From guest");

		await w.h.deps.db
			.update(workProject)
			.set({ guestsCanCreate: false })
			.where(eq(workProject.projectId, shop.id));
		const refused = await w.h.call("POST", "/api/work/tasks", {
			...w.as(guestCookie),
			body: { listId: shop.listId, title: "Another one" },
		});
		expect(refused.status).toBe(403);
		await w.h.deps.db
			.update(workProject)
			.set({ guestsCanCreate: true })
			.where(eq(workProject.projectId, shop.id));
	});

	test("the guest role can't be org-wide without scoped grants", async () => {
		const res = await w.h.call("POST", "/api/invitations", {
			...w.as(),
			body: { email: "nobody@example.com", role: "guest" },
		});
		expect(res.status).toBe(400);
		const scoped = await w.h.call("POST", "/api/invitations", {
			...w.as(),
			body: {
				email: "nobody@example.com",
				role: "guest",
				grants: [{ role: "guest", scope: { kind: "folder", id: "fld_x" } }],
			},
		});
		expect(scoped.status).toBe(400);
	});

	test("guestCreateDefaults: backlog of the default list with a From guest tag, only when allowed", async () => {
		const actor = await actorOf(guestId);
		const resource = await locate(w.h.deps.db, w.orgId, "project", shop.id);
		const d = await guestCreateDefaults(w.h.deps.db, actor, resource);
		const [backlog] = await w.h.deps.db
			.select()
			.from(workStatus)
			.where(eq(workStatus.id, d?.statusId ?? ""));
		expect(backlog?.category).toBe("backlog");
		expect(d?.listId).toBe(shop.listId);
		const [tag] = await w.h.deps.db
			.select()
			.from(workTag)
			.where(eq(workTag.id, d?.tagId ?? ""));
		expect(tag?.name).toBe("From guest");
		expect(
			(await guestCreateDefaults(w.h.deps.db, actor, resource))?.tagId,
		).toBe(d?.tagId);

		const owner = await actorOf(
			(await w.h.call("GET", "/api/me", w.as())).json.userId,
		);
		expect(await guestCreateDefaults(w.h.deps.db, owner, resource)).toBeNull();

		await w.h.deps.db
			.update(workProject)
			.set({ guestsCanCreate: false })
			.where(eq(workProject.projectId, shop.id));
		await expect(
			guestCreateDefaults(w.h.deps.db, actor, resource),
		).rejects.toBeInstanceOf(Failure);
	});
});

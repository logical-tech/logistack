import { createRoute, z } from "@hono/zod-openapi";
import {
	NetworkDevice,
	NetworkDeviceInput,
	NetworkDeviceUpdateInput,
	NetworkPerson,
	NetworkPersonInput,
	NetworkPersonUpdateInput,
} from "@logistack/contracts";
import { networkDevice, networkPerson } from "@logistack/db";
import { asc, count, eq } from "drizzle-orm";
import type { Context } from "hono";
import { mutation } from "../audit.ts";
import type { Env } from "../env.ts";
import { Failure, notFound } from "../errors.ts";
import { log } from "../log.ts";
import { body, errors, json, router, security } from "../openapi.ts";
import { requestProxySync } from "../redis.ts";
import { requireInstanceAdmin } from "../scope.ts";

const tags = ["networking"];
// The house belongs to the instance, like the home DNS that applies it.
const middleware = [requireInstanceAdmin];
const IdParam = z.object({ id: z.string().min(1).max(64) });

const sync = (c: Context<Env>, reason: string) =>
	requestProxySync(c.var.deps.config.REDIS_URL, reason).catch((err: unknown) =>
		log("warn", "proxy sync request failed", { error: String(err) }),
	);

type PersonRow = typeof networkPerson.$inferSelect;
type DeviceRow = typeof networkDevice.$inferSelect;

const personView = (p: PersonRow, devices: number): NetworkPerson => ({
	id: p.id,
	name: p.name,
	blocking: p.blocking,
	devices,
	createdAt: p.createdAt.toISOString(),
});

const deviceView = (d: DeviceRow, people: PersonRow[]): NetworkDevice => ({
	id: d.id,
	name: d.name,
	address: d.address,
	personId: d.personId,
	personName: people.find((p) => p.id === d.personId)?.name ?? null,
	blocking: d.blocking,
	createdAt: d.createdAt.toISOString(),
});

async function person(c: Context<Env>, id: string) {
	const [p] = await c.var.deps.db
		.select()
		.from(networkPerson)
		.where(eq(networkPerson.id, id));
	if (!p) throw notFound("person");
	return p;
}

async function deviceCount(c: Context<Env>, personId: string) {
	const [r] = await c.var.deps.db
		.select({ n: count() })
		.from(networkDevice)
		.where(eq(networkDevice.personId, personId));
	return r?.n ?? 0;
}

/** One device per address: the home DNS can only tell clients apart by it. */
function uniqueAddress<T>(call: Promise<T>, address: string): Promise<T> {
	return call.catch((e: unknown) => {
		if (String((e as { code?: string }).code) === "23505")
			throw new Failure("conflict", `a device already has ${address}`);
		throw e;
	});
}

const people = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/network/people",
			tags,
			security,
			summary: "People of the home network, by name",
			description:
				"Virtual members: they group devices and can block more for them. They do not sign in.",
			middleware,
			responses: { 200: json(z.array(NetworkPerson), "People"), ...errors },
		}),
		async (c) => {
			const { db } = c.var.deps;
			const rows = await db
				.select()
				.from(networkPerson)
				.orderBy(asc(networkPerson.name));
			const counts = await db
				.select({ id: networkDevice.personId, n: count() })
				.from(networkDevice)
				.groupBy(networkDevice.personId);
			return c.json(
				rows.map((p) =>
					personView(p, counts.find((x) => x.id === p.id)?.n ?? 0),
				),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"network.person_create",
			createRoute({
				method: "post",
				path: "/network/people",
				tags,
				security,
				summary: "Add a person",
				middleware,
				request: body(NetworkPersonInput),
				responses: { 201: json(NetworkPerson, "Person"), ...errors },
			}),
		),
		async (c) => {
			const [row] = await c.var.deps.db
				.insert(networkPerson)
				.values(c.req.valid("json"))
				.returning();
			if (!row) throw new Error("insert returned no row");
			c.set("auditResourceId", row.id);
			await sync(c, "network person added");
			return c.json(personView(row, 0), 201);
		},
	)
	.openapi(
		mutation(
			"network.person_update",
			createRoute({
				method: "patch",
				path: "/network/people/{id}",
				tags,
				security,
				summary: "Rename a person or change what is blocked for them",
				middleware,
				request: { params: IdParam, ...body(NetworkPersonUpdateInput) },
				responses: { 200: json(NetworkPerson, "Person"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			c.set("auditResourceId", id);
			const before = await person(c, id);
			const [row] = await c.var.deps.db
				.update(networkPerson)
				.set(c.req.valid("json"))
				.where(eq(networkPerson.id, id))
				.returning();
			if (!row) throw notFound("person");
			c.set("auditDiff", {
				before: { name: before.name, blocking: before.blocking },
				after: { name: row.name, blocking: row.blocking },
			});
			await sync(c, "network person updated");
			return c.json(personView(row, await deviceCount(c, id)), 200);
		},
	)
	.openapi(
		mutation(
			"network.person_delete",
			createRoute({
				method: "delete",
				path: "/network/people/{id}",
				tags,
				security,
				summary: "Remove a person; their devices stay, with no person",
				middleware,
				request: { params: IdParam },
				responses: { 204: { description: "Removed" }, ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			c.set("auditResourceId", id);
			const [row] = await c.var.deps.db
				.delete(networkPerson)
				.where(eq(networkPerson.id, id))
				.returning({ id: networkPerson.id });
			if (!row) throw notFound("person");
			await sync(c, "network person removed");
			return c.body(null, 204);
		},
	);

const devices = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/network/devices",
			tags,
			security,
			summary: "Devices of the home network, by name",
			description:
				"A device is a home DNS client known by its IP address; give it a fixed address or a DHCP reservation so the name stays right.",
			middleware,
			responses: { 200: json(z.array(NetworkDevice), "Devices"), ...errors },
		}),
		async (c) => {
			const { db } = c.var.deps;
			const [rows, all] = await Promise.all([
				db.select().from(networkDevice).orderBy(asc(networkDevice.name)),
				db.select().from(networkPerson),
			]);
			return c.json(
				rows.map((d) => deviceView(d, all)),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"network.device_create",
			createRoute({
				method: "post",
				path: "/network/devices",
				tags,
				security,
				summary: "Name a device by its address, optionally for a person",
				middleware,
				request: body(NetworkDeviceInput),
				responses: { 201: json(NetworkDevice, "Device"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const owner = input.personId ? [await person(c, input.personId)] : [];
			const [row] = await uniqueAddress(
				c.var.deps.db.insert(networkDevice).values(input).returning(),
				input.address,
			);
			if (!row) throw new Error("insert returned no row");
			c.set("auditResourceId", row.id);
			await sync(c, "network device added");
			return c.json(deviceView(row, owner), 201);
		},
	)
	.openapi(
		mutation(
			"network.device_update",
			createRoute({
				method: "patch",
				path: "/network/devices/{id}",
				tags,
				security,
				summary:
					"Rename a device, move it to another person or change what is blocked for it",
				middleware,
				request: { params: IdParam, ...body(NetworkDeviceUpdateInput) },
				responses: { 200: json(NetworkDevice, "Device"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			c.set("auditResourceId", id);
			const { db } = c.var.deps;
			const [before] = await db
				.select()
				.from(networkDevice)
				.where(eq(networkDevice.id, id));
			if (!before) throw notFound("device");
			if (input.personId) await person(c, input.personId);
			const [row] = await uniqueAddress(
				db
					.update(networkDevice)
					.set(input)
					.where(eq(networkDevice.id, id))
					.returning(),
				input.address ?? before.address,
			);
			if (!row) throw notFound("device");
			c.set("auditDiff", {
				before: {
					name: before.name,
					address: before.address,
					personId: before.personId,
					blocking: before.blocking,
				},
				after: {
					name: row.name,
					address: row.address,
					personId: row.personId,
					blocking: row.blocking,
				},
			});
			await sync(c, "network device updated");
			return c.json(
				deviceView(row, await db.select().from(networkPerson)),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"network.device_delete",
			createRoute({
				method: "delete",
				path: "/network/devices/{id}",
				tags,
				security,
				summary: "Forget a device",
				middleware,
				request: { params: IdParam },
				responses: { 204: { description: "Removed" }, ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			c.set("auditResourceId", id);
			const [row] = await c.var.deps.db
				.delete(networkDevice)
				.where(eq(networkDevice.id, id))
				.returning({ id: networkDevice.id });
			if (!row) throw notFound("device");
			await sync(c, "network device removed");
			return c.body(null, 204);
		},
	);

export const networkPeopleRoutes = router()
	.route("/", people)
	.route("/", devices);

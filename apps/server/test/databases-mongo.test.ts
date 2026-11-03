import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { encrypt } from "@logistack/core";
import { auditLog, envVar } from "@logistack/db";
import { and, eq } from "drizzle-orm";
import { BSON, MongoClient } from "mongodb";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const { EJSON, ObjectId, Long, Decimal128, Binary, Int32, Double } = BSON;
const name = `ls-test-dbx-${crypto.randomUUID().slice(0, 8)}-mongo`;

function docker(...args: string[]) {
	const p = Bun.spawnSync(["docker", ...args], { stderr: "pipe" });
	if (p.exitCode !== 0)
		throw new Error(`docker ${args[0]} failed: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
}

/** Starts mongo:8 and waits until the root user can log in over TCP (init runs without it). */
async function startMongo() {
	docker(
		"run",
		"-d",
		"--name",
		name,
		"--label",
		"logistack.test=dbx",
		"-p",
		"127.0.0.1::27017",
		"-e",
		"MONGO_INITDB_ROOT_USERNAME=root",
		"-e",
		"MONGO_INITDB_ROOT_PASSWORD=test",
		"mongo:8",
	);
	const [host, port] = (
		docker("port", name, "27017/tcp").split("\n")[0] ?? ""
	).split(":") as [string, string];
	const target = { host, port: Number(port) };
	const deadline = Date.now() + 120_000;
	for (;;) {
		const c = new MongoClient(`mongodb://${host}:${port}/`, {
			auth: { username: "root", password: "test" },
			directConnection: true,
			serverSelectionTimeoutMS: 1000,
		});
		try {
			await c.db("admin").command({ ping: 1 });
			return { target, admin: c };
		} catch (e) {
			await c.close().catch(() => {});
			if (Date.now() > deadline) throw e;
			await Bun.sleep(500);
		}
	}
}

describe.skipIf(!hasDocker)("database explorer on MongoDB", () => {
	let h: Harness;
	let cookie: string;
	let viewer: string;
	let id: string;
	let admin: MongoClient;
	let target: { host: string; port: number };

	const setEnv = async (key: string, value: string) => {
		await h.deps.db
			.delete(envVar)
			.where(and(eq(envVar.scopeId, id), eq(envVar.key, key)));
		await h.deps.db.insert(envVar).values({
			scope: "service",
			scopeId: id,
			key,
			valueEncrypted: await encrypt(h.deps.masterKey, value),
		});
	};
	type Item = {
		_id: InstanceType<typeof ObjectId> | string | number;
		name: string;
		qty: number;
	};
	const shop = () => admin.db("shop");
	const schema = () =>
		h.call("GET", `/api/databases/${id}/schema`, { headers: { cookie } });
	type Params = {
		limit?: number;
		cursor?: string;
		filter?: unknown;
		sort?: unknown;
		projection?: unknown;
	};
	const find = (
		coll: string,
		p: Params = {},
		headers: Record<string, string> = { cookie },
	) => {
		const qs = new URLSearchParams();
		for (const [k, v] of Object.entries(p))
			if (v !== undefined)
				qs.set(k, typeof v === "string" ? v : EJSON.stringify(v));
		return h.call(
			"GET",
			`/api/databases/${id}/collections/shop/${coll}/documents?${qs}`,
			{ headers },
		);
	};
	const write = (
		coll: string,
		op: unknown,
		headers: Record<string, string> = { cookie },
	) =>
		h.call("POST", `/api/databases/${id}/collections/shop/${coll}/documents`, {
			headers,
			body: op,
		});
	const pages = async (coll: string, p: Params) => {
		const all: Record<string, unknown>[] = [];
		let cursor: string | undefined;
		let count = 0;
		do {
			const r = await find(coll, { ...p, cursor });
			expect(r.status).toBe(200);
			all.push(...r.json.documents);
			cursor = r.json.nextCursor ?? undefined;
			count++;
		} while (cursor);
		return { all, count };
	};

	beforeAll(async () => {
		const [mongo, harness] = await Promise.all([
			startMongo(),
			startHarness({ area: "dbx", label: "dbx" }),
		]);
		({ admin, target } = mongo);
		h = harness;
		// 1190 ObjectIds, then strings and numbers: `_id` order crosses BSON types.
		await shop()
			.collection<Item>("items")
			.insertMany([
				...Array.from({ length: 1190 }, (_, i) => ({
					_id: new ObjectId(),
					name: `item ${i}`,
					qty: i % 7,
				})),
				...Array.from({ length: 5 }, (_, i) => ({
					_id: `sku-${i}`,
					name: `sku ${i}`,
					qty: 3,
				})),
				...Array.from({ length: 5 }, (_, i) => ({
					_id: i,
					name: `n ${i}`,
					qty: 9,
				})),
			]);
		await shop().collection("notes").insertOne({ body: "keep" });
		await shop().createCollection("big_items", {
			viewOn: "items",
			pipeline: [{ $match: { qty: { $gte: 5 } } }],
		});
		await admin.db("other").collection("empty_soon").insertOne({ a: 1 });

		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		const prj = await h.call("POST", "/api/projects", {
			headers: { cookie },
			body: { name: "Shop" },
		});
		const envId = (
			await h.call("GET", `/api/projects/${prj.json.id}/environments`, {
				headers: { cookie },
			})
		).json[0].id;
		const created = await h.call(
			"POST",
			`/api/environments/${envId}/services`,
			{
				headers: { cookie },
				body: {
					name: "mongo-db",
					spec: {
						kind: "database",
						engine: "mongo",
						version: "8",
						credentialsRef: "env",
						resources: {},
					},
				},
			},
		);
		expect(created.status).toBe(201);
		id = created.json.id;
		await setEnv("MONGO_INITDB_ROOT_USERNAME", "root");
		await setEnv("MONGO_INITDB_ROOT_PASSWORD", "test");
		await setEnv("MONGO_INITDB_DATABASE", "shop");
		h.deps.databaseEndpoint = () => target;
		h.deps.databaseStatementTimeoutMs = 2000;

		const user = { name: "viewer", email: "viewer@example.com" };
		const password = "viewer password 12";
		const invite = await h.call("POST", "/api/invitations", {
			headers: { cookie },
			body: { email: user.email, role: "viewer" },
		});
		expect(invite.status).toBe(201);
		await h.call("POST", "/api/auth/sign-up/email", {
			body: { ...user, password },
		});
		viewer = await h.signIn(user.email, password);
		await h.call("POST", "/api/auth/organization/accept-invitation", {
			headers: { cookie: viewer },
			body: { invitationId: invite.json.id },
		});
	}, 180_000);

	afterAll(async () => {
		await admin?.close().catch(() => {});
		await h?.close();
		Bun.spawnSync(["docker", "rm", "-f", "-v", name], {
			stdout: "ignore",
			stderr: "ignore",
		});
	});

	test("databases are schemas and collections are tables, system ones hidden", async () => {
		const r = await schema();
		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({ engine: "mongo", database: "shop" });
		expect(r.json.schemas.map((s: { name: string }) => s.name)).toEqual([
			"other",
			"shop",
		]);
		const byName = Object.fromEntries(
			r.json.schemas[1].tables.map((t: { name: string }) => [t.name, t]),
		);
		expect(Object.keys(byName).sort()).toEqual(["big_items", "items", "notes"]);
		expect(byName.items).toEqual({
			name: "items",
			kind: "collection",
			rows: 1200,
			editable: true,
			columns: [
				{
					name: "_id",
					type: "objectId",
					nullable: false,
					default: null,
					primaryKey: true,
				},
				{
					name: "name",
					type: "string",
					nullable: true,
					default: null,
					primaryKey: false,
				},
				{
					name: "qty",
					type: "int",
					nullable: true,
					default: null,
					primaryKey: false,
				},
			],
		});
		expect(byName.big_items).toMatchObject({
			kind: "view",
			rows: null,
			editable: false,
		});
	});

	test("pages by _id across BSON types, every _id exactly once", async () => {
		const { all, count } = await pages("items", { limit: 500 });
		expect(count).toBe(3);
		const ids = all.map((d) => EJSON.stringify(d._id));
		expect(new Set(ids).size).toBe(1200);
		const expected = await shop()
			.collection("items")
			.find(
				{},
				{ projection: { _id: 1 }, sort: { _id: 1 }, promoteValues: false },
			)
			.toArray();
		expect(ids).toEqual(
			expected.map((d) => EJSON.stringify(d._id, { relaxed: false })),
		);
		expect(ids.slice(0, 2)).toEqual([
			'{"$numberInt":"0"}',
			'{"$numberInt":"1"}',
		]);

		const desc = await pages("items", { limit: 500, sort: { _id: -1 } });
		expect(desc.all.map((d) => EJSON.stringify(d._id))).toEqual(
			[...ids].reverse(),
		);
	});

	test("filter, sort and projection; non-_id sorts page by offset", async () => {
		const { all, count } = await pages("items", {
			limit: 100,
			filter: { qty: { $gte: 5 } },
			sort: { qty: -1, name: 1 },
			projection: { qty: 1, _id: 0 },
		});
		expect(count).toBe(4);
		expect(all.length).toBe(
			await shop()
				.collection("items")
				.countDocuments({ qty: { $gte: 5 } }),
		);
		expect(new Set(all.map((d) => EJSON.stringify(d._id))).size).toBe(
			all.length,
		);
		for (const d of all) expect(Object.keys(d).sort()).toEqual(["_id", "qty"]);
		const qtys = all.map((d) =>
			Number((d.qty as { $numberInt: string }).$numberInt),
		);
		expect(qtys).toEqual([...qtys].sort((a, b) => b - a));
		expect(qtys[0]).toBe(9);

		const one = await find("items", { filter: { _id: "sku-2" } });
		expect(one.json.documents).toEqual([
			{ _id: "sku-2", name: "sku 2", qty: { $numberInt: "3" } },
		]);
		const oid = await find("items", { limit: 1 });
		const byOid = await find("items", {
			filter: { _id: oid.json.documents[0]._id },
		});
		expect(byOid.json.documents).toEqual(oid.json.documents);
	});

	test("every BSON type round-trips exactly through read, insert and replace", async () => {
		const at = new Date("2024-01-02T03:04:05.123Z");
		const original = {
			_id: new ObjectId(),
			at,
			price: Decimal128.fromString("12345678901234567890.1234567890"),
			big: Long.fromString("9007199254740993"),
			small: new Int32(7),
			ratio: new Double(2),
			raw: new Binary(new Uint8Array([0, 255, 16])),
			uuid: new Binary(
				new Uint8Array(Buffer.from("0123456789abcdef0123456789abcdef", "hex")),
				4,
			),
			nested: [[new Int32(1), { a: [new Double(2.5), null, "x"] }], []],
			doc: { deep: { flag: true } },
		};
		await shop().collection("kinds").insertOne(original);
		const r = await find("kinds", { filter: { _id: original._id } });
		expect(r.status).toBe(200);
		const [doc] = r.json.documents;
		expect(doc).toEqual(EJSON.serialize(original, { relaxed: false }));
		expect(doc.at).toEqual({ $date: { $numberLong: String(at.getTime()) } });
		expect(doc.big).toEqual({ $numberLong: "9007199254740993" });

		// Replacing with what was read stores the same bytes.
		const replaced = await write("kinds", {
			op: "replace",
			id: doc._id,
			document: doc,
		});
		expect(replaced.status).toBe(200);
		expect(replaced.json.document).toEqual(doc);
		const stored = await shop()
			.collection("kinds")
			.findOne({ _id: original._id }, { promoteValues: false });
		expect(BSON.serialize(stored ?? {})).toEqual(BSON.serialize(original));

		// An insert of the same Extended JSON under a new _id keeps every type too.
		const { _id, ...rest } = doc;
		const inserted = await write("kinds", { op: "insert", document: rest });
		expect(inserted.status).toBe(200);
		expect(inserted.json.document._id.$oid).toMatch(/^[0-9a-f]{24}$/);
		const types = await shop()
			.collection("kinds")
			.aggregate([
				{ $match: { _id: new ObjectId(inserted.json.document._id.$oid) } },
				{
					$project: {
						_id: 0,
						at: { $type: "$at" },
						price: { $type: "$price" },
						big: { $type: "$big" },
						small: { $type: "$small" },
						ratio: { $type: "$ratio" },
						raw: { $type: "$raw" },
					},
				},
			])
			.toArray();
		expect(types).toEqual([
			{
				at: "date",
				price: "decimal",
				big: "long",
				small: "int",
				ratio: "double",
				raw: "binData",
			},
		]);
	});

	test("$where, $function and $accumulator are rejected anywhere", async () => {
		const fn = { body: "function() { return true }", args: [], lang: "js" };
		const cases: Params[] = [
			{ filter: { $where: "sleep(1)" } },
			{ filter: { $and: [{ qty: 1 }, { $or: [{ $where: "true" }] }] } },
			{ filter: { $or: [{ $expr: { $function: fn } }] } },
			{
				filter: {
					$expr: { $eq: [{ $accumulator: { init: fn.body } }, 1] },
				},
			},
			{ projection: { x: { $function: fn } } },
			{ sort: { qty: 1, $where: 1 } },
			{ filter: '{"\\u0024where": "sleep(1)"}' },
		];
		for (const p of cases) {
			const r = await find("items", p);
			expect(r.status).toBe(400);
			expect(r.json.error.message).toMatch(/\$where|\$function|\$accumulator/);
		}
		expect((await find("items", { filter: "{nope" })).status).toBe(400);
		expect((await find("items", { filter: "[1]" })).status).toBe(400);
		expect(
			(await find("items", { filter: { _id: { $oid: "zz" } } })).status,
		).toBe(400);
		expect((await find("items", { cursor: "garbage" })).status).toBe(400);
	});

	test("replace and delete by _id; a missing _id is a 409 stale", async () => {
		const [note] = (await find("notes")).json.documents;
		const replaced = await write("notes", {
			op: "replace",
			id: note._id,
			document: { body: "edited" },
		});
		expect(replaced.status).toBe(200);
		expect(replaced.json.document).toEqual({ _id: note._id, body: "edited" });

		const del = await write("notes", { op: "delete", id: note._id });
		expect(del.status).toBe(200);
		expect(del.json.document).toBeNull();
		expect(await shop().collection("notes").countDocuments()).toBe(0);

		const again = await write("notes", { op: "delete", id: note._id });
		expect(again.status).toBe(409);
		expect(again.json.error.details.reason).toBe("stale");
		const gone = await write("notes", {
			op: "replace",
			id: note._id,
			document: { body: "x" },
		});
		expect(gone.status).toBe(409);
		expect(gone.json.error.details.reason).toBe("stale");
		expect(await shop().collection("notes").countDocuments()).toBe(0);

		expect(
			(await write("big_items", { op: "delete", id: { $numberInt: "1" } }))
				.status,
		).toBe(400);
		const audit = await h.deps.db
			.select({ outcome: auditLog.outcome, diff: auditLog.diff })
			.from(auditLog)
			.where(eq(auditLog.action, "database.document_write"));
		expect(audit).toContainEqual({
			outcome: "success",
			diff: {
				database: "shop",
				collection: "notes",
				op: "delete",
				id: note._id,
			},
		});
	});

	test("a viewer reads documents but cannot write them", async () => {
		expect((await find("items", {}, { cookie: viewer })).status).toBe(200);
		const w = await write(
			"items",
			{ op: "delete", id: "sku-0" },
			{ cookie: viewer },
		);
		expect(w.status).toBe(403);
		expect(
			await shop().collection<Item>("items").countDocuments({ _id: "sku-0" }),
		).toBe(1);
	});

	test("SQL routes are a 400 on a Mongo service", async () => {
		const rows = await h.call(
			"GET",
			`/api/databases/${id}/tables/shop/items/rows`,
			{ headers: { cookie } },
		);
		expect(rows.status).toBe(400);
		const q = await h.call("POST", `/api/databases/${id}/query`, {
			headers: { cookie },
			body: { sql: "select 1" },
		});
		expect(q.status).toBe(400);
	});

	// Matches nothing, so the find evaluates every document instead of stopping at a page.
	test("a find past maxTimeMS is stopped", async () => {
		const t = performance.now();
		const r = await find("items", {
			filter: {
				$expr: {
					$gt: [
						{
							$size: {
								$filter: {
									input: { $range: [0, { $add: [200_000, "$qty"] }] },
									cond: { $gt: [{ $sqrt: "$$this" }, -1] },
								},
							},
						},
						1e9,
					],
				},
			},
		});
		expect(r.status).toBe(400);
		expect(r.json.error.details.engineCode).toBe("MaxTimeMSExpired");
		expect(performance.now() - t).toBeLessThan(4000);
	}, 15_000);

	test("refused credentials are a 409 auth, unreachable a 409 too", async () => {
		await setEnv("MONGO_INITDB_ROOT_PASSWORD", "wrong");
		const refused = await schema();
		expect(refused.status).toBe(409);
		expect(refused.json.error.details.reason).toBe("auth");
		await setEnv("MONGO_INITDB_ROOT_PASSWORD", "test");
		expect((await schema()).status).toBe(200);
		const real = h.deps.databaseEndpoint;
		h.deps.databaseEndpoint = () => ({ host: "127.0.0.1", port: 1 });
		try {
			const r = await schema();
			expect(r.status).toBe(409);
			expect(r.json.error.details.reason).toBe("unreachable");
		} finally {
			h.deps.databaseEndpoint = real;
		}
	}, 20_000);
});

import type {
	CollectionRef,
	DatabaseSchema,
	DbColumn,
	DocumentsQuery,
	DocumentWrite,
} from "@logistack/contracts";
import {
	BSON,
	type Document,
	type Filter,
	MongoClient,
	MongoNetworkError,
	MongoServerError,
	MongoServerSelectionError,
} from "mongodb";
import {
	type DatabaseConnection,
	DatabaseError,
	type DocumentClient,
} from "./index.ts";

const { EJSON } = BSON;
const SYSTEM_DATABASES = new Set(["admin", "config", "local"]);
/** Operators that run server-side JavaScript. */
const FORBIDDEN = new Set(["$where", "$function", "$accumulator"]);
const SAMPLE = 20;

/** `$type` aliases for the BSON wrapper classes; plain JS values are named by `typeOf`. */
const BSON_TYPE: Record<string, string> = {
	ObjectId: "objectId",
	Int32: "int",
	Double: "double",
	Long: "long",
	Decimal128: "decimal",
	Binary: "binData",
	Timestamp: "timestamp",
	BSONRegExp: "regex",
	Code: "javascript",
	MinKey: "minKey",
	MaxKey: "maxKey",
};

function typeOf(v: unknown): string {
	if (v === null) return "null";
	if (v instanceof Date) return "date";
	if (Array.isArray(v)) return "array";
	if (typeof v === "boolean") return "bool";
	if (typeof v !== "object") return typeof v;
	const t = (v as { _bsontype?: string })._bsontype;
	return t ? (BSON_TYPE[t] ?? t) : "object";
}

/** Top-level fields of a sample, `_id` first, each typed by its first non-null value. */
function fields(sample: Document[]): DbColumn[] {
	const types = new Map<string, string>();
	for (const doc of sample)
		for (const [k, v] of Object.entries(doc))
			if (!types.has(k) || types.get(k) === "null") types.set(k, typeOf(v));
	return [...types]
		.sort(([a], [b]) => (a === "_id" ? -1 : b === "_id" ? 1 : 0))
		.map(([name, type]) => ({
			name,
			type,
			nullable: name !== "_id",
			default: null,
			primaryKey: name === "_id",
		}));
}

function wrap(op: string, e: unknown): DatabaseError {
	if (e instanceof DatabaseError) return e;
	const message = e instanceof Error ? e.message : String(e);
	if (e instanceof MongoServerSelectionError || e instanceof MongoNetworkError)
		return new DatabaseError(op, message, "unreachable");
	if (e instanceof MongoServerError)
		return new DatabaseError(
			op,
			message,
			e.code === 18 ? "auth" : "query",
			e.codeName ?? String(e.code),
		);
	return new DatabaseError(op, message, "query");
}

/**
 * Parses an Extended JSON object from the client; `relaxed` keeps plain numbers (sort and
 * projection), canonical turns them into int32, long or double like the shell does.
 */
function ejsonObject(
	op: string,
	name: string,
	text: string | undefined,
	relaxed: boolean,
): Document {
	if (!text?.trim()) return {};
	let raw: unknown;
	try {
		raw = JSON.parse(text, (k, v) => {
			if (FORBIDDEN.has(k))
				throw new DatabaseError(op, `${k} is not allowed in ${name}`, "query");
			return v;
		});
	} catch (e) {
		if (e instanceof DatabaseError) throw e;
		throw new DatabaseError(op, `${name} is not valid JSON`, "query");
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		throw new DatabaseError(op, `${name} must be a JSON object`, "query");
	return ejsonValue(op, name, raw, relaxed) as Document;
}

function ejsonValue(op: string, name: string, v: unknown, relaxed = false) {
	try {
		return EJSON.deserialize({ v }, { relaxed }).v as unknown;
	} catch (e) {
		throw new DatabaseError(
			op,
			`${name} is not valid Extended JSON: ${(e as Error).message}`,
			"query",
		);
	}
}

const canonical = (v: unknown) =>
	EJSON.serialize({ v }, { relaxed: false }).v as unknown;

type Cursor = { after: unknown } | { skip: number };

const encode = (c: Cursor) =>
	Buffer.from(JSON.stringify(c)).toString("base64url");

function decode(raw: string, keyset: boolean): Cursor {
	try {
		const c = JSON.parse(Buffer.from(raw, "base64url").toString());
		if (keyset && "after" in c) return c;
		if (!keyset && Number.isInteger(c.skip) && c.skip >= 0) return c;
	} catch {}
	throw new DatabaseError("find", "cursor does not match this sort", "query");
}

export function mongoClient(conn: DatabaseConnection): DocumentClient {
	const maxTimeMS = conn.statementTimeoutMs ?? 30_000;
	const client = new MongoClient(`mongodb://${conn.host}:${conn.port}/`, {
		auth: { username: conn.user, password: conn.password },
		authSource: "admin",
		directConnection: true,
		appName: "logistack-explorer",
		maxPoolSize: 4,
		maxIdleTimeMS: 300_000,
		serverSelectionTimeoutMS: 5000,
		connectTimeoutMS: 5000,
		// Values keep their BSON type (int32 stays int32, long stays long), so Extended JSON is exact.
		promoteValues: false,
		promoteLongs: false,
		promoteBuffers: false,
		bsonRegExp: true,
	});
	const coll = (ref: CollectionRef) =>
		client.db(ref.database).collection(ref.collection);

	return {
		kind: "document",
		async introspect(): Promise<DatabaseSchema> {
			try {
				const { databases } = await client
					.db("admin")
					.admin()
					.listDatabases({ nameOnly: true });
				const names = databases
					.map((d) => d.name)
					.filter((n) => !SYSTEM_DATABASES.has(n))
					.sort();
				const schemas = await Promise.all(
					names.map(async (name) => {
						const db = client.db(name);
						const infos = (await db.listCollections().toArray())
							.filter((c) => !c.name.startsWith("system."))
							.sort((a, b) => a.name.localeCompare(b.name));
						const tables = await Promise.all(
							infos.map(async (c) => {
								const plain = c.type === "collection";
								const col = db.collection(c.name);
								const [rows, sample] = await Promise.all([
									plain
										? col.estimatedDocumentCount({ maxTimeMS }).then(Number)
										: null,
									// A view whose pipeline fails still lists, without fields.
									col
										.find({}, { limit: SAMPLE, maxTimeMS })
										.toArray()
										.catch(() => []),
								]);
								return {
									name: c.name,
									kind: c.type === "view" ? ("view" as const) : "collection",
									rows,
									editable: plain,
									columns: fields(sample),
								} as const;
							}),
						);
						return { name, tables };
					}),
				);
				return { engine: "mongo", database: conn.database, schemas };
			} catch (e) {
				throw wrap("introspect", e);
			}
		},

		async find(ref, q: DocumentsQuery) {
			const filter = ejsonObject("find", "filter", q.filter, false);
			const sort = ejsonObject("find", "sort", q.sort, true);
			const projection = ejsonObject("find", "projection", q.projection, true);
			if (Number(projection._id) === 0) delete projection._id;
			const keys = Object.keys(sort);
			const keyset = keys.every((k) => k === "_id");
			const dir = keyset && Number(sort._id) < 0 ? -1 : 1;
			const cursor = q.cursor ? decode(q.cursor, keyset) : undefined;
			const where =
				cursor && "after" in cursor
					? {
							$and: [
								filter,
								// $expr compares across BSON types in sort order, so mixed `_id` types page too.
								{
									$expr: {
										[dir > 0 ? "$gt" : "$lt"]: [
											"$_id",
											{ $literal: ejsonValue("find", "cursor", cursor.after) },
										],
									},
								},
							],
						}
					: filter;
			const skip = cursor && "skip" in cursor ? cursor.skip : 0;
			try {
				const docs = await coll(ref)
					.find(where, {
						sort: keyset ? { _id: dir } : { ...sort, _id: sort._id ?? 1 },
						projection,
						skip,
						limit: q.limit + 1,
						maxTimeMS,
					})
					.toArray();
				const more = docs.length > q.limit;
				if (more) docs.pop();
				const last = docs.at(-1);
				return {
					documents: docs.map((d) => EJSON.serialize(d, { relaxed: false })),
					nextCursor:
						more && last
							? encode(
									keyset
										? { after: canonical(last._id) }
										: { skip: skip + q.limit },
								)
							: null,
				};
			} catch (e) {
				throw wrap("find", e);
			}
		},

		async write(ref, op: DocumentWrite) {
			const id =
				op.op === "insert" ? undefined : ejsonValue("write", "id", op.id);
			const doc =
				op.op === "delete"
					? undefined
					: (ejsonValue("write", "document", op.document) as Document);
			const stale = () =>
				new DatabaseError(
					"write",
					`no document in ${ref.database}.${ref.collection} has this _id`,
					"stale",
				);
			try {
				if (op.op === "insert") {
					// insertOne sets a generated `_id` on the document it is given.
					await coll(ref).insertOne(doc as Document, { maxTimeMS });
					return {
						document: EJSON.serialize(doc as Document, { relaxed: false }),
					};
				}
				if (op.op === "replace") {
					const after = await coll(ref).findOneAndReplace(
						{ _id: id } as Filter<Document>,
						doc as Document,
						{ returnDocument: "after", maxTimeMS },
					);
					if (!after) throw stale();
					return { document: EJSON.serialize(after, { relaxed: false }) };
				}
				const r = await coll(ref).deleteOne({ _id: id } as Filter<Document>, {
					maxTimeMS,
				});
				// Counts come back as Int32 objects, which are always truthy.
				if (Number(r.deletedCount) === 0) throw stale();
				return { document: null };
			} catch (e) {
				throw wrap("write", e);
			}
		},

		close: () => client.close(),
	};
}

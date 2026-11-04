import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { encrypt, LIBSQL_ENV, libsqlCredentials } from "@logistack/core";
import { envVar } from "@logistack/db";
import { eq } from "drizzle-orm";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const name = `ls-test-dbx-${crypto.randomUUID().slice(0, 8)}-libsql`;
const IMAGE = "ghcr.io/tursodatabase/libsql-server:v0.24.33";
/** Pulled when missing, retried past registry rate limits; skipped only if it never arrives. */
const hasImage = (() => {
	if (!hasDocker) return false;
	const present = () =>
		Bun.spawnSync(["docker", "image", "inspect", IMAGE], {
			stdout: "ignore",
			stderr: "ignore",
		}).exitCode === 0;
	for (let attempt = 1; attempt <= 4 && !present(); attempt++) {
		if (
			Bun.spawnSync(["docker", "pull", "-q", IMAGE], {
				stdout: "ignore",
				stderr: "ignore",
			}).exitCode === 0
		)
			break;
		Bun.sleepSync(2_000 * attempt);
	}
	return present();
})();

function docker(...args: string[]) {
	const p = Bun.spawnSync(["docker", ...args], { stderr: "pipe" });
	if (p.exitCode !== 0)
		throw new Error(`docker ${args[0]} failed: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
}

describe.skipIf(!hasImage)("database explorer on libSQL", () => {
	let h: Harness;
	let cookie: string;
	let id: string;
	const creds = libsqlCredentials();

	beforeAll(async () => {
		docker(
			"run",
			"-d",
			"--name",
			name,
			"--label",
			"logistack.test=dbx",
			"-e",
			`${LIBSQL_ENV.jwtKey}=${creds[LIBSQL_ENV.jwtKey]}`,
			"-p",
			"127.0.0.1::8080",
			IMAGE,
		);
		const [host, port] = (
			docker("port", name, "8080/tcp").split("\n")[0] ?? ""
		).split(":") as [string, string];
		for (let i = 0; ; i++)
			try {
				if ((await fetch(`http://${host}:${port}/health`)).ok) break;
			} catch (e) {
				if (i > 120) throw e;
			} finally {
				await Bun.sleep(250);
			}

		h = await startHarness({ area: "dbx", label: "dbx" });
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		const prj = await h.call("POST", "/api/projects", {
			headers: { cookie },
			body: { name: "Edge" },
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
					name: "edge",
					spec: {
						kind: "database",
						engine: "libsql",
						version: "0.24.33",
						credentialsRef: "env",
						resources: {},
					},
				},
			},
		);
		expect(created.status).toBe(201);
		id = created.json.id;
		// The service got its own key pair; point it at the container's instead.
		await h.deps.db.delete(envVar).where(eq(envVar.scopeId, id));
		await h.deps.db.insert(envVar).values({
			scope: "service",
			scopeId: id,
			key: LIBSQL_ENV.authToken,
			valueEncrypted: await encrypt(
				h.deps.masterKey,
				creds[LIBSQL_ENV.authToken] as string,
			),
		});
		h.deps.databaseEndpoint = () => ({ host, port: Number(port) });
	}, 120_000);

	afterAll(async () => {
		await h?.close();
		Bun.spawnSync(["docker", "rm", "-f", "-v", name]);
	});

	test("SQL, schema, rows and edits through the api", async () => {
		const q = await h.call("POST", `/api/databases/${id}/query`, {
			headers: { cookie },
			body: {
				sql: "CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO note (body) VALUES ('hello'), ('world')",
				readOnly: false,
			},
		});
		expect(q.status).toBe(200);
		expect(q.json.error).toBeNull();

		const schema = await h.call("GET", `/api/databases/${id}/schema`, {
			headers: { cookie },
		});
		expect(schema.status).toBe(200);
		expect(schema.json.engine).toBe("libsql");
		expect(schema.json.schemas[0].tables[0]).toMatchObject({
			name: "note",
			editable: true,
		});

		const write = await h.call(
			"POST",
			`/api/databases/${id}/tables/main/note/rows`,
			{
				headers: { cookie },
				body: {
					ops: [{ op: "update", key: { id: 2 }, values: { body: "mondo" } }],
				},
			},
		);
		expect(write.status).toBe(200);

		const rows = await h.call(
			"GET",
			`/api/databases/${id}/tables/main/note/rows?${new URLSearchParams({
				filter: JSON.stringify([
					{ column: "body", op: "contains", value: "on" },
				]),
			})}`,
			{ headers: { cookie } },
		);
		expect(rows.status).toBe(200);
		expect(rows.json.rows).toEqual([[2, "mondo"]]);
	});
});

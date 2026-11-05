import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readComposeFiles,
	readDokploy,
} from "../src/migration/dokploy/read.ts";
import {
	createDatabase,
	minimalSchema,
	startPostgres,
	upstreamSchema,
} from "./dokploy-schema.ts";
import { hasDocker } from "./harness.ts";

describe.skipIf(!hasDocker)("reading a Dokploy database", () => {
	let pg: Awaited<ReturnType<typeof startPostgres>>;
	beforeAll(async () => {
		pg = await startPostgres();
	}, 60_000);
	afterAll(() => pg?.stop());

	test("reads every row it needs, per engine and per mount owner", async () => {
		const url = await createDatabase(pg.url, "seeded");
		await minimalSchema(url);
		const sql = new Bun.SQL(url, { max: 1 });
		await sql`insert into project ("projectId", name, env) values ('p1', 'Shop', 'SHARED=1')`;
		await sql`insert into environment ("environmentId", "projectId", name) values ('e1', 'p1', 'production')`;
		await sql`insert into application ("applicationId", name, "appName", "environmentId", "sourceType", "buildType", "dockerImage", replicas, "placementSwarm", "autoDeploy")
			values ('a1', 'web', 'shop-web-abc123', 'e1', 'docker', 'nixpacks', 'nginx:1.27', 2, ${{ Constraints: ["node.role==manager"] }}, true)`;
		await sql`insert into postgres ("postgresId", name, "appName", "environmentId", "dockerImage", "databaseUser", "databasePassword", "databaseName", "externalPort")
			values ('pg1', 'db', 'shop-db-def456', 'e1', 'postgres:16', 'shop', 'fake-pg-secret', 'shop', 5432)`;
		await sql`insert into redis ("redisId", name, "appName", "environmentId", "dockerImage", password)
			values ('r1', 'cache', 'shop-cache-ghi789', 'e1', 'redis:7', 'fake-redis-secret')`;
		await sql`insert into mount ("mountId", type, "volumeName", "mountPath", "postgresId")
			values ('m1', 'volume', 'shop-db-def456-data', '/var/lib/postgresql/data', 'pg1')`;
		await sql`insert into port ("applicationId", "publishedPort", "targetPort", protocol, "publishMode")
			values ('a1', 8080, 80, 'tcp', 'ingress')`;
		await sql.close();

		const s = await readDokploy(url);
		expect(s.projects).toEqual([
			{ projectId: "p1", name: "Shop", env: "SHARED=1" },
		]);
		expect(s.applications[0]).toMatchObject({
			applicationId: "a1",
			replicas: 2,
			placementSwarm: { Constraints: ["node.role==manager"] },
			autoDeploy: true,
		});
		expect(
			s.databases.map((d) => [
				d.engine,
				d.id,
				d.databasePassword,
				d.databaseName,
			]),
		).toEqual([
			["postgres", "pg1", "fake-pg-secret", "shop"],
			["redis", "r1", "fake-redis-secret", null],
		]);
		expect(s.mounts).toEqual([
			expect.objectContaining({ mountId: "m1", ownerId: "pg1" }),
		]);
		expect(s.ports).toEqual([
			{
				applicationId: "a1",
				publishedPort: 8080,
				targetPort: 80,
				protocol: "tcp",
				publishMode: "ingress",
			},
		]);
	});

	test("refuses a schema that lacks a column, naming it", async () => {
		const url = await createDatabase(pg.url, "old");
		await minimalSchema(url, ["domain.stripPath", "mount.redisId"]);
		await expect(readDokploy(url)).rejects.toThrow(
			"unsupported Dokploy schema, missing domain.stripPath, mount.redisId",
		);
	});

	// Opt in with DOKPLOY_SRC=<a Dokploy checkout> (and DOKPLOY_REF, default v0.30.10).
	test.skipIf(!process.env.DOKPLOY_SRC)(
		"Dokploy's own schema has every column the reader needs",
		async () => {
			const url = await createDatabase(pg.url, "upstream");
			await upstreamSchema(
				url,
				process.env.DOKPLOY_SRC as string,
				process.env.DOKPLOY_REF ?? "v0.30.10",
			);
			expect(await readDokploy(url)).toMatchObject({ applications: [] });
		},
		120_000,
	);
});

test("git compose files are read from Dokploy's folder, never outside it", () => {
	const root = mkdtempSync(join(tmpdir(), "ls-test-dokread-"));
	try {
		mkdirSync(join(root, "blog-abc123", "code", "deploy"), { recursive: true });
		writeFileSync(
			join(root, "blog-abc123", "code", "deploy", "compose.yml"),
			"services: {}\n",
		);
		writeFileSync(join(root, "secret.yml"), "nope");
		const c = (
			composeId: string,
			composePath: string | null,
			sourceType = "github",
		) => ({
			composeId,
			appName: "blog-abc123",
			sourceType,
			composePath,
		});
		expect(
			readComposeFiles(
				[
					c("found", "./deploy/compose.yml"),
					c("escape", "../../secret.yml"),
					c("missing", null),
					c("raw", "./deploy/compose.yml", "raw"),
				],
				root,
			),
		).toEqual({ found: "services: {}\n" });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

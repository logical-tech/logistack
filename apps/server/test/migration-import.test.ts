import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { EventEnvelope } from "@logistack/contracts";
import { decrypt } from "@logistack/core";
import {
	adoptedVolume,
	backupPolicy,
	domain,
	envVar,
	gitProvider,
	migration,
	migrationBridge,
	migrationItem,
	notificationChannel,
	notificationRule,
	registry,
	s3Destination,
	service,
	sshKey,
} from "@logistack/db";
import { and, eq } from "drizzle-orm";
import { buildInventory } from "../src/migration/dokploy/inventory.ts";
import type { DokploySnapshot } from "../src/migration/dokploy/snapshot.ts";
import { planMigration, runImport } from "../src/migration/import.ts";
import { generateEd25519 } from "../src/ssh.ts";
import {
	app,
	compose,
	db,
	github,
	snapshot,
} from "./fixtures/dokploy-snapshot.ts";
import { type Harness, hasDocker, setupBody, startHarness } from "./harness.ts";

const volume = (ownerId: string, volumeName: string, mountPath: string) => ({
	mountId: `m-${ownerId}`,
	type: "volume" as const,
	hostPath: null,
	volumeName,
	filePath: null,
	content: null,
	mountPath,
	ownerId,
});

/** A Dokploy server with one of each thing the import handles, and two it cannot. */
const dokploy = (): DokploySnapshot =>
	snapshot({
		...github,
		registries: [
			{
				registryId: "reg",
				registryName: "GHCR",
				imagePrefix: "acme",
				username: "acme",
				password: "fake-reg-secret",
				registryUrl: "ghcr.io",
			},
		],
		destinations: [
			{
				destinationId: "r2",
				name: "R2",
				provider: "Cloudflare",
				accessKey: "AKIAFAKE",
				secretAccessKey: "fake-s3-secret",
				bucket: "backups",
				region: "auto",
				endpoint: "https://acc.r2.cloudflarestorage.com",
				additionalFlags: null,
			},
		],
		notifications: [
			{
				notificationId: "n1",
				name: "Ops Slack",
				notificationType: "slack",
				targetId: "sl1",
				appDeploy: true,
				appBuildError: true,
				databaseBackup: false,
				volumeBackup: false,
				dokployRestart: false,
				dokployBackup: false,
				dockerCleanup: false,
				serverThreshold: false,
			},
		],
		notificationTargets: [
			{
				type: "slack",
				targetId: "sl1",
				webhookUrl: "https://hooks.slack.com/services/fake",
				channel: null,
				username: null,
				botToken: null,
				chatId: null,
				messageThreadId: null,
				smtpServer: null,
				smtpPort: null,
				password: null,
				fromAddress: null,
				toAddress: null,
				apiKey: null,
				serverUrl: null,
				appToken: null,
				topic: null,
				accessToken: null,
				endpoint: null,
				userKey: null,
				apiToken: null,
			},
		],
		sshKeys: [
			{
				sshKeyId: "k1",
				name: "deploy",
				privateKey: generateEd25519("deploy").privateKey,
			},
		],
		databases: [
			db({
				id: "pg",
				engine: "postgres",
				dockerImage: "postgres:16",
				databaseUser: "shop",
				databasePassword: "fake-pg-secret",
				databaseName: "shop",
			}),
			db({
				id: "vec",
				engine: "postgres",
				dockerImage: "pgvector/pgvector:pg16",
			}),
		],
		mounts: [
			volume("pg", "pg-def456-data", "/var/lib/postgresql/data"),
			volume("bad", "ls-not-adoptable", "/data"),
		],
		backups: [
			{
				backupId: "b1",
				schedule: "0 3 * * *",
				enabled: true,
				database: "shop",
				prefix: "/",
				destinationId: "r2",
				keepLatestCount: 5,
				backupType: "database",
				ownerId: "pg",
			},
		],
		applications: [
			app({
				applicationId: "web",
				env: "DATABASE_URL=postgres://shop:x@pg-def456:5432/shop",
			}),
			app({
				applicationId: "api",
				sourceType: "github",
				buildType: "dockerfile",
				owner: "acme",
				repository: "api",
				branch: "main",
				buildPath: "/",
				githubId: "gh1",
			}),
			app({ applicationId: "bad" }),
		],
		ports: [
			{
				applicationId: "web",
				publishedPort: 8080,
				targetPort: 80,
				protocol: "tcp",
				publishMode: "ingress",
			},
		],
		domains: [
			{
				domainId: "d1",
				host: "shop.example.com",
				https: true,
				port: 80,
				path: "/",
				internalPath: "/",
				stripPath: false,
				serviceName: null,
				domainType: "application",
				certificateType: "letsencrypt",
				applicationId: "web",
				composeId: null,
			},
		],
		security: [
			{ applicationId: "web", username: "admin", password: "fake-basic" },
		],
		composes: [
			compose({
				composeId: "blog",
				composeFile:
					"services:\n  app:\n    image: ghost:5\n    depends_on: [cache]\n  cache:\n    image: redis:7\n",
			}),
		],
	});

describe.skipIf(!hasDocker)("importing a Dokploy migration", () => {
	let h: Harness;
	let orgId: string;
	let migrationId: string;

	const items = async () =>
		Object.fromEntries(
			(
				await h.deps.db
					.select()
					.from(migrationItem)
					.where(eq(migrationItem.migrationId, migrationId))
			).map((r) => [`${r.kind}:${r.sourceId}`, r]),
		);
	const counts = async () => ({
		services: (await h.deps.db.select().from(service)).length,
		domains: (await h.deps.db.select().from(domain)).length,
		policies: (await h.deps.db.select().from(backupPolicy)).length,
		destinations: (await h.deps.db.select().from(s3Destination)).length,
		registries: (await h.deps.db.select().from(registry)).length,
		channels: (await h.deps.db.select().from(notificationChannel)).length,
		rules: (await h.deps.db.select().from(notificationRule)).length,
		keys: (await h.deps.db.select().from(sshKey)).length,
		providers: (await h.deps.db.select().from(gitProvider)).length,
		adopted: (await h.deps.db.select().from(adoptedVolume)).length,
	});

	beforeAll(async () => {
		h = await startHarness({ area: "migimport", label: "migimport" });
		orgId = (await h.call("POST", "/api/setup", { body: setupBody })).json
			.organizationId;
		migrationId = await planMigration(
			h.deps,
			orgId,
			"dokploy",
			buildInventory(dokploy()),
		);
	}, 60_000);
	afterAll(() => h?.close());

	test("planning stores every item, encrypted, unsupported ones skipped", async () => {
		const all = await items();
		expect(Object.keys(all).sort()).toEqual([
			"application:api",
			"application:bad",
			"application:web",
			"compose:blog",
			"gitProvider:gh1",
			"notificationChannel:n1",
			"postgres:pg",
			"postgres:vec",
			"registry:reg",
			"s3Destination:r2",
			"sshKey:k1",
		]);
		expect(all["postgres:vec"]?.status).toBe("skipped");
		expect(JSON.stringify(all)).not.toContain("fake-pg-secret");
	});

	test("the import creates everything through the routes, without deploying", async () => {
		const events: EventEnvelope[] = [];
		const stop = h.deps.bus.onEvent((e) => {
			if (e.type === "migration.item_changed") events.push(e);
		});
		await runImport(h.deps, migrationId);
		// Redis delivers asynchronously.
		for (let i = 0; i < 50 && events.length < 10; i++) await Bun.sleep(50);
		stop();
		const all = await items();
		// One event per item the import moved, on the migration's channel, naming its new status.
		expect(
			events
				.map(
					(e) => `${e.payload.kind}:${e.payload.sourceId}=${e.payload.status}`,
				)
				.sort(),
		).toEqual(
			Object.entries(all)
				.filter(([, r]) => r.status !== "skipped")
				.map(([k, r]) => `${k}=${r.status}`)
				.sort(),
		);
		expect(events.every((e) => e.resource.id === migrationId)).toBe(true);
		expect(
			events.find((e) => e.payload.status === "failed")?.payload.error,
		).toContain("a LogiStack volume cannot be adopted");
		const status = Object.fromEntries(
			Object.entries(all).map(([k, r]) => [k, r.status]),
		);
		expect(status).toMatchObject({
			"registry:reg": "imported",
			"s3Destination:r2": "imported",
			"notificationChannel:n1": "imported",
			"sshKey:k1": "imported",
			"gitProvider:gh1": "imported",
			"postgres:pg": "imported",
			"application:web": "imported",
			"application:api": "imported",
			"compose:blog": "imported",
			"postgres:vec": "skipped",
			"application:bad": "failed",
		});
		expect(all["application:bad"]?.lastError).toContain(
			"a LogiStack volume cannot be adopted",
		);
		const [mig] = await h.deps.db
			.select()
			.from(migration)
			.where(eq(migration.id, migrationId));
		expect(mig?.status).toBe("imported");

		// Dokploy's hostnames, so existing connection strings keep resolving.
		const pg = all["postgres:pg"]?.targets["pg-def456"] as string;
		const [pgRow] = await h.deps.db
			.select()
			.from(service)
			.where(eq(service.id, pg));
		expect(pgRow).toMatchObject({
			slug: "pg-def456",
			importedFrom: "dokploy:pg-def456",
		});
		expect(Object.keys(all["compose:blog"]?.targets ?? {}).sort()).toEqual([
			"app",
			"cache",
		]);

		// Each service keeps answering on Dokploy's network under its old name until removal;
		// compose services carry routers for its Traefik.
		const bridges = await h.deps.db
			.select()
			.from(migrationBridge)
			.where(eq(migrationBridge.migrationId, migrationId));
		expect(bridges.find((b) => b.serviceId === pg)).toMatchObject({
			aliases: ["pg-def456"],
			routes: false,
		});
		expect(
			bridges.find((b) => b.serviceId === all["compose:blog"]?.targets.app),
		).toMatchObject({ aliases: ["app"], routes: true });

		// The database opens with Dokploy's credentials, not the minted ones.
		const vars = await h.deps.db
			.select()
			.from(envVar)
			.where(and(eq(envVar.scope, "service"), eq(envVar.scopeId, pg)));
		const env = Object.fromEntries(
			await Promise.all(
				vars.map(async (v) => [
					v.key,
					await decrypt(h.deps.masterKey, v.valueEncrypted),
				]),
			),
		);
		expect(env).toMatchObject({
			POSTGRES_USER: "shop",
			POSTGRES_PASSWORD: "fake-pg-secret",
			POSTGRES_DB: "shop",
		});

		const [policy] = await h.deps.db
			.select()
			.from(backupPolicy)
			.where(eq(backupPolicy.serviceId, pg));
		expect(policy).toMatchObject({
			s3DestinationId: all["s3Destination:r2"]?.targets.id,
			cron: "0 3 * * *",
			retention: { count: 5 },
		});

		const api = all["application:api"]?.targets["api-abc123"] as string;
		const [apiRow] = await h.deps.db
			.select()
			.from(service)
			.where(eq(service.id, api));
		expect(apiRow?.spec).toMatchObject({
			source: { gitProviderId: all["gitProvider:gh1"]?.targets.id },
		});
		expect(await h.deps.db.select().from(notificationRule)).toEqual([
			expect.objectContaining({
				channelId: all["notificationChannel:n1"]?.targets.id,
				events: ["deployment.succeeded", "deployment.failed"],
			}),
		]);
		expect(await counts()).toMatchObject({
			domains: 1,
			adopted: 1,
			services: 5,
		});
	});

	test("running it again after a crash creates nothing twice", async () => {
		const before = await counts();
		// As if the api died after creating everything but before marking any item.
		await h.deps.db
			.update(migrationItem)
			.set({ status: "planned" })
			.where(
				and(
					eq(migrationItem.migrationId, migrationId),
					eq(migrationItem.status, "imported"),
				),
			);
		await runImport(h.deps, migrationId);
		expect(await counts()).toEqual(before);
		const status = Object.values(await items()).map((r) => r.status);
		expect(status.filter((s) => s === "imported")).toHaveLength(9);
	});
});

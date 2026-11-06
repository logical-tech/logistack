import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { backupSchedulerId } from "@logistack/contracts";
import {
	auditLog,
	backupPolicy,
	backupRun,
	deployment,
	envVar,
	service,
} from "@logistack/db";
import { and, eq } from "drizzle-orm";
import { runQueues } from "../src/run-queues.ts";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const dbSpec = {
	kind: "database",
	engine: "postgres",
	version: "17-alpine",
	credentialsRef: "test",
	resources: {},
};
const appSpec = {
	kind: "application",
	source: { type: "image", image: "nginx:1.27" },
	build: { type: "image" },
	ports: [{ target: 80, protocol: "tcp" }],
	replicas: 1,
	resources: {},
	placement: [],
};
const minio = {
	endpoint: "https://s3.eu-central-1.amazonaws.com",
	bucket: "acme-backups",
	accessKeyId: "AKIAEXAMPLE",
	secretAccessKey: "very-secret-key",
};

describe.skipIf(!hasDocker)("backups and schedules API", () => {
	let h: Harness;
	let ownerCookie: string;
	const cookies: Record<string, string> = {};
	let envId: string;
	let dbId: string;
	let appId: string;
	let destinationId: string;
	let policyId: string;
	const as = (who: string) => ({
		headers: { cookie: who === "owner" ? ownerCookie : (cookies[who] ?? "") },
	});
	const queues = () => runQueues(h.config.REDIS_URL);

	async function member(role: "viewer" | "developer") {
		const user = {
			name: role,
			email: `${role}@example.com`,
			password: `${role} password 12`,
		};
		const invite = await h.call("POST", "/api/invitations", {
			...as("owner"),
			body: { email: user.email, role },
		});
		expect(invite.status).toBe(201);
		await h.call("POST", "/api/auth/sign-up/email", { body: user });
		cookies[role] = await h.signIn(user.email, user.password);
		await h.call("POST", "/api/auth/organization/accept-invitation", {
			...as(role),
			body: { invitationId: invite.json.id },
		});
	}

	const audited = async (action: string) =>
		h.deps.db
			.select({ outcome: auditLog.outcome, resourceId: auditLog.resourceId })
			.from(auditLog)
			.where(eq(auditLog.action, action));

	beforeAll(async () => {
		h = await startHarness({ area: "backup", label: "backup" });
		await h.call("POST", "/api/setup", { body: setupBody });
		ownerCookie = await h.signIn(owner.email, owner.password);
		await member("viewer");
		await member("developer");
		const prj = await h.call("POST", "/api/projects", {
			...as("owner"),
			body: { name: "Shop" },
		});
		envId = (
			await h.call(
				"GET",
				`/api/projects/${prj.json.id}/environments`,
				as("owner"),
			)
		).json[0].id;
		const svc = (name: string, spec: unknown) =>
			h.call("POST", `/api/environments/${envId}/services`, {
				...as("owner"),
				body: { name, spec },
			});
		dbId = (await svc("orders-db", dbSpec)).json.id;
		appId = (await svc("web", appSpec)).json.id;
		// Pin the minted password to a known value; the restore copy must carry it over.
		await h.deps.db
			.update(envVar)
			.set({ valueEncrypted: "v1:x:y" })
			.where(
				and(eq(envVar.scopeId, dbId), eq(envVar.key, "POSTGRES_PASSWORD")),
			);
	}, 90_000);
	afterAll(async () => {
		await h?.close();
	});

	test("the S3 test refuses a private endpoint unless the instance allows it", async () => {
		const r = await h.call("POST", "/api/s3-destinations/test", {
			...as("owner"),
			body: { ...minio, endpoint: "http://127.0.0.1:9000" },
		});
		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({
			ok: false,
			message: "Endpoint not allowed",
		});
		expect(r.json.detail).toContain("https");
	});

	test("destinations: admins create, viewers cannot, secrets never come back", async () => {
		const denied = await h.call("POST", "/api/s3-destinations", {
			...as("viewer"),
			body: { name: "S3", ...minio },
		});
		expect(denied.status).toBe(403);
		const created = await h.call("POST", "/api/s3-destinations", {
			...as("owner"),
			body: { name: "AWS eu-central-1", prefix: "/prod", ...minio },
		});
		expect(created.status).toBe(201);
		destinationId = created.json.id;
		const list = await h.call("GET", "/api/s3-destinations", as("viewer"));
		expect(list.json).toEqual([
			expect.objectContaining({
				id: destinationId,
				prefix: "prod",
				region: "us-east-1",
				usedBy: 0,
			}),
		]);
		expect(JSON.stringify(list.json)).not.toContain("very-secret-key");
		const rows = await audited("s3_destination.create");
		expect(rows.map((r) => r.outcome).sort()).toEqual(["denied", "success"]);
		const [diff] = await h.deps.db
			.select({ diff: auditLog.diff })
			.from(auditLog)
			.where(
				and(
					eq(auditLog.action, "s3_destination.create"),
					eq(auditLog.outcome, "success"),
				),
			);
		expect(JSON.stringify(diff)).not.toContain("very-secret-key");
	});

	test("policies validate their target and register Job Schedulers", async () => {
		const bad = await h.call("POST", `/api/services/${appId}/backup-policies`, {
			...as("owner"),
			body: {
				target: "database",
				s3DestinationId: destinationId,
				cron: "0 3 * * *",
			},
		});
		expect(bad.status).toBe(400);
		const badCron = await h.call(
			"POST",
			`/api/services/${dbId}/backup-policies`,
			{
				...as("owner"),
				body: {
					target: "database",
					s3DestinationId: destinationId,
					cron: "every day",
				},
			},
		);
		expect(badCron.status).toBe(400);
		const byViewer = await h.call(
			"POST",
			`/api/services/${dbId}/backup-policies`,
			{
				...as("viewer"),
				body: {
					target: "database",
					s3DestinationId: destinationId,
					cron: "0 3 * * *",
				},
			},
		);
		expect(byViewer.status).toBe(403);

		const p = await h.call("POST", `/api/services/${dbId}/backup-policies`, {
			...as("developer"),
			body: {
				target: "database",
				s3DestinationId: destinationId,
				cron: "0 3 * * *",
				timezone: "Europe/Rome",
				retention: { count: 7, days: 30 },
				verifyCron: "0 5 * * 0",
			},
		});
		expect(p.status).toBe(201);
		policyId = p.json.id;
		expect(p.json).toMatchObject({
			destinationName: "AWS eu-central-1",
			lastRun: null,
			retention: { count: 7, days: 30 },
		});
		// 03:00 in Rome is 02:00 UTC in November.
		expect(p.json.nextRunAt).toMatch(/T02:00:00\.000Z$/);
		const js = await queues().backup.getJobScheduler(
			backupSchedulerId(policyId, "backup"),
		);
		expect(js).toMatchObject({ pattern: "0 3 * * *", tz: "Europe/Rome" });
		expect(
			await queues().backup.getJobScheduler(
				backupSchedulerId(policyId, "verify"),
			),
		).toMatchObject({ pattern: "0 5 * * 0" });

		const volumes = (
			await h.call("GET", `/api/services/${dbId}/backups`, as("viewer"))
		).json.volumes;
		expect(volumes).toEqual([
			{ id: dbId, label: "Database data directory", kind: "data" },
		]);

		const off = await h.call("PATCH", `/api/backup-policies/${policyId}`, {
			...as("owner"),
			body: { verifyCron: null },
		});
		expect(off.status).toBe(200);
		// Fields the patch left out keep their values.
		expect(off.json).toMatchObject({
			timezone: "Europe/Rome",
			retention: { count: 7, days: 30 },
			encrypted: false,
			encryptionKey: null,
		});
		expect(
			await queues().backup.getJobScheduler(
				backupSchedulerId(policyId, "verify"),
			),
		).toBeUndefined();
	});

	test("encryption: the key comes back once, sealed at rest, and cannot be turned off", async () => {
		const p = await h.call("POST", `/api/services/${dbId}/backup-policies`, {
			...as("developer"),
			body: {
				target: "database",
				s3DestinationId: destinationId,
				cron: "0 4 * * *",
				encrypt: true,
			},
		});
		expect(p.status).toBe(201);
		expect(p.json.encrypted).toBe(true);
		expect(p.json.encryptionKey).toMatch(/^AGE-SECRET-KEY-1[0-9A-Z]{58}$/);
		const [row] = await h.deps.db
			.select({ sealed: backupPolicy.encryptionKeyEncrypted })
			.from(backupPolicy)
			.where(eq(backupPolicy.id, p.json.id));
		expect(row?.sealed).toBeString();
		expect(row?.sealed).not.toContain(p.json.encryptionKey);
		const listed = (
			await h.call("GET", `/api/services/${dbId}/backups`, as("owner"))
		).json.policies.find((x: { id: string }) => x.id === p.json.id);
		expect(listed).toMatchObject({ encrypted: true });
		expect(JSON.stringify(listed)).not.toContain("AGE-SECRET-KEY");

		const again = await h.call("PATCH", `/api/backup-policies/${p.json.id}`, {
			...as("owner"),
			body: { cron: "0 6 * * *" },
		});
		expect(again.json).toMatchObject({ encrypted: true, encryptionKey: null });
		// No encrypted backup exists yet, so a lost key is recoverable: re-key.
		expect(listed.hasEncryptedBackup).toBe(false);
		const rekeyed = await h.call("PATCH", `/api/backup-policies/${p.json.id}`, {
			...as("owner"),
			body: { encrypt: true },
		});
		expect(rekeyed.json.encryptionKey).toMatch(/^AGE-SECRET-KEY-1/);
		expect(rekeyed.json.encryptionKey).not.toBe(p.json.encryptionKey);
		const [resealed] = await h.deps.db
			.select({ sealed: backupPolicy.encryptionKeyEncrypted })
			.from(backupPolicy)
			.where(eq(backupPolicy.id, p.json.id));
		expect(resealed?.sealed).not.toBe(row?.sealed);

		// Two enables at once: whichever reads the key after the other wrote it may re-key (no
		// encrypted backup yet), so two 200s are fine; what can never happen is a lost update,
		// so anything else is a 409.
		const race = await Promise.all(
			[1, 2].map(() =>
				h.call("PATCH", `/api/backup-policies/${policyId}`, {
					...as("owner"),
					body: { encrypt: true },
				}),
			),
		);
		expect(race.some((r) => r.status === 200)).toBe(true);
		expect(race.every((r) => r.status === 200 || r.status === 409)).toBe(true);
		const unlock = await h.call("PATCH", `/api/backup-policies/${policyId}`, {
			...as("owner"),
			body: { encrypt: false },
		});
		expect(unlock.status).toBe(200);
		expect(unlock.json.encrypted).toBe(false);

		// Once an encrypted backup exists the key is the only way back to it.
		await h.deps.db.insert(backupRun).values({
			id: "bkr_enc",
			policyId: p.json.id,
			kind: "backup",
			status: "succeeded",
			objectKey: "backups/x.dump.age",
		});
		const locked = await h.call("PATCH", `/api/backup-policies/${p.json.id}`, {
			...as("owner"),
			body: { encrypt: false },
		});
		expect(locked.status).toBe(400);
		expect(locked.json.error.message).toContain("encrypted backup");
		const keep = await h.call("PATCH", `/api/backup-policies/${p.json.id}`, {
			...as("owner"),
			body: { encrypt: true },
		});
		expect(keep.json).toMatchObject({
			encrypted: true,
			hasEncryptedBackup: true,
			encryptionKey: null,
		});

		const on = await h.call("PATCH", `/api/backup-policies/${policyId}`, {
			...as("owner"),
			body: { encrypt: true },
		});
		expect(on.json.encryptionKey).toMatch(/^AGE-SECRET-KEY-1/);
		expect(on.json.encryptionKey).not.toBe(p.json.encryptionKey);
		await h.call("DELETE", `/api/backup-policies/${p.json.id}`, as("owner"));
	});

	test("a destination in use cannot be deleted", async () => {
		const r = await h.call(
			"DELETE",
			`/api/s3-destinations/${destinationId}`,
			as("owner"),
		);
		expect(r.status).toBe(409);
		expect(r.json.error.message).toContain("1 backup policy writes here");
		expect((await audited("s3_destination.delete"))[0]).toMatchObject({
			outcome: "error",
			resourceId: destinationId,
		});
	});

	test("run now queues a job under the run's own id", async () => {
		const viewer = await h.call(
			"POST",
			`/api/backup-policies/${policyId}/run`,
			{
				...as("viewer"),
				body: {},
			},
		);
		expect(viewer.status).toBe(403);
		const r = await h.call("POST", `/api/backup-policies/${policyId}/run`, {
			...as("developer"),
			body: {},
		});
		expect(r.status).toBe(202);
		expect(r.json).toMatchObject({ kind: "backup", status: "running" });
		const job = await queues().backup.getJob(r.json.id);
		expect(job?.data).toEqual({ policyId, kind: "backup", runId: r.json.id });
	});

	test("restore into a new service copies engine and credentials and queues a deploy", async () => {
		const [{ id: runId }] = (
			await h.call("GET", `/api/services/${dbId}/backups`, as("owner"))
		).json.runs;
		const notYet = await h.call("POST", `/api/backup-runs/${runId}/restore`, {
			...as("owner"),
			body: { target: { kind: "same" }, confirm: "orders-db" },
		});
		expect(notYet.status).toBe(400);
		expect(notYet.json.error.message).toContain("finished backup");

		await h.deps.db
			.update(backupRun)
			.set({ status: "succeeded", objectKey: "backups/x.dump" })
			.where(eq(backupRun.id, runId));
		const wrong = await h.call("POST", `/api/backup-runs/${runId}/restore`, {
			...as("owner"),
			body: { target: { kind: "same" }, confirm: "orders" },
		});
		expect(wrong.status).toBe(400);
		const ok = await h.call("POST", `/api/backup-runs/${runId}/restore`, {
			...as("developer"),
			body: {
				target: { kind: "new", name: "orders-copy" },
				confirm: "orders-copy",
			},
		});
		expect(ok.status).toBe(202);
		const [copy] = await h.deps.db
			.select()
			.from(service)
			.where(eq(service.id, ok.json.targetServiceId));
		expect(copy).toMatchObject({
			name: "orders-copy",
			environmentId: envId,
			spec: dbSpec,
		});
		const vars = await h.deps.db
			.select()
			.from(envVar)
			.where(eq(envVar.scopeId, ok.json.targetServiceId));
		expect(vars.map((v) => [v.key, v.valueEncrypted])).toEqual([
			["POSTGRES_PASSWORD", "v1:x:y"],
		]);
		expect(
			await h.deps.db.$count(
				deployment,
				eq(deployment.serviceId, copy?.id ?? ""),
			),
		).toBe(1);
		const job = await queues().backup.getJob(ok.json.run.id);
		expect(job?.data).toMatchObject({
			kind: "restore",
			sourceRunId: runId,
			targetServiceId: copy?.id,
		});
		expect(
			(await audited("backup_run.restore")).map((r) => r.outcome).sort(),
		).toEqual(["error", "error", "success"]);
	});

	test("schedules: CRUD, host targets need admin, disable drops the scheduler", async () => {
		const base = {
			name: "nightly report",
			cron: "15 2 * * *",
			timezone: "Europe/Rome",
			script: "echo hi",
		};
		expect(
			(await h.call("POST", "/api/schedules", { ...as("viewer"), body: base }))
				.status,
		).toBe(403);
		const nodes = await h.call("GET", "/api/nodes", as("owner"));
		const host = await h.call("POST", "/api/schedules", {
			...as("developer"),
			body: {
				...base,
				target: { kind: "host", nodeId: nodes.json[0]?.id ?? "nod_x" },
			},
		});
		expect(host.status).toBe(403);

		const created = await h.call("POST", "/api/schedules", {
			...as("developer"),
			body: base,
		});
		expect(created.status).toBe(201);
		const id = created.json.id;
		expect(created.json).toMatchObject({
			target: { kind: "ephemeral", image: "alpine:3.22" },
			concurrency: "forbid",
			timeoutS: 3600,
		});
		expect(await queues().schedule.getJobScheduler(id)).toMatchObject({
			pattern: "15 2 * * *",
			tz: "Europe/Rome",
		});
		const preview = await h.call(
			"GET",
			"/api/schedules/preview?cron=*/15%20*%20*%20*%20*&timezone=UTC",
			as("viewer"),
		);
		expect(preview.json.next).toHaveLength(5);
		expect(
			new Date(preview.json.next[1]).getTime() -
				new Date(preview.json.next[0]).getTime(),
		).toBe(15 * 60_000);

		const off = await h.call("PATCH", `/api/schedules/${id}`, {
			...as("developer"),
			body: { enabled: false },
		});
		expect(off.json).toMatchObject({ enabled: false, nextRunAt: null });
		expect(await queues().schedule.getJobScheduler(id)).toBeUndefined();

		const run = await h.call(
			"POST",
			`/api/schedules/${id}/run`,
			as("developer"),
		);
		expect(run.status).toBe(202);
		expect(run.json).toMatchObject({ trigger: "manual", status: "running" });
		const detail = await h.call(
			"GET",
			`/api/schedule-runs/${run.json.id}`,
			as("viewer"),
		);
		expect(detail.json).toMatchObject({
			output: null,
			outputLimitBytes: 1048576,
		});
		const got = await h.call("GET", `/api/schedules/${id}`, as("viewer"));
		expect(got.json.runs.map((r: { id: string }) => r.id)).toEqual([
			run.json.id,
		]);

		expect(
			(await h.call("DELETE", `/api/schedules/${id}`, as("viewer"))).status,
		).toBe(403);
		expect(
			(await h.call("DELETE", `/api/schedules/${id}`, as("developer"))).status,
		).toBe(204);
		expect(
			(await h.call("GET", `/api/schedules/${id}`, as("owner"))).status,
		).toBe(404);
		for (const action of [
			"schedule.create",
			"schedule.update",
			"schedule.run",
			"schedule.delete",
		])
			expect((await audited(action)).some((r) => r.outcome === "success")).toBe(
				true,
			);
	});

	test("deleting the policy frees the destination", async () => {
		expect(
			(
				await h.call(
					"DELETE",
					`/api/backup-policies/${policyId}`,
					as("developer"),
				)
			).status,
		).toBe(204);
		expect(
			await queues().backup.getJobScheduler(
				backupSchedulerId(policyId, "backup"),
			),
		).toBeUndefined();
		expect(
			(
				await h.call(
					"DELETE",
					`/api/s3-destinations/${destinationId}`,
					as("owner"),
				)
			).status,
		).toBe(204);
	});
});

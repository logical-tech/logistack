import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { imageScan, imageVulnerability, serviceImage } from "@logistack/db";
import { closeRunQueues, runQueues } from "../src/run-queues.ts";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

describe.skipIf(!hasDocker)("vulnerabilities api", () => {
	let h: Harness;
	let cookie: string;
	let a = "";
	let b = "";
	const as = () => ({ headers: { cookie } });

	beforeAll(async () => {
		h = await startHarness({ area: "vulnscan-api", label: "vulnscan-api" });
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		const projectId = (
			await h.call("POST", "/api/projects", { ...as(), body: { name: "V" } })
		).json.id;
		const envId = (
			await h.call("GET", `/api/projects/${projectId}/environments`, as())
		).json[0].id;
		const create = async (name: string) =>
			(
				await h.call("POST", `/api/environments/${envId}/services`, {
					...as(),
					body: {
						name,
						resourceProfile: null,
						spec: {
							kind: "application",
							source: { type: "image", image: "alpine:3.10.0" },
							build: { type: "image" },
							ports: [],
							replicas: 1,
							resources: {},
							placement: [],
						},
					},
				})
			).json.id as string;
		a = await create("a");
		b = await create("b");
	}, 120_000);
	afterAll(async () => {
		await closeRunQueues();
		await h?.close();
	});

	test("before a scan every field is empty", async () => {
		const got = await h.call("GET", `/api/services/${a}/vulnerabilities`, as());
		expect(got.status).toBe(200);
		expect(got.json).toMatchObject({ badge: null, image: null, findings: [] });
	});

	test("services on one digest share its findings, worst first", async () => {
		const { db } = h.deps;
		const digest = "sha256:abc";
		await db.insert(imageScan).values({
			digest,
			image: "alpine:3.10.0",
			status: "succeeded",
			counts: { critical: 1, high: 0, medium: 0, low: 1, unknown: 0 },
			scannedAt: new Date(),
		});
		await db.insert(imageVulnerability).values([
			{
				digest,
				vulnerabilityId: "CVE-2",
				pkgName: "zlib",
				installedVersion: "1",
				severity: "low",
			},
			{
				digest,
				vulnerabilityId: "CVE-1",
				pkgName: "musl",
				installedVersion: "1.1.22-r2",
				fixedVersion: "1.1.22-r3",
				severity: "critical",
			},
		]);
		await db.insert(serviceImage).values([
			{ serviceId: a, image: "alpine:3.10.0", digest },
			{ serviceId: b, image: "alpine:3.10.0", digest },
		]);
		for (const id of [a, b]) {
			const got = await h.call(
				"GET",
				`/api/services/${id}/vulnerabilities`,
				as(),
			);
			expect(got.json.badge).toBe("critical");
			expect(got.json.findings.map((f: { id: string }) => f.id)).toEqual([
				"CVE-1",
				"CVE-2",
			]);
			expect(got.json.findings[0]).toMatchObject({
				pkgName: "musl",
				installedVersion: "1.1.22-r2",
				fixedVersion: "1.1.22-r3",
			});
		}
	});

	test("a rescan queues a forced job for the worker", async () => {
		const got = await h.call(
			"POST",
			`/api/services/${a}/vulnerabilities/scan`,
			as(),
		);
		expect(got.status).toBe(202);
		const jobs = await runQueues(h.config.REDIS_URL).scan.getJobs([
			"waiting",
			"delayed",
		]);
		expect(jobs.map((j) => j.data)).toContainEqual({
			serviceId: a,
			force: true,
		});
	});
});

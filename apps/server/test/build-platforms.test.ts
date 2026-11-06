import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { instanceSettings, node } from "@logistack/db";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

describe.skipIf(!hasDocker)("build platforms", () => {
	let h: Harness;
	let cookie: string;
	const as = () => ({ headers: { cookie } });

	beforeAll(async () => {
		h = await startHarness({ area: "march", label: "march" });
		const orgId = (await h.call("POST", "/api/setup", { body: setupBody })).json
			.organizationId;
		cookie = await h.signIn(owner.email, owner.password);
		await h.deps.db.insert(node).values(
			(["x86_64", "aarch64"] as const).map((architecture) => ({
				organizationId: orgId,
				swarmNodeId: `swarm-${architecture}`,
				hostname: architecture,
				address: "10.0.0.1",
				role: "worker" as const,
				facts: { architecture },
			})),
		);
		await h.deps.db.update(instanceSettings).set({
			buildkit: {
				platforms: ["linux/amd64", "linux/amd64/v2"],
				checkedAt: "2026-11-06T00:00:00.000Z",
				error: null,
				emulation: null,
			},
		});
	}, 60_000);
	afterAll(async () => {
		await h?.close();
	});

	test("the swarm's architectures come from node facts; missing ones from BuildKit's probe", async () => {
		const r = await h.call("GET", "/api/build-platforms", as());
		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({
			swarm: ["linux/amd64", "linux/arm64"],
			missing: ["linux/arm64"],
		});
	});

	test("the setup is queued once: a second request while it runs is a conflict", async () => {
		const first = await h.call("POST", "/api/build-platforms/emulation", as());
		expect(first.status).toBe(202);
		expect(first.json.buildkit.emulation.state).toBe("installing");
		const again = await h.call("POST", "/api/build-platforms/emulation", as());
		expect(again.status).toBe(409);
	});
});

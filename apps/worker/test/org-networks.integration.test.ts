import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { orgNetworkName } from "@logistack/core";
import { createDockerClient } from "@logistack/docker";
import {
	ensureOrgIngressNetwork,
	reattachOrgNetworks,
	sharedNetworkMoves,
} from "../src/apply.ts";
import { loadConfig } from "../src/config.ts";
import type { Ctx } from "../src/ctx.ts";
import { hasDocker, sh } from "./harness.ts";

/** Every object here is named `ls-test-orgnet-*` and labelled `logistack.test=orgnet`; cleanup removes exactly these. */
const P = "ls-test-orgnet-";
const LABEL = "logistack.test=orgnet";
const SHARED = `${P}ingress`;
const CADDY = `${P}caddy`;
const APP = `${P}app`;
const ORG = "orgNetTestA";

const docker = createDockerClient();
const cfg = loadConfig({
	DATABASE_URL: "postgres://unused",
	REDIS_URL: "redis://unused",
	LOGISTACK_MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
	LS_NAME_PREFIX: P,
	LS_SCOPE_LABELS: JSON.stringify({ "logistack.test": "orgnet" }),
	LS_INGRESS_NETWORK: SHARED,
	LS_STORAGE_NETWORK: `${P}storage`,
	LS_GAME_NETWORK: `${P}game`,
	LS_CADDY_SERVICE: CADDY,
	LS_STACK_NAME: `${P}stack`,
});
const ctx = { docker, cfg } as unknown as Ctx;
const own = orgNetworkName("ingress", ORG, P);

const run = (...argv: string[]) =>
	Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
function cleanup() {
	for (const s of [APP, CADDY]) run("docker", "service", "rm", s);
	// Tasks must stop before their networks can go.
	for (let i = 0; i < 30; i++) {
		if (!run("docker", "ps", "-q", "--filter", `label=${LABEL}`).stdout.length)
			break;
		Bun.sleepSync(1000);
	}
	for (const n of [own, SHARED]) run("docker", "network", "rm", n);
}

const networksOf = async (name: string) => {
	const svc = await docker.services.inspect(name);
	const ids = (svc.Spec.TaskTemplate.Networks ?? []).map((n) => n.Target);
	const names = await Promise.all(
		ids.map(async (id) => (await docker.networks.inspect(id)).Name),
	);
	return names.sort();
};

const service = (name: string) =>
	sh(
		"docker",
		"service",
		"create",
		"-d",
		"--name",
		name,
		"--label",
		LABEL,
		"--container-label",
		LABEL,
		"--network",
		SHARED,
		"alpine:3.22",
		"sleep",
		"3600",
	);

describe.skipIf(!hasDocker)("per-organization networks on a real Swarm", () => {
	beforeAll(() => {
		cleanup();
		sh(
			"docker",
			"network",
			"create",
			"--driver",
			"overlay",
			"--attachable",
			"--label",
			LABEL,
			SHARED,
		);
		service(CADDY);
		service(APP);
	}, 120_000);
	afterAll(cleanup, 120_000);

	test("the organization's ingress network exists and the proxy joins it", async () => {
		const id = await ensureOrgIngressNetwork(ctx, ORG);
		expect(id).toBe((await docker.networks.inspect(own)).Id);
		expect(await networksOf(CADDY)).toEqual([SHARED, own].sort());
		// Idempotent: no second attachment, no rollout.
		expect(await ensureOrgIngressNetwork(ctx, ORG)).toBe(id);
		expect(await networksOf(CADDY)).toEqual([SHARED, own].sort());
	}, 120_000);

	test("a live service on the shared network is told where to move", async () => {
		const svc = await docker.services.inspect(APP);
		const targets = (svc.Spec.TaskTemplate.Networks ?? []).map((n) => n.Target);
		const moves = await sharedNetworkMoves(ctx, ORG, targets);
		const to = (await docker.networks.inspect(own)).Id;
		expect(moves.get(targets[0] as string)).toBe(to);
		// Already on its own network: nothing to move.
		expect((await sharedNetworkMoves(ctx, ORG, [to])).size).toBe(0);
	}, 120_000);

	test("after a stack redeploy drops it, boot attaches the proxy again", async () => {
		const shared = (await docker.networks.inspect(SHARED)).Id;
		sh("docker", "service", "update", "-d", "--network-rm", own, CADDY);
		expect(await networksOf(CADDY)).toEqual([SHARED]);
		await reattachOrgNetworks(ctx);
		expect(await networksOf(CADDY)).toEqual([SHARED, own].sort());
		expect(shared).toBeTruthy();
	}, 120_000);
});

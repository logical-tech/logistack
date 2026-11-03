import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, node, organization, runMigrations } from "@logistack/db";
import { createDockerClient } from "@logistack/docker";
import { RedisClient } from "bun";
import { eq } from "drizzle-orm";
import type { Ctx } from "../src/ctx.ts";
import { syncNodes } from "../src/nodes.ts";

const PREFIX = "ls-test-fix-";
const INGRESS = "logistack.ingress";
const USER_LABEL = "ls-test-fix.zone";

function docker(...args: string[]): string {
	const p = Bun.spawnSync(["docker", ...args], { stderr: "pipe" });
	if (p.exitCode !== 0)
		throw new Error(`docker ${args.join(" ")} failed: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
}

/** The local Swarm node, when there is one and no real install has labelled it for ingress. */
const self = (() => {
	try {
		const id = docker("info", "--format", "{{.Swarm.NodeID}}");
		if (!id) return undefined;
		const labels = JSON.parse(
			docker("node", "inspect", id, "--format", "{{json .Spec.Labels}}"),
		) as Record<string, string> | null;
		return labels?.[INGRESS] === undefined ? id : undefined;
	} catch {
		return undefined;
	}
})();

const swarmLabels = (id: string) =>
	JSON.parse(
		docker("node", "inspect", id, "--format", "{{json .Spec.Labels}}"),
	) as Record<string, string>;

describe.skipIf(!self)("node label sync on the local swarm", () => {
	const nodeId = self as string;
	const tag = `${PREFIX}${crypto.randomUUID().slice(0, 8)}`;
	const names = [`${tag}-pg`, `${tag}-redis`];
	let db: ReturnType<typeof createDb>;
	let redis: RedisClient;
	let ctx: Ctx;

	const run = (name: string, image: string, port: number, ...env: string[]) => {
		docker(
			"run",
			"-d",
			"--name",
			name,
			"--label",
			"logistack.test=fix",
			"-p",
			`127.0.0.1::${port}`,
			...env.flatMap((e) => ["-e", e]),
			image,
		);
		return docker("port", name, `${port}/tcp`).split("\n")[0] as string;
	};

	beforeAll(async () => {
		const pg = run(
			names[0] as string,
			"postgres:17-alpine",
			5432,
			"POSTGRES_PASSWORD=test",
		);
		const redisAddr = run(names[1] as string, "redis:7-alpine", 6379);
		const url = `postgres://postgres:test@${pg}/postgres`;
		for (let i = 0; ; i++) {
			try {
				await runMigrations(url);
				break;
			} catch (e) {
				if (i > 60) throw e;
				await Bun.sleep(500);
			}
		}
		db = createDb(url, { onnotice: () => {} });
		redis = new RedisClient(`redis://${redisAddr}`);
		ctx = {
			db,
			docker: createDockerClient(),
			bus: { redis, publish: async () => {} },
		} as unknown as Ctx;
		await db.insert(organization).values({
			id: "org_fix",
			name: "Fix",
			slug: "fix",
			createdAt: new Date(),
		});
		docker("node", "update", "--label-add", `${INGRESS}=pending`, nodeId);
	}, 120_000);

	afterAll(async () => {
		Bun.spawnSync(
			[
				"docker",
				"node",
				"update",
				"--label-rm",
				INGRESS,
				"--label-rm",
				USER_LABEL,
				nodeId,
			],
			{ stdout: "ignore", stderr: "ignore" },
		);
		redis?.close();
		await db?.$client.end();
		for (const name of names)
			if (name.startsWith(PREFIX))
				Bun.spawnSync(["docker", "rm", "-f", "-v", name], {
					stdout: "ignore",
					stderr: "ignore",
				});
	});

	const row = async () =>
		(await db.select().from(node).where(eq(node.swarmNodeId, nodeId)))[0];

	test("an installer label changed out of band survives a sync pass, and the DB mirrors it", async () => {
		await syncNodes(ctx);
		expect((await row())?.labels[INGRESS]).toBe("pending");

		// What `install.sh --enable-ingress` does.
		docker("node", "update", "--label-add", `${INGRESS}=true`, nodeId);
		await syncNodes(ctx);
		expect(swarmLabels(nodeId)[INGRESS]).toBe("true");
		expect((await row())?.labels[INGRESS]).toBe("true");
	});

	test("labels set through the API are pushed; system labels in them are not", async () => {
		const current = await row();
		await db
			.update(node)
			.set({ labels: { [USER_LABEL]: "a", [INGRESS]: "pending" } })
			.where(eq(node.id, current?.id as string));
		await syncNodes(ctx);
		const labels = swarmLabels(nodeId);
		expect(labels[USER_LABEL]).toBe("a");
		expect(labels[INGRESS]).toBe("true");
		expect((await row())?.labels).toMatchObject({
			[USER_LABEL]: "a",
			[INGRESS]: "true",
		});
	});
});

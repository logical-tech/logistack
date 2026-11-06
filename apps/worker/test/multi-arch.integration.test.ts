import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missingPlatforms } from "@logistack/core";
import { createDockerClient, type ServiceSpec } from "@logistack/docker";
import { buildkitAddr, buildPlan, ensureBuildkit, run } from "../src/build.ts";
import {
	binfmtSpec,
	dockerConfig,
	parseWorkerPlatforms,
} from "../src/build-platforms.ts";
import { loadConfig } from "../src/config.ts";
import type { Ctx } from "../src/ctx.ts";
import { BUILDKIT_CLIENT, hasDocker, sh } from "./harness.ts";

describe("parseWorkerPlatforms", () => {
	test("os/arch/variant, native first, deduplicated across workers", () => {
		const json = JSON.stringify([
			{
				id: "a",
				platforms: [
					{ architecture: "arm64", os: "linux" },
					{ architecture: "amd64", os: "linux" },
					{ architecture: "arm", os: "linux", variant: "v7" },
				],
			},
			{ id: "b", platforms: [{ architecture: "amd64", os: "linux" }] },
		]);
		expect(parseWorkerPlatforms(json)).toEqual([
			"linux/arm64",
			"linux/amd64",
			"linux/arm/v7",
		]);
	});
});

describe("dockerConfig", () => {
	test("credentials keyed by registry host; Docker Hub also under its v1 index", () => {
		const auth = { username: "u", password: "p", serveraddress: "docker.io" };
		const cfg = JSON.parse(dockerConfig(auth));
		expect(Object.keys(cfg.auths)).toEqual([
			"docker.io",
			"https://index.docker.io/v1/",
		]);
		expect(atob(cfg.auths["docker.io"].auth)).toBe("u:p");
		expect(
			Object.keys(
				JSON.parse(dockerConfig({ ...auth, serveraddress: "registry.x.dev" }))
					.auths,
			),
		).toEqual(["registry.x.dev"]);
	});
});

describe("binfmtSpec", () => {
	test("a one-shot job on BuildKit's node with SYS_ADMIN, never privileged", () => {
		const spec = binfmtSpec({
			name: "ls-binfmt",
			image: "tonistiigi/binfmt:qemu-v9.2.2",
			nodeId: "n1",
			archs: ["amd64"],
			labels: { "logistack.managed": "true" },
		});
		expect(spec.Mode).toEqual({
			ReplicatedJob: { MaxConcurrent: 1, TotalCompletions: 1 },
		});
		expect(spec.TaskTemplate.ContainerSpec.Args).toEqual([
			"--install",
			"amd64",
		]);
		expect(spec.TaskTemplate.ContainerSpec.CapabilityAdd).toEqual([
			"CAP_SYS_ADMIN",
		]);
		expect(spec.TaskTemplate.Placement?.Constraints).toEqual(["node.id==n1"]);
	});
});

const PREFIX = "ls-test-march-";
const LABELS = { "logistack.test": "march" };
const NET = `${PREFIX}control`;
const REGISTRY = `${PREFIX}registry`;
const docker = createDockerClient();

/** Removes only objects whose name starts with PREFIX. */
async function cleanup() {
	const ours = (n?: string) => !!n?.replace(/^\//, "").startsWith(PREFIX);
	const ignore = () => {};
	for (const s of await docker.services.list({ name: [PREFIX] }))
		if (ours(s.Spec.Name)) await docker.services.remove(s.ID).catch(ignore);
	for (let i = 0; i < 40; i++) {
		const left = (
			await docker.containers.list({ name: [PREFIX] }, true)
		).filter(
			(c) =>
				c.Names.some(ours) || ours(c.Labels["com.docker.swarm.service.name"]),
		);
		for (const c of left.filter(
			(c) => !c.Labels["com.docker.swarm.service.name"],
		))
			await docker.containers.remove(c.Id, true).catch(ignore);
		if (!left.some((c) => c.Labels["com.docker.swarm.service.name"])) break;
		await Bun.sleep(500);
	}
	for (const n of await docker.networks.list({ name: [PREFIX] }))
		if (ours(n.Name)) await docker.networks.remove(n.Id).catch(ignore);
	for (const v of await docker.volumes.list({ name: [PREFIX] }))
		if (ours(v.Name)) await docker.volumes.remove(v.Name, true).catch(ignore);
}

async function waitTask(service: string, want: "running" | "complete") {
	for (let i = 0; i < 240; i++) {
		const tasks = await docker.tasks.list({ service: [service] });
		if (tasks.some((t) => t.Status.State === want)) return;
		const bad = tasks.find((t) =>
			["failed", "rejected"].includes(t.Status.State),
		);
		if (bad)
			throw new Error(`${service}: ${bad.Status.Err ?? bad.Status.Message}`);
		await Bun.sleep(500);
	}
	throw new Error(`${service} never reached ${want}`);
}

const service = (name: string, spec: Partial<ServiceSpec["TaskTemplate"]>) =>
	docker.services.create({
		Name: name,
		Labels: LABELS,
		TaskTemplate: {
			ContainerSpec: { Image: "busybox:1.37", Labels: LABELS },
			...spec,
		} as ServiceSpec["TaskTemplate"],
	});

describe.skipIf(!hasDocker)("multi-architecture builds on this swarm", () => {
	let ctx: Ctx;
	let work: string;

	beforeAll(async () => {
		await cleanup();
		work = await mkdtemp(join(tmpdir(), PREFIX));
		ctx = {
			cfg: loadConfig({
				DATABASE_URL: "postgres://unused@localhost/unused",
				REDIS_URL: "redis://localhost:1",
				LOGISTACK_MASTER_KEY: "unused",
				LS_NAME_PREFIX: PREFIX,
				LS_CONTROL_NETWORK: NET,
				LS_SCOPE_LABELS: JSON.stringify(LABELS),
				LS_BUILDCTL: JSON.stringify([
					"docker",
					"run",
					"--rm",
					"-i",
					"--name",
					`${PREFIX}buildctl`,
					"--label",
					"logistack.test=march",
					"--network",
					NET,
					"-v",
					`${work}:${work}`,
					"--entrypoint",
					"buildctl",
					BUILDKIT_CLIENT,
				]),
			}),
			docker,
		} as unknown as Ctx;
		await docker.networks.create({
			Name: NET,
			Driver: "overlay",
			Attachable: true,
			Labels: LABELS,
		});
		await service(REGISTRY, {
			ContainerSpec: { Image: "registry:3.0.0", Labels: LABELS },
			Networks: [{ Target: NET }],
		});
		await ensureBuildkit(ctx);
		await waitTask(REGISTRY, "running");
	}, 240_000);

	afterAll(async () => {
		await cleanup();
	}, 120_000);

	const buildctl = (args: string[]) =>
		run([...ctx.cfg.LS_BUILDCTL, "--addr", buildkitAddr(ctx), ...args], {
			log: () => {},
			signal: AbortSignal.timeout(300_000),
		});

	test("BuildKit reports its platforms, native first", async () => {
		let out = "";
		// The fresh BuildKit task takes a moment to listen.
		for (let i = 0; i < 60 && !out; i++)
			out = await buildctl([
				"debug",
				"workers",
				"--format",
				"{{json .}}",
			]).catch(async () => {
				await Bun.sleep(1_000);
				return "";
			});
		const platforms = parseWorkerPlatforms(out);
		const arch = (await docker.info()).Architecture;
		expect(platforms[0]).toBe(
			arch === "aarch64" ? "linux/arm64" : "linux/amd64",
		);
	}, 120_000);

	test("a multi-platform build pushes one manifest list with both architectures", async () => {
		const workers = parseWorkerPlatforms(
			await buildctl(["debug", "workers", "--format", "{{json .}}"]),
		);
		if (missingPlatforms(workers).length) {
			console.warn(
				`skipped: this BuildKit cannot emulate ${missingPlatforms(workers).join(", ")}`,
			);
			return;
		}
		const dir = join(work, "app");
		sh("mkdir", "-p", dir);
		await writeFile(
			join(dir, "Dockerfile"),
			'FROM busybox:1.37\nRUN uname -m > /arch\nCMD ["cat", "/arch"]\n',
		);
		const ref = `${REGISTRY}:5000/march/app:dep_test`;
		const plan = buildPlan({
			dir,
			appPath: ".",
			build: { type: "dockerfile", dockerfilePath: "Dockerfile", context: "." },
			buildEnv: [],
			context: {},
			imageRef: ref,
			railpackFrontend: "unused",
			platforms: ["linux/amd64", "linux/arm64"],
		});
		expect(plan.pushes).toBe(true);
		// The test registry speaks plain HTTP; real registries are TLS.
		const args = plan.args.map((a) =>
			a.startsWith("type=image,") ? `${a},registry.insecure=true` : a,
		);
		await buildctl(args);
		const index = JSON.parse(
			sh(
				"docker",
				"run",
				"--rm",
				"--name",
				`${PREFIX}curl`,
				"--label",
				"logistack.test=march",
				"--network",
				NET,
				"curlimages/curl:latest",
				"-sf",
				"-H",
				"Accept: application/vnd.oci.image.index.v1+json",
				`http://${REGISTRY}:5000/v2/march/app/manifests/dep_test`,
			),
		) as { manifests: { platform: { architecture: string; os: string } }[] };
		const archs = index.manifests
			.map((m) => m.platform)
			.filter((p) => p.os === "linux")
			.map((p) => p.architecture)
			.sort();
		expect(archs).toEqual(["amd64", "arm64"]);
	}, 360_000);

	test("Swarm keeps a single-architecture image off nodes of the other architecture", async () => {
		const arch = (await docker.info()).Architecture;
		const own = arch === "aarch64" ? "arm64" : "amd64";
		const other = own === "arm64" ? "amd64" : "arm64";
		await service(`${PREFIX}pin-own`, {
			ContainerSpec: {
				Image: "busybox:1.37",
				Labels: LABELS,
				Args: ["sleep", "300"],
			},
			Placement: { Platforms: [{ OS: "linux", Architecture: own }] },
		});
		await service(`${PREFIX}pin-other`, {
			ContainerSpec: {
				Image: "busybox:1.37",
				Labels: LABELS,
				Args: ["sleep", "300"],
			},
			Placement: { Platforms: [{ OS: "linux", Architecture: other }] },
		});
		await waitTask(`${PREFIX}pin-own`, "running");
		await Bun.sleep(3_000);
		const tasks = await docker.tasks.list({ service: [`${PREFIX}pin-other`] });
		expect(tasks.every((t) => t.Status.State === "pending")).toBe(true);
		expect(tasks[0]?.Status.Err ?? "").toContain("platform");
	}, 120_000);

	test("the binfmt job runs as a Swarm task with SYS_ADMIN only", async () => {
		// Status mode (no --install): proves the job can mount binfmt_misc without changing the host.
		const spec = binfmtSpec({
			name: `${PREFIX}binfmt`,
			image: "tonistiigi/binfmt:qemu-v9.2.2",
			nodeId: (await docker.info()).Swarm.NodeID,
			archs: ["amd64"],
			labels: LABELS,
		});
		await docker.services.create({
			...spec,
			TaskTemplate: {
				...spec.TaskTemplate,
				ContainerSpec: { ...spec.TaskTemplate.ContainerSpec, Args: [] },
			},
		});
		await waitTask(`${PREFIX}binfmt`, "complete");
	}, 120_000);
});

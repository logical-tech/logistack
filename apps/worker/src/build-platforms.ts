import {
	type BuildkitState,
	type BuildPlatform,
	emptyBuildkitState,
} from "@logistack/contracts";
import { missingPlatforms, platformsOfArchs } from "@logistack/core";
import { instanceSettings } from "@logistack/db";
import {
	managedLabels,
	type RegistryAuth,
	type ServiceSpec,
} from "@logistack/docker";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { inspectService, upsertService } from "./apply.ts";
import { buildkitAddr, buildkitName, ensureBuildkit, run } from "./build.ts";
import { log } from "./bus.ts";
import { type Ctx, scope } from "./ctx.ts";

/** The architectures of the swarm's nodes, as build platforms. */
export const swarmPlatforms = async (ctx: Ctx): Promise<BuildPlatform[]> =>
	platformsOfArchs(
		(await ctx.docker.nodes.list()).map(
			(n) => n.Description.Platform.Architecture,
		),
	);

const Workers = z.array(
	z.object({
		platforms: z.array(
			z.object({
				os: z.string(),
				architecture: z.string(),
				variant: z.string().optional(),
			}),
		),
	}),
);

/** Pure: `os/arch[/variant]` from `buildctl debug workers --format '{{json .}}'`, native first, deduplicated. */
export const parseWorkerPlatforms = (json: string): string[] => [
	...new Set(
		Workers.parse(JSON.parse(json)).flatMap((w) =>
			w.platforms.map((p) =>
				[p.os, p.architecture, p.variant].filter(Boolean).join("/"),
			),
		),
	),
];

/** Pure: a docker config.json for buildctl's direct push; it is written 0600, never put in argv. */
export function dockerConfig(auth: RegistryAuth): string {
	const entry = { auth: btoa(`${auth.username}:${auth.password}`) };
	const host = auth.serveraddress ?? "";
	return JSON.stringify({
		auths: {
			[host]: entry,
			// shortcut: Docker Hub credentials are looked up under the v1 index URL; other aliases are not mapped.
			...(/(^|\.)docker\.io$/.test(host)
				? { "https://index.docker.io/v1/": entry }
				: {}),
		},
	});
}

async function saveState(ctx: Ctx, patch: Partial<BuildkitState>) {
	const [s] = await ctx.db
		.select({ buildkit: instanceSettings.buildkit })
		.from(instanceSettings)
		.where(eq(instanceSettings.id, "singleton"));
	const next = { ...emptyBuildkitState, ...s?.buildkit, ...patch };
	await ctx.db
		.update(instanceSettings)
		.set({ buildkit: next })
		.where(eq(instanceSettings.id, "singleton"));
	return next;
}

/** Asks BuildKit which platforms it can build and records the answer (or why it could not). */
export async function probeBuildkit(
	ctx: Ctx,
	signal = AbortSignal.timeout(120_000),
): Promise<string[]> {
	const checkedAt = new Date().toISOString();
	try {
		await ensureBuildkit(ctx);
		const out = await run(
			[
				...ctx.cfg.LS_BUILDCTL,
				"--addr",
				buildkitAddr(ctx),
				"debug",
				"workers",
				"--format",
				"{{json .}}",
			],
			{ log: () => {}, signal },
		);
		const platforms = parseWorkerPlatforms(out);
		await saveState(ctx, { platforms, checkedAt, error: null });
		return platforms;
	} catch (e) {
		await saveState(ctx, {
			checkedAt,
			error: e instanceof Error ? e.message : String(e),
		});
		throw e;
	}
}

export const binfmtName = (ctx: Ctx) => `${ctx.cfg.LS_NAME_PREFIX}ls-binfmt`;

/** Pure: a one-shot job that registers QEMU for `archs` in the kernel of one node. */
export function binfmtSpec(o: {
	name: string;
	image: string;
	nodeId: string;
	archs: string[];
	labels: Record<string, string>;
}): ServiceSpec {
	return {
		Name: o.name,
		Labels: o.labels,
		TaskTemplate: {
			ContainerSpec: {
				Image: o.image,
				Labels: o.labels,
				Args: ["--install", o.archs.join(",")],
				// Swarm runs no privileged tasks; mounting binfmt_misc needs only SYS_ADMIN without the default profiles.
				CapabilityAdd: ["CAP_SYS_ADMIN"],
				...({
					Privileges: {
						Seccomp: { Mode: "unconfined" },
						AppArmor: { Mode: "disabled" },
					},
				} as object),
			},
			RestartPolicy: { Condition: "none" },
			Placement: { Constraints: [`node.id==${o.nodeId}`] },
		},
		Mode: { ReplicatedJob: { MaxConcurrent: 1, TotalCompletions: 1 } },
	};
}

async function waitTask(
	ctx: Ctx,
	service: string,
	done: (
		t: Awaited<ReturnType<Ctx["docker"]["tasks"]["list"]>>[number],
	) => boolean | string,
	timeoutMs: number,
) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		for (const t of await ctx.docker.tasks.list({ service: [service] })) {
			const r = done(t);
			if (r === true) return;
			if (typeof r === "string") throw new Error(r);
		}
		await Bun.sleep(500);
	}
	throw new Error(`${service} did not finish within ${timeoutMs / 1000} s`);
}

/**
 * The guided QEMU setup: registers emulators for the missing platforms on BuildKit's node with
 * tonistiigi/binfmt, then restarts BuildKit, which detects emulators only when it starts.
 * Registrations live in the kernel, so a reboot of that node undoes them.
 */
export async function installEmulation(ctx: Ctx): Promise<BuildkitState> {
	await saveState(ctx, {
		emulation: {
			state: "installing",
			error: null,
			at: new Date().toISOString(),
		},
	});
	const name = binfmtName(ctx);
	try {
		const before = await probeBuildkit(ctx);
		const missing = missingPlatforms(before);
		if (missing.length) {
			const bk = buildkitName(ctx);
			const task = (await ctx.docker.tasks.list({ service: [bk] })).find(
				(t) => t.Status.State === "running" && t.NodeID,
			);
			if (!task?.NodeID) throw new Error("BuildKit has no running task");
			const old = await inspectService(ctx, name);
			if (old) await ctx.docker.services.remove(old.ID);
			await ctx.docker.services.create(
				binfmtSpec({
					name,
					image: ctx.cfg.LS_BINFMT_IMAGE,
					nodeId: task.NodeID,
					archs: missing.map((p) => p.slice("linux/".length)),
					labels: {
						...managedLabels({
							resource: "binfmt",
							kind: "system",
							org: "system",
						}),
						...scope(ctx).labels,
					},
				}),
			);
			log("info", "installing QEMU emulators", { missing, node: task.NodeID });
			await waitTask(
				ctx,
				name,
				(t) =>
					t.Status.State === "complete" ||
					(["failed", "rejected"].includes(t.Status.State) &&
						`QEMU setup failed: ${t.Status.Err ?? t.Status.Message}`),
				180_000,
			);
			const current = await inspectService(ctx, bk);
			if (!current) throw new Error("BuildKit is gone");
			const force = (current.Spec.TaskTemplate.ForceUpdate ?? 0) + 1;
			await upsertService(ctx, undefined, current.Spec, (_c, d) => ({
				...d,
				TaskTemplate: { ...d.TaskTemplate, ForceUpdate: force },
			}));
			await waitTask(
				ctx,
				bk,
				(t) =>
					t.Spec.ForceUpdate === force &&
					t.DesiredState === "running" &&
					t.Status.State === "running",
				120_000,
			);
		}
		let platforms: string[] | undefined;
		// The restarted BuildKit takes a moment to listen.
		for (let i = 0; !platforms; i++)
			platforms = await probeBuildkit(ctx).catch(async (e) => {
				if (i >= 30) throw e;
				await Bun.sleep(1_000);
				return undefined;
			});
		const after = missingPlatforms(platforms);
		if (after.length)
			throw new Error(
				`BuildKit still cannot build ${after.join(", ")}; the node's kernel may lack binfmt_misc`,
			);
		return await saveState(ctx, {
			emulation: {
				state: "installed",
				error: null,
				at: new Date().toISOString(),
			},
		});
	} catch (e) {
		return await saveState(ctx, {
			emulation: {
				state: "failed",
				error: e instanceof Error ? e.message : String(e),
				at: new Date().toISOString(),
			},
		});
	} finally {
		const job = await inspectService(ctx, name);
		if (job) await ctx.docker.services.remove(job.ID).catch(() => {});
	}
}

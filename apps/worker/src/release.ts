import type { ReleaseCommand } from "@logistack/contracts";
import { compileRelease, type ReleasePhase } from "@logistack/core";
import {
	authForImage,
	DockerError,
	type RegistryAuth,
	type ServiceSpec,
} from "@logistack/docker";
import type { LogLine } from "./build.ts";
import type { Ctx } from "./ctx.ts";

const pending = new Set([
	"new",
	"allocated",
	"pending",
	"assigned",
	"accepted",
	"preparing",
	"ready",
	"starting",
	"running",
]);

async function remove(ctx: Ctx, name: string) {
	await ctx.docker.services.remove(name).catch((e) => {
		if (!(e instanceof DockerError && e.notFound)) throw e;
	});
}

/**
 * Runs a release command once as a Swarm job built from the service's compiled spec, streaming
 * its output into the deployment log. Resolves with the failure reason, or undefined on exit 0.
 * The job is named after the service, so a retry replaces a leftover instead of adding one.
 */
export async function runRelease(
	ctx: Ctx,
	svc: ServiceSpec,
	phase: ReleasePhase,
	cmd: ReleaseCommand,
	o: { registryAuth?: RegistryAuth; line: LogLine; signal: AbortSignal },
): Promise<string | undefined> {
	const spec = compileRelease(svc, phase, cmd.command);
	const label = phase === "pre" ? "pre-deploy" : "post-deploy";
	o.line(`==> ${label}: ${JSON.stringify(cmd.command)}`);
	await remove(ctx, spec.Name);
	const stopLogs = new AbortController();
	try {
		await ctx.docker.services.create(
			spec,
			authForImage(spec.TaskTemplate.ContainerSpec.Image ?? "", o.registryAuth),
		);
		const follow = (async () => {
			const dec = new TextDecoder();
			let rest = "";
			for await (const f of await ctx.docker.services.logs(spec.Name, {
				follow: true,
				signal: stopLogs.signal,
			})) {
				const lines = (rest + dec.decode(f.data, { stream: true })).split("\n");
				rest = lines.pop() ?? "";
				for (const l of lines) o.line(l);
			}
			if (rest) o.line(rest);
		})().catch(() => {});
		const deadline = Date.now() + cmd.timeoutSeconds * 1000;
		let error: string | undefined;
		for (;;) {
			o.signal.throwIfAborted();
			const [task] = await ctx.docker.tasks.list({ service: [spec.Name] });
			const s = task?.Status;
			if (s?.State === "complete") break;
			if (s && !pending.has(s.State)) {
				const code = s.ContainerStatus?.ExitCode;
				error =
					code !== undefined
						? `${label} exited with ${code}`
						: `${label} ${s.State}${s.Err ? `: ${s.Err}` : ""}`;
				break;
			}
			if (Date.now() > deadline) {
				error = `${label} timed out after ${cmd.timeoutSeconds}s`;
				break;
			}
			await Bun.sleep(500);
		}
		// Service logs never end on their own; give the last lines a moment to arrive.
		await Promise.race([follow, Bun.sleep(1_000)]);
		o.line(error ? `==> ${error}` : `==> ${label} succeeded`);
		return error;
	} finally {
		stopLogs.abort();
		await remove(ctx, spec.Name).catch(() => {});
	}
}

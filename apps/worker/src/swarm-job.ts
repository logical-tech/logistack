import type { DockerClient } from "@logistack/docker";

/** Task states that have not settled yet. */
const live = [
	"new",
	"pending",
	"assigned",
	"accepted",
	"preparing",
	"starting",
	"running",
];

/**
 * Waits for the one task of a Swarm job service (`name`) to complete. Throws with its state,
 * error and last log lines when it ends any other way, or when `timeoutMs` passes.
 */
export async function waitForJob(
	docker: { tasks: Pick<DockerClient["tasks"], "list"> } & {
		services: Pick<DockerClient["services"], "logs">;
	},
	name: string,
	o: { what: string; timeoutMs: number; pollMs?: number },
): Promise<void> {
	const deadline = Date.now() + o.timeoutMs;
	for (;;) {
		const [task] = await docker.tasks.list({ service: [name] });
		const state = task?.Status?.State;
		if (state === "complete") return;
		if (state && !live.includes(state)) {
			let logs = "";
			try {
				const dec = new TextDecoder();
				for await (const f of await docker.services.logs(name, { tail: 20 }))
					logs += dec.decode(f.data);
			} catch {}
			throw new Error(
				`${o.what} ${state}${task?.Status?.Err ? `: ${task.Status.Err}` : ""}${logs.trim() ? `\n${logs.replace(/[^\x20-\x7e\n]/g, "").trim()}` : ""}`,
			);
		}
		if (Date.now() > deadline) throw new Error(`${o.what} timed out`);
		await Bun.sleep(o.pollMs ?? 1_000);
	}
}

import { existsSync } from "node:fs";
import { createDockerClient, type DockerClient } from "../src/client.ts";
import { managedLabels } from "../src/labels.ts";
import type { Filters, Labels } from "../src/types.ts";

export const socketPath = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
export const hasDocker = existsSync(socketPath);
export const docker: DockerClient = createDockerClient({ socketPath });

export const IMAGE = "busybox:1.37";
export const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const name = (what: string) => `ls-test-${what}-${runId}`;

export const testLabels = (
	kind: Parameters<typeof managedLabels>[0]["kind"],
): Labels => ({
	...managedLabels({ resource: runId, kind, org: "ls-test" }),
	"logistack.test": "true",
	"logistack.test.run": runId,
});
export const runFilter: Filters = { label: [`logistack.test.run=${runId}`] };

export const seconds = (s: number) => s * 1e9;

export async function waitFor<T>(
	what: string,
	fn: () => Promise<T | undefined | false>,
	timeoutMs = 30_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(250);
	}
}

export async function ensureImage(): Promise<void> {
	try {
		await docker.images.inspect(IMAGE);
	} catch {
		await docker.images.pull(IMAGE);
	}
}

/** Removes every object this test run created, even when a test failed midway. */
export async function sweep(): Promise<void> {
	const ignore = () => {};
	for (const s of await docker.services.list(runFilter))
		await docker.services.remove(s.ID).catch(ignore);
	for (const c of await docker.containers.list(runFilter, true))
		await docker.containers.remove(c.Id, true).catch(ignore);
	for (const c of await docker.configs.list(runFilter))
		await docker.configs.remove(c.ID).catch(ignore);
	for (const s of await docker.secrets.list(runFilter))
		await docker.secrets.remove(s.ID).catch(ignore);
	for (const v of await docker.volumes.list(runFilter))
		await docker.volumes.remove(v.Name, true).catch(ignore);
	// Overlay networks stay "in use" until the service's tasks are gone.
	await waitFor(
		"test tasks to drain",
		async () => (await docker.containers.list(runFilter, true)).length === 0,
		20_000,
	).catch(ignore);
	for (const n of await docker.networks.list(runFilter))
		await docker.networks.remove(n.Id).catch(ignore);
}

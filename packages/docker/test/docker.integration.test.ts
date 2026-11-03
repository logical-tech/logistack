import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DockerError, DockerVersionConflictError } from "../src/errors.ts";
import { managedFilters } from "../src/labels.ts";
import type { Frame } from "../src/stream.ts";
import { createTransport } from "../src/transport.ts";
import type { DockerEvent, ServiceSpec } from "../src/types.ts";
import {
	docker,
	ensureImage,
	hasDocker,
	IMAGE,
	name,
	runFilter,
	runId,
	seconds,
	socketPath,
	sweep,
	testLabels,
	waitFor,
} from "./helpers.ts";

const dec = new TextDecoder();
const text = (frames: Frame[], stream: Frame["stream"]) =>
	frames
		.filter((f) => f.stream === stream)
		.map((f) => dec.decode(f.data))
		.join("");

async function collect(it: AsyncIterable<Frame>): Promise<Frame[]> {
	const out: Frame[] = [];
	for await (const f of it) out.push(f);
	return out;
}

async function readUntil(
	reader: { read(): Promise<{ value?: Frame; done: boolean }> },
	needle: string,
): Promise<string> {
	let acc = "";
	while (!acc.includes(needle)) {
		const { value, done } = await reader.read();
		if (done || !value)
			throw new Error(
				`stream ended before ${JSON.stringify(needle)}; got ${JSON.stringify(acc)}`,
			);
		acc += dec.decode(value.data);
	}
	return acc;
}

describe.skipIf(!hasDocker)("docker engine (integration)", () => {
	beforeAll(async () => {
		expect(await docker.ping()).toBe("OK");
		await ensureImage();
	}, 120_000);
	afterAll(sweep, 60_000);

	test("system calls answer", async () => {
		const [info, version] = await Promise.all([
			docker.info(),
			docker.version(),
		]);
		expect(info.Swarm.LocalNodeState).toBe("active");
		expect(Number(version.ApiVersion)).toBeGreaterThanOrEqual(1.47);
		expect((await docker.swarm.joinTokens()).Worker).toStartWith("SWMTKN-");
	});

	test("missing objects raise a typed DockerError", async () => {
		const err = await docker.services.inspect(name("missing")).catch((e) => e);
		expect(err).toBeInstanceOf(DockerError);
		expect(err).toMatchObject({ status: 404, method: "GET", notFound: true });
		expect(err.path).toStartWith("/services/");
		expect(err.message).toContain("not found");
	});

	test("service create, start-first update, version conflict, logs, events, remove", async () => {
		const ac = new AbortController();
		const events: DockerEvent[] = [];
		const watching = (async () => {
			try {
				for await (const e of docker.events({
					filters: { type: ["service"] },
					signal: ac.signal,
				}))
					events.push(e);
			} catch (e) {
				if ((e as Error).name !== "AbortError") throw e;
			}
		})();
		// let the events subscription register before the create
		await Bun.sleep(200);

		const svcName = name("svc");
		const spec: ServiceSpec = {
			Name: svcName,
			Labels: testLabels("service"),
			TaskTemplate: {
				ContainerSpec: {
					Image: IMAGE,
					Labels: testLabels("service"),
					Command: ["sh", "-c"],
					Args: [
						'mkdir -p /www && echo "v=$V" > /www/index.html && echo started-$V && exec httpd -f -p 8080 -h /www',
					],
					Env: ["V=1"],
					Healthcheck: {
						Test: ["CMD", "wget", "-q", "-O", "-", "http://127.0.0.1:8080/"],
						Interval: seconds(1),
						Timeout: seconds(1),
						Retries: 3,
						StartPeriod: seconds(1),
					},
					StopGracePeriod: seconds(1),
				},
				RestartPolicy: { Condition: "any", Delay: seconds(1) },
			},
			Mode: { Replicated: { Replicas: 1 } },
			UpdateConfig: {
				Parallelism: 1,
				Order: "start-first",
				FailureAction: "rollback",
				Monitor: seconds(2),
			},
			RollbackConfig: {
				Parallelism: 1,
				Order: "start-first",
				Monitor: seconds(2),
			},
		};
		const { ID } = await docker.services.create(spec);

		const listed = await docker.services.list(
			managedFilters({ resource: runId, kind: "service" }),
		);
		expect(listed.map((s) => s.ID)).toEqual([ID]);

		await waitFor("task running", async () => {
			const tasks = await docker.tasks.list({
				service: [ID],
				"desired-state": ["running"],
			});
			return tasks.some((t) => t.Status.State === "running");
		});

		const before = await docker.services.inspect(ID);
		await docker.services.update(ID, before.Version.Index, {
			...before.Spec,
			TaskTemplate: {
				...before.Spec.TaskTemplate,
				ContainerSpec: {
					...before.Spec.TaskTemplate.ContainerSpec,
					Env: ["V=2"],
				},
			},
		});

		const stale = await docker.services
			.update(ID, before.Version.Index, before.Spec)
			.catch((e) => e);
		expect(stale).toBeInstanceOf(DockerVersionConflictError);
		expect(stale.message).toContain("update out of sequence");

		const done = await waitFor(
			"update completed",
			async () => {
				const s = await docker.services.inspect(ID);
				return s.UpdateStatus?.State === "completed" && s;
			},
			45_000,
		);
		expect(done.Spec.UpdateConfig?.Order).toBe("start-first");
		expect(done.Spec.TaskTemplate.ContainerSpec.Env).toEqual(["V=2"]);

		const logs = await collect(
			await docker.services.logs(ID, { stdout: true, stderr: true }),
		);
		const out = text(logs, "stdout");
		expect(out).toContain("started-1");
		expect(out).toContain("started-2");
		expect(text(logs, "stderr")).not.toContain("started-");

		await docker.services.remove(ID);
		await waitFor(
			"remove event",
			async () =>
				events.some((e) => e.Action === "remove" && e.Actor.ID === ID),
			10_000,
		);
		ac.abort();
		await watching;

		const create = events.find(
			(e) => e.Action === "create" && e.Actor.ID === ID,
		);
		expect(create?.Actor.Attributes.name).toBe(svcName);
		expect(events.some((e) => e.Action === "update" && e.Actor.ID === ID)).toBe(
			true,
		);
		const err = await docker.services.inspect(ID).catch((e) => e);
		expect(err).toMatchObject({ status: 404 });
	}, 90_000);

	describe("containers", () => {
		let id = "";
		beforeAll(async () => {
			({ Id: id } = await docker.containers.create(name("ctr"), {
				Image: IMAGE,
				Cmd: ["sh", "-c", "echo to-stdout; echo to-stderr >&2; exec sleep 300"],
				Labels: testLabels("system"),
			}));
			await docker.containers.start(id);
		});

		test("logs are demuxed into stdout and stderr", async () => {
			const frames = await waitFor("both log lines", async () => {
				const f = await collect(await docker.containers.logs(id));
				return f.length >= 2 && f;
			});
			expect(text(frames, "stdout")).toBe("to-stdout\n");
			expect(text(frames, "stderr")).toBe("to-stderr\n");
		});

		test("follow logs stop when aborted", async () => {
			const ac = new AbortController();
			const it = await docker.containers.logs(id, {
				follow: true,
				signal: ac.signal,
			});
			const first = await it.next();
			// stdout and stderr lines have no guaranteed relative order
			const f = first.value as Frame;
			expect(dec.decode(f.data)).toBe(`to-${f.stream}\n`);
			ac.abort();
			// frames already buffered may still arrive; the iterator must then fail, not hang or end cleanly
			const drain = async () => {
				for await (const _ of it) {
				}
			};
			await expect(drain()).rejects.toMatchObject({ name: "AbortError" });
		});

		test("exec with tty is interactive and resizable", async () => {
			const s = await docker.containers.exec(id, { cmd: ["sh"], tty: true });
			const reader = s.output.getReader();
			await s.resize({ rows: 40, cols: 123 });
			await s.write("stty size; echo hi-$((40+2))\n");
			const out = await readUntil(reader, "hi-42");
			expect(out).toContain("40 123");
			await s.write("exit 7\n");
			while (!(await reader.read()).done) {}
			expect(await s.exitCode()).toBe(7);
		});

		test("exec without tty demuxes and honours stdin EOF", async () => {
			const s = await docker.containers.exec(id, {
				cmd: ["sh", "-c", "cat; echo bye >&2"],
			});
			const payload = "x".repeat(256 * 1024);
			await s.write(payload);
			await s.closeStdin();
			const frames = await collect(s.output);
			expect(text(frames, "stdout")).toBe(payload);
			expect(text(frames, "stderr")).toBe("bye\n");
			expect(await s.exitCode()).toBe(0);
		});

		test("exec on a missing container rejects", async () => {
			await expect(
				docker.containers.exec(name("nope"), { cmd: ["true"] }),
			).rejects.toMatchObject({ status: 404 });
		});

		test("writing to a finished exec rejects instead of hanging", async () => {
			const s = await docker.containers.exec(id, { cmd: ["true"] });
			await collect(s.output);
			await expect(s.write("late\n")).rejects.toThrow(/closed/);
		});

		test("a failed hijacked start raises DockerError without hanging", async () => {
			const { Id } = await docker.containers.create(name("stopped"), {
				Image: IMAGE,
				Cmd: ["sleep", "300"],
				Labels: testLabels("system"),
			});
			await docker.containers.start(Id);
			const t = createTransport(socketPath, "1.47");
			const exec = await t.json<{ Id: string }>(
				"POST",
				`/containers/${Id}/exec`,
				{
					body: { AttachStdout: true, Cmd: ["true"] },
				},
			);
			await docker.containers.remove(Id, true);
			const err = await t
				.hijack(`/exec/${exec.Id}/start`, { Detach: false, Tty: false })
				.catch((e) => e);
			expect(err).toBeInstanceOf(DockerError);
			expect(err.status).toBeGreaterThanOrEqual(400);
			expect(err.path).toEndWith(`/exec/${exec.Id}/start`);
		});

		test.skipIf(!!process.env.CI)(
			"stats one-shot and stream",
			async () => {
				const one = await docker.containers.stats(id);
				expect(one.id).toBe(id);
				expect(one.memory_stats.usage).toBeGreaterThan(0);
				const ac = new AbortController();
				let n = 0;
				try {
					for await (const s of docker.containers.statsStream(id, ac.signal)) {
						expect(s.id).toBe(id);
						if (++n === 2) ac.abort();
					}
				} catch (e) {
					expect((e as Error).name).toBe("AbortError");
				}
				expect(n).toBe(2);
			},
			15_000,
		);
	});

	test("config and secret create, list by label, remove", async () => {
		const cfg = await docker.configs.create({
			Name: name("cfg"),
			Labels: testLabels("config"),
			Data: "port=8080\n",
		});
		const sec = await docker.secrets.create({
			Name: name("sec"),
			Labels: testLabels("secret"),
			Data: new Uint8Array([0, 1, 2, 255]),
		});
		const configs = await docker.configs.list(runFilter);
		expect(configs.map((c) => c.ID)).toEqual([cfg.ID]);
		expect(Buffer.from(configs[0]?.Spec.Data ?? "", "base64").toString()).toBe(
			"port=8080\n",
		);
		const secrets = await docker.secrets.list(
			managedFilters({ resource: runId, kind: "secret" }),
		);
		expect(secrets.map((s) => s.ID)).toEqual([sec.ID]);

		const dup = await docker.configs
			.create({ Name: name("cfg"), Labels: testLabels("config"), Data: "x" })
			.catch((e) => e);
		expect(dup).toMatchObject({ status: 409, conflict: true });

		await docker.configs.remove(cfg.ID);
		await docker.secrets.remove(sec.ID);
		expect(await docker.configs.list(runFilter)).toEqual([]);
		expect(await docker.secrets.list(runFilter)).toEqual([]);
	});

	test("network and volume create, list by label, remove", async () => {
		const net = await docker.networks.create({
			Name: name("net"),
			Driver: "overlay",
			Attachable: true,
			Labels: testLabels("network"),
		});
		const nets = await docker.networks.list(runFilter);
		expect(nets.map((n) => n.Id)).toEqual([net.Id]);
		// The swarm allocator fills Driver asynchronously; it reads "" for ~100ms after create.
		await waitFor(
			"overlay allocation",
			async () => (await docker.networks.inspect(net.Id)).Driver === "overlay",
			5_000,
		);
		await docker.networks.remove(net.Id);
		expect(await docker.networks.list(runFilter)).toEqual([]);

		const vol = await docker.volumes.create({
			Name: name("vol"),
			Labels: testLabels("volume"),
		});
		expect((await docker.volumes.list(runFilter)).map((v) => v.Name)).toEqual([
			vol.Name,
		]);
		await docker.volumes.remove(vol.Name);
		expect(await docker.volumes.list(runFilter)).toEqual([]);
	});

	test("image pull surfaces registry errors and inspect works", async () => {
		const img = await docker.images.inspect(IMAGE);
		expect(img.RepoTags).toContain(IMAGE);
		const err = await docker.images
			.pull(`ls-test-does-not-exist-${runId}:nope`)
			.catch((e) => e);
		expect(err).toBeInstanceOf(DockerError);
	}, 30_000);
});

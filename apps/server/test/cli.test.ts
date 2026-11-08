import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Io, run } from "../../cli/src/commands.ts";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

describe.skipIf(!hasDocker)("logistack CLI", () => {
	let h: Harness;
	let dir: string;
	let projectId: string;
	let serviceId: string;
	let out: string[];
	let err: string[];

	const io = (extra: Partial<Io> = {}): Io => ({
		out: (s) => out.push(s),
		err: (s) => err.push(s),
		prompt: async () => "",
		interactive: false,
		color: false,
		env: { XDG_CONFIG_HOME: dir },
		fetch: ((url: string, init?: RequestInit) =>
			h.app.request(url, init)) as unknown as typeof fetch,
		...extra,
	});
	const cli = async (...argv: string[]) => {
		out = [];
		err = [];
		return run(argv, io());
	};

	beforeAll(async () => {
		h = await startHarness({ area: "cli", label: "cli" });
		await h.call("POST", "/api/setup", { body: setupBody });
		const cookie = await h.signIn(owner.email, owner.password);
		const as = (body?: unknown) => ({ headers: { cookie }, body });
		const key = (await h.call("POST", "/api/api-keys", as({ name: "ci" }))).json
			.key;
		projectId = (await h.call("POST", "/api/projects", as({ name: "Shop" })))
			.json.id;
		const env = (
			await h.call("GET", `/api/projects/${projectId}/environments`, as())
		).json[0].id;
		serviceId = (
			await h.call(
				"POST",
				`/api/environments/${env}/services`,
				as({
					name: "Web",
					spec: {
						kind: "application",
						source: { type: "image", image: "nginx:1.27" },
						build: { type: "image" },
						ports: [{ target: 80, protocol: "tcp" }],
						replicas: 1,
						resources: { memoryMb: 128 },
						placement: [],
					},
				}),
			)
		).json.id;
		dir = await mkdtemp(join(tmpdir(), "ls-test-cli-"));
		out = [];
		err = [];
		const code = await run(
			["login", "--url", "http://localhost:3000"],
			io({ prompt: async () => key }),
		);
		expect(code).toBe(0);
	}, 90_000);
	afterAll(() => h?.close());

	test("export then diff shows no changes; an edit shows up, applies, and settles", async () => {
		const file = join(dir, "logistack.yaml");
		expect(await cli("export", "--project", projectId, "-o", file)).toBe(0);
		const yaml = await readFile(file, "utf8");
		expect(yaml).toContain("kind: project");

		expect(await cli("diff", "-f", file, "--exit-code")).toBe(0);
		expect(out.join("\n")).toBe("No changes.");

		await writeFile(file, yaml.replace("replicas: 1", "replicas: 3"));
		expect(await cli("diff", "-f", file, "--exit-code")).toBe(2);
		expect(out.join("\n")).toContain("~ service production/web");

		// Not a terminal: apply refuses to go ahead without --yes.
		expect(await cli("apply", "-f", file)).toBe(64);
		expect(await cli("apply", "-f", file, "--yes", "--json")).toBe(0);
		expect(JSON.parse(out.at(-1) as string)).toMatchObject({ applied: true });
		expect(await cli("diff", "-f", file, "--exit-code")).toBe(0);
	});

	test("deploy queues a deployment; errors come back as JSON", async () => {
		expect(await cli("deploy", "--service", serviceId, "--json")).toBe(0);
		expect(JSON.parse(out[0] as string)).toMatchObject({ status: "queued" });
		expect(await cli("deploy", "--service", "svc_missing", "--json")).toBe(1);
		expect(JSON.parse(out[0] as string).error.status).toBe(404);
	});
});

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploymentContextEnv } from "@logistack/core";
import type { Task } from "@logistack/docker";
import { buildPlan, clone, cloneCommands, run } from "../src/build.ts";
import type { Ctx } from "../src/ctx.ts";
import {
	type DomainRow,
	deploymentContext,
	type ServiceContext,
} from "../src/load.ts";
import { domainRoute, routeAccess } from "../src/proxy.ts";
import { crashLoop, observe } from "../src/reconcile.ts";

describe("buildPlan", () => {
	const base = {
		dir: "/w/builds/dep_1",
		appPath: "apps/web",
		imageRef: "ls-local/org/ls-svc-a:dep_1",
		railpackFrontend: "ghcr.io/railwayapp/railpack-frontend:v1",
		platforms: ["linux/arm64" as const],
		buildEnv: [
			{ key: "PUBLIC_URL", value: "https://x", isSecret: false },
			{ key: "NPM_TOKEN", value: "t0ken", isSecret: true },
		],
		context: { LOGISTACK_DEPLOYMENT_ID: "dep_1", LOGISTACK_COMMIT_SHA: "abc" },
	};

	test("dockerfile build: paths resolve inside the checkout, secrets go through env", () => {
		const plan = buildPlan({
			...base,
			build: {
				type: "dockerfile",
				dockerfilePath: "docker/Dockerfile.prod",
				context: ".",
				target: "runtime",
			},
		});
		expect(plan.args).toEqual([
			"build",
			"--progress",
			"plain",
			"--opt",
			"platform=linux/arm64",
			"--frontend",
			"dockerfile.v0",
			"--local",
			"context=/w/builds/dep_1/apps/web",
			"--local",
			"dockerfile=/w/builds/dep_1/apps/web/docker",
			"--opt",
			"filename=Dockerfile.prod",
			"--opt",
			"target=runtime",
			"--secret",
			"id=NPM_TOKEN,env=NPM_TOKEN",
			"--opt",
			"build-arg:PUBLIC_URL=https://x",
			"--opt",
			"build-arg:LOGISTACK_COMMIT_SHA=abc",
			"--opt",
			"build-arg:LOGISTACK_DEPLOYMENT_ID=dep_1",
			"--output",
			"type=docker,name=ls-local/org/ls-svc-a:dep_1",
		]);
		expect(plan.env).toEqual({ NPM_TOKEN: "t0ken" });
		expect(plan.args.join(" ")).not.toContain("t0ken");
		expect(plan.pushes).toBe(false);
	});

	test("several platforms: BuildKit pushes one manifest list instead of a docker tarball", () => {
		const plan = buildPlan({
			...base,
			platforms: ["linux/amd64", "linux/arm64"],
			build: { type: "dockerfile", dockerfilePath: "Dockerfile", context: "." },
		});
		expect(plan.pushes).toBe(true);
		expect(plan.args).toContain("platform=linux/amd64,linux/arm64");
		expect(plan.args.slice(-2)).toEqual([
			"--output",
			"type=image,name=ls-local/org/ls-svc-a:dep_1,push=true",
		]);
	});

	test("paths escaping the checkout are rejected", () => {
		expect(() =>
			buildPlan({
				...base,
				build: {
					type: "dockerfile",
					dockerfilePath: "Dockerfile",
					context: "../../..",
				},
			}),
		).toThrow(/escapes the repository/);
	});

	test("an app path written from the repository root ('/', '/api') stays inside the checkout", () => {
		for (const [appPath, dir] of [
			["/", "/w/builds/dep_1"],
			["/apps/web", "/w/builds/dep_1/apps/web"],
		] as const) {
			const plan = buildPlan({
				...base,
				appPath,
				build: {
					type: "dockerfile",
					dockerfilePath: "Dockerfile",
					context: ".",
				},
			});
			expect(plan.args.join(" ")).toContain(`context=${dir} `);
		}
	});

	test("railpack prepares a plan, then builds it with the railpack frontend", () => {
		const plan = buildPlan({
			...base,
			buildEnv: [],
			build: { type: "railpack" },
		});
		expect(plan.prepare).toEqual([
			"prepare",
			"/w/builds/dep_1/apps/web",
			"--plan-out",
			"/w/builds/dep_1/apps/web/railpack-plan.json",
		]);
		expect(plan.args).toContain(
			"source=ghcr.io/railwayapp/railpack-frontend:v1",
		);
		expect(plan.args).toContain("filename=railpack-plan.json");
		// The railpack frontend reads its plan, not Dockerfile ARGs.
		expect(plan.args.join(" ")).not.toContain("LOGISTACK_");
	});
});

describe("observe", () => {
	const task = (
		state: Task["Status"]["State"],
		desired: Task["DesiredState"] = "running",
	) => ({
		DesiredState: desired,
		Status: { State: state, Timestamp: "", Message: "" },
	});

	test("maps task states to the observed state", () => {
		expect(observe({ exists: false, desired: 1, tasks: [] }).observed).toBe(
			"unknown",
		);
		expect(observe({ exists: true, desired: 0, tasks: [] }).observed).toBe(
			"stopped",
		);
		expect(
			observe({
				exists: true,
				desired: 2,
				tasks: [task("running"), task("running")],
			}),
		).toEqual({ observed: "running", running: 2 });
		expect(
			observe({
				exists: true,
				desired: 2,
				tasks: [task("running"), task("starting")],
			}).observed,
		).toBe("starting");
		expect(
			observe({
				exists: true,
				desired: 1,
				tasks: [task("failed", "shutdown")],
				updateState: "rollback_paused",
			}).observed,
		).toBe("unhealthy");
		expect(
			observe({ exists: true, desired: 1, tasks: [task("failed", "shutdown")] })
				.observed,
		).toBe("failed");
	});
});

describe("crashLoop", () => {
	const now = Date.parse("2026-11-06T10:00:00Z");
	const task = (
		state: Task["Status"]["State"],
		secAgo: number,
		exit = 1,
	): Pick<Task, "Status"> => ({
		Status: {
			State: state,
			// Swarm stamps nanoseconds.
			Timestamp: new Date(now - secAgo * 1000)
				.toISOString()
				.replace("Z", "123456Z"),
			Message: "started",
			Err: `task: non-zero exit (${exit})`,
			ContainerStatus: { ExitCode: exit },
		},
	});

	test("enters at three failures inside five minutes, newest reason first", () => {
		const tasks = [
			task("failed", 200, 2),
			task("failed", 20, 137),
			task("rejected", 100),
			task("running", 5),
		];
		expect(crashLoop(tasks, null, now)).toEqual({
			since: "2026-11-06T10:00:00.000Z",
			failures: 3,
			reason: "task: non-zero exit (137)",
			exitCode: 137,
		});
		expect(crashLoop(tasks.slice(1), null, now)).toBeNull();
		// Failures older than the window do not count.
		expect(
			crashLoop([...tasks.slice(1), task("failed", 400)], null, now),
		).toBeNull();
		// A clean exit or a shutdown is not a crash.
		expect(
			crashLoop(
				[task("complete", 10), task("shutdown", 20), task("shutdown", 30)],
				null,
				now,
			),
		).toBeNull();
	});

	test("stays until the window holds no failure, keeping its start", () => {
		const prev = {
			since: "2026-11-06T09:50:00.000Z",
			failures: 3,
			reason: "x",
			exitCode: 1,
		};
		expect(crashLoop([task("failed", 280)], prev, now)).toMatchObject({
			since: prev.since,
			failures: 1,
		});
		expect(crashLoop([task("failed", 310)], prev, now)).toBeNull();
	});
});

describe("domainRoute", () => {
	const d = {
		id: "dom_1",
		serviceId: "svc_1",
		hostname: "app.example.com",
		port: 8080,
		pathPrefix: null,
		https: true,
		cert: "auto",
		customCertificateId: null,
		redirectTo: null,
		dnsProviderId: null,
	} as DomainRow;

	test("auto HTTPS route to the service by its Docker name", () => {
		expect(domainRoute(d, "ls-svc-1", {})).toEqual({
			ok: true,
			route: {
				domainId: "dom_1",
				hostname: "app.example.com",
				upstream: { host: "ls-svc-1", port: 8080 },
				https: true,
				cert: "auto",
			},
		});
	});

	test("wildcard without DNS provider is a domain error, not a broken sync", () => {
		expect(
			domainRoute({ ...d, hostname: "*.example.com" }, "ls-svc-1", {}),
		).toEqual({
			ok: false,
			error: "a wildcard domain needs a DNS provider",
		});
	});

	test("plain HTTP and redirects", () => {
		const r = domainRoute(
			{ ...d, https: false, redirectTo: "www.example.com" },
			"h",
			{},
		);
		expect(r).toMatchObject({
			ok: true,
			route: {
				https: false,
				cert: "none",
				redirectTo: "https://www.example.com",
			},
		});
	});
});

describe("routeAccess", () => {
	const ip = { type: "ip_allow" as const, cidrs: ["10.0.0.0/8"] };
	const svc = [
		{ username: "ops", hash: "svc-ops" },
		{ username: "ci", hash: "svc-ci" },
	];

	test("no service basic auth leaves the domain's rules as they are", () => {
		expect(routeAccess([ip], null)).toEqual([ip]);
		expect(routeAccess([], [])).toEqual([]);
	});

	test("service basic auth alone protects every domain of the service", () => {
		expect(routeAccess([ip], svc)).toEqual([
			ip,
			{ type: "basic_auth", users: svc },
		]);
	});

	test("domain and service users merge into one check, the domain's entry winning", () => {
		const own = {
			type: "basic_auth" as const,
			users: [
				{ username: "ops", hash: "dom-ops" },
				{ username: "qa", hash: "dom-qa" },
			],
		};
		expect(routeAccess([own, ip], svc)).toEqual([
			ip,
			{
				type: "basic_auth",
				users: [
					{ username: "ops", hash: "dom-ops" },
					{ username: "qa", hash: "dom-qa" },
					{ username: "ci", hash: "svc-ci" },
				],
			},
		]);
	});
});

describe("clone", () => {
	const SHA = "0123456789abcdef0123456789abcdef01234567";

	test("without a sha: shallow clone of the branch head", () => {
		expect(
			cloneCommands({ ref: "main", target: "https://g/r.git", dir: "/w/d" }),
		).toEqual([
			[
				"clone",
				"--depth",
				"1",
				"--single-branch",
				"--branch",
				"main",
				"--",
				"https://g/r.git",
				"/w/d",
			],
		]);
	});

	test("with a sha: fetch exactly that commit and check it out detached", () => {
		expect(
			cloneCommands({
				ref: "main",
				sha: SHA,
				target: "https://g/r.git",
				dir: "/w/d",
			}),
		).toEqual([
			["init", "--quiet", "--", "/w/d"],
			["-C", "/w/d", "fetch", "--depth", "1", "--", "https://g/r.git", SHA],
			["-C", "/w/d", "checkout", "--quiet", "--detach", "FETCH_HEAD"],
		]);
	});

	test("builds the triggered commit even after the branch moved on", async () => {
		const root = await mkdtemp(join(tmpdir(), "ls-clone-"));
		const repo = join(root, "repo");
		const quiet = { log: () => {}, signal: new AbortController().signal };
		const git = (...args: string[]) =>
			run(
				[
					"git",
					"-C",
					repo,
					"-c",
					"user.name=t",
					"-c",
					"user.email=t@t",
					...args,
				],
				quiet,
			);
		try {
			await run(
				["git", "init", "--quiet", "--initial-branch", "main", repo],
				quiet,
			);
			await writeFile(join(repo, "v"), "checked");
			await git("add", "v");
			await git("commit", "--quiet", "-m", "checked commit");
			const checked = await git("rev-parse", "HEAD");
			await writeFile(join(repo, "v"), "moved");
			await git("commit", "--quiet", "-am", "pushed while checks ran");
			const head = await git("rev-parse", "HEAD");
			expect(head).not.toBe(checked);

			const ctx = {
				cfg: { LS_WORK_DIR: join(root, "work"), LS_ALLOW_LOCAL_GIT: true },
			} as unknown as Ctx;
			const source = {
				type: "git" as const,
				repository: repo,
				branch: "main",
				path: ".",
			};
			const pinned = await clone(ctx, source, {
				deploymentId: "dep_sha",
				ref: "main",
				sha: checked,
				...quiet,
			});
			expect(pinned.commitSha).toBe(checked);
			expect(pinned.commitMessage).toBe("checked commit");
			expect(await readFile(join(pinned.dir, "v"), "utf8")).toBe("checked");

			const manual = await clone(ctx, source, {
				deploymentId: "dep_head",
				ref: "main",
				...quiet,
			});
			expect(manual.commitSha).toBe(head);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("deploymentContext", () => {
	const sc = {
		service: {
			name: "web",
			spec: {
				kind: "application",
				source: {
					type: "git",
					repository: "https://g/r.git",
					branch: "main",
					path: ".",
				},
			},
		},
		environmentName: "production",
		projectName: "shop",
		domains: [],
	} as unknown as ServiceContext;
	const d = { id: "dep_1", commitSha: "abc", commitMessage: "msg" };

	test("a branch deployment names its branch", () => {
		expect(
			deploymentContextEnv(deploymentContext(sc, { ...d, gitRef: null }))
				.LOGISTACK_BRANCH,
		).toBe("main");
	});

	test("a tag or release deployment claims no branch", () => {
		const env = deploymentContextEnv(
			deploymentContext(sc, { ...d, gitRef: "v1.2.3" }),
		);
		expect(env.LOGISTACK_BRANCH).toBeUndefined();
		expect(env.LOGISTACK_COMMIT_SHA).toBe("abc");
	});
});

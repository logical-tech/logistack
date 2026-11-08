import { describe, expect, test } from "bun:test";
import type {
	ApplicationSpec,
	AutoscaleCheck,
	ResourceProfiles,
} from "@logistack/contracts";
import { autoscaleChecks } from "../src/autoscale.ts";
import {
	attachFixes,
	type FixContext,
	planFix,
	suggestProfile,
} from "../src/autoscale-fixes.ts";
import { seededResourceProfiles } from "../src/resource-profiles.ts";

const spec = (over: Partial<ApplicationSpec> = {}): ApplicationSpec => ({
	kind: "application",
	source: { type: "image", image: "nginx:1" },
	build: { type: "image" },
	ports: [],
	replicas: 1,
	resources: {},
	placement: [],
	...over,
});

const ctx = (over: Partial<FixContext> = {}): FixContext => ({
	profiles: seededResourceProfiles,
	usage: null,
	...over,
});

describe("suggestProfile", () => {
	const pick = (
		usage: FixContext["usage"],
		resources = {},
		profiles: ResourceProfiles = seededResourceProfiles,
	) => {
		const s = suggestProfile(profiles, usage, resources);
		return s && { name: s.profile.name, fits: s.fits, ...s.resources };
	};

	test.each([
		["no history: the smallest size", null, "Nano", 0.25, 256],
		[
			"idle: the smallest size",
			{ cpu: 0.05, memoryMb: 100 },
			"Nano",
			0.25,
			256,
		],
		["CPU decides", { cpu: 0.3, memoryMb: 100 }, "Small", 0.5, 512],
		["memory decides", { cpu: 0.05, memoryMb: 700 }, "Medium", 1, 1024],
		[
			"exactly the headroom fits",
			{ cpu: 0.5 / 1.3, memoryMb: 100 },
			"Small",
			0.5,
			512,
		],
	] as const)("%s", (_, usage, name, cpu, memoryMb) => {
		expect(pick(usage)).toEqual({ name, fits: true, cpu, memoryMb });
	});

	test("starts at the org default and never goes below it", () => {
		const profiles = { ...seededResourceProfiles, defaultProfile: "Medium" };
		expect(pick(null, {}, profiles)?.name).toBe("Medium");
		expect(pick({ cpu: 0.01, memoryMb: 10 }, {}, profiles)?.name).toBe(
			"Medium",
		);
		expect(pick({ cpu: 1, memoryMb: 10 }, {}, profiles)?.name).toBe("Large");
	});

	test("a memory limit the user set is kept, never shrunk, and ignored for the choice", () => {
		expect(pick({ cpu: 0.1, memoryMb: 3000 }, { memoryMb: 4000 })).toEqual({
			name: "Nano",
			fits: true,
			cpu: 0.25,
			memoryMb: 4000,
		});
	});

	test("nothing large enough: the largest, flagged", () => {
		expect(pick({ cpu: 8, memoryMb: 100 })).toEqual({
			name: "Large",
			fits: false,
			cpu: 2,
			memoryMb: 4096,
		});
	});

	test("profiles without a CPU limit don't count", () => {
		const memOnly = {
			profiles: [{ name: "Mem", memoryMb: 512 }],
			defaultProfile: null,
		};
		expect(pick(null, {}, memOnly)).toBeUndefined();
	});
});

describe("planFix", () => {
	test("apply_profile: before → after rows, notes and the patched spec", () => {
		const plan = planFix(
			"apply_profile",
			spec(),
			ctx({ usage: { cpu: 0.31, memoryMb: 380 } }),
		);
		if (!("fix" in plan)) throw new Error(plan.unavailable);
		expect(plan.fix.changes).toEqual([
			{ label: "CPU limit", before: "None", after: "0.5 CPU (Small)" },
			{ label: "Memory limit", before: "None", after: "512 MB" },
		]);
		expect(plan.fix.notes).toEqual([
			"Over the last day one copy peaked at 0.31 CPU and 380 MB.",
		]);
		expect(plan.fix.redeploy).toBe(true);
		expect(plan.spec.resources).toEqual({ cpu: 0.5, memoryMb: 512 });
	});

	test("apply_profile with no usable profiles is unavailable", () => {
		expect(
			planFix(
				"apply_profile",
				spec(),
				ctx({ profiles: { profiles: [], defaultProfile: null } }),
			),
		).toHaveProperty("unavailable");
	});

	test("ingress_ports moves only published host ports", () => {
		const plan = planFix(
			"ingress_ports",
			spec({
				ports: [
					{ target: 80, published: 8080, protocol: "tcp" },
					{ target: 81, published: 8081, protocol: "tcp", mode: "host" },
					{ target: 82, published: 8082, protocol: "udp", mode: "ingress" },
					{ target: 83, protocol: "tcp" },
				],
			}),
			ctx(),
		);
		if (!("fix" in plan)) throw new Error(plan.unavailable);
		expect(plan.spec.ports.map((p) => p.mode)).toEqual([
			"ingress",
			"ingress",
			"ingress",
			undefined,
		]);
		expect(plan.fix.changes.map((c) => c.label)).toEqual([
			"Port 8080/tcp",
			"Port 8081/tcp",
		]);
	});

	test("a blocked fix reports the reason", () => {
		expect(
			planFix(
				"ingress_ports",
				spec({ ports: [{ target: 80, published: 8080, protocol: "tcp" }] }),
				ctx({ blocked: { ingress_ports: "taken" } }),
			),
		).toEqual({ unavailable: "taken" });
	});
});

describe("add_healthcheck", () => {
	const web = spec({ ports: [{ target: 3000, protocol: "tcp" }] });

	test("before the probe: offered, flagged to probe, HTTP check on the first port", () => {
		const plan = planFix("add_healthcheck", web, ctx());
		if (!("fix" in plan)) throw new Error(plan.unavailable);
		expect(plan.fix.probe).toBe(true);
		expect(plan.fix.changes[0]?.after).toBe("HTTP GET / on port 3000");
		expect(plan.spec.healthcheck).toEqual({
			type: "http",
			port: 3000,
			path: "/",
		});
	});

	test("a passed probe adds its evidence; a failed one withdraws the fix", () => {
		const ok = planFix(
			"add_healthcheck",
			web,
			ctx({ probe: { ok: true, port: 3000, path: "/", ms: 12, tool: "wget" } }),
		);
		if (!("fix" in ok)) throw new Error(ok.unavailable);
		expect(ok.fix.notes[0]).toContain("answered in 12 ms");
		expect(
			planFix(
				"add_healthcheck",
				web,
				ctx({ probe: { ok: false, reason: "no wget" } }),
			),
		).toEqual({ unavailable: "no wget" });
	});

	test("no port or an existing healthcheck: nothing to add", () => {
		expect(planFix("add_healthcheck", spec(), ctx())).toHaveProperty(
			"unavailable",
		);
		expect(
			planFix(
				"add_healthcheck",
				spec({ healthcheck: { type: "tcp", port: 1 } }),
				ctx(),
			),
		).toHaveProperty("unavailable");
	});
});

describe("attachFixes", () => {
	const summary = (checks: AutoscaleCheck[]) =>
		checks
			.filter((c) => !c.ok)
			.map((c) => ({
				id: c.id,
				fix: c.fix?.id,
				unavailable: c.fixUnavailable,
				link: c.link?.to,
			}));

	test("each failed check gets its fix, a reason or a link", () => {
		const s = spec({
			ports: [{ target: 80, published: 8080, protocol: "tcp" }],
		});
		const checks = autoscaleChecks({ spec: s, volumes: 1, nodes: 1 });
		expect(
			summary(
				attachFixes(checks, s, ctx({ blocked: { ingress_ports: "taken" } })),
			),
		).toEqual([
			{
				id: "cpu_limit",
				fix: "apply_profile",
				unavailable: undefined,
				link: undefined,
			},
			{
				id: "volumes",
				fix: undefined,
				unavailable: undefined,
				link: undefined,
			},
			{
				id: "host_ports",
				fix: undefined,
				unavailable: "taken",
				link: undefined,
			},
			{
				id: "healthcheck",
				fix: "add_healthcheck",
				unavailable: undefined,
				link: undefined,
			},
			{
				id: "nodes",
				fix: undefined,
				unavailable: undefined,
				link: "/monitoring",
			},
		]);
	});

	test("passing checks stay untouched", () => {
		const s = spec({ resources: { cpu: 1 } });
		const checks = autoscaleChecks({ spec: s, volumes: 0, nodes: 2 });
		const cpu = attachFixes(checks, s, ctx()).find((c) => c.id === "cpu_limit");
		expect(cpu).toEqual(checks.find((c) => c.id === "cpu_limit"));
	});

	test("applying the fix makes its check pass", () => {
		const s = spec({
			ports: [{ target: 80, published: 8080, protocol: "tcp" }],
		});
		let next = s;
		for (const id of [
			"apply_profile",
			"ingress_ports",
			"add_healthcheck",
		] as const) {
			const plan = planFix(id, next, ctx());
			if (!("spec" in plan)) throw new Error(plan.unavailable);
			next = plan.spec;
		}
		const failed = autoscaleChecks({ spec: next, volumes: 0, nodes: 2 })
			.filter((c) => !c.ok)
			.map((c) => c.id);
		expect(failed).toEqual([]);
	});
});

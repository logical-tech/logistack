import { describe, expect, test } from "bun:test";
import type { ApplicationSpec } from "@logistack/contracts";
import { diffStack, patchSpec, StackUpdateError } from "../src/stack-update.ts";
import type { TemplateServicePlan } from "../src/template.ts";

const app = (
	name: string,
	image: string,
	more: Partial<TemplateServicePlan> = {},
): TemplateServicePlan => ({
	name,
	spec: {
		kind: "application",
		source: { type: "image", image },
		build: { type: "image" },
		ports: [],
		replicas: 1,
		resources: {},
		placement: [],
	},
	env: [],
	mounts: [],
	dependsOn: [],
	...more,
});

const db: TemplateServicePlan = {
	name: "db",
	spec: {
		kind: "database",
		engine: "postgres",
		version: "17",
		credentialsRef: "env",
		resources: {},
	},
	env: [{ key: "POSTGRES_PASSWORD", value: "pw", isSecret: true }],
	mounts: [],
	dependsOn: [],
};

const members = (...names: [string, "application" | "database"][]) =>
	new Map(names.map(([n, kind]) => [n, { kind }]));

describe("diffStack", () => {
	test("the same compose changes nothing", () => {
		const plan = [db, app("web", "nginx:1.29")];
		expect(
			diffStack(
				plan,
				plan,
				members(["db", "database"], ["web", "application"]),
			),
		).toEqual([]);
	});

	test("creates, updates and removes by compose service name", () => {
		const before = [db, app("web", "nginx:1.28"), app("old", "redis:7")];
		const after = [
			db,
			app("web", "nginx:1.29", {
				env: [{ key: "MODE", value: "prod", isSecret: false }],
			}),
			app("worker", "acme/worker:2"),
		];
		const delta = diffStack(
			before,
			after,
			members(
				["db", "database"],
				["web", "application"],
				["old", "application"],
			),
		);
		expect(delta.map((d) => [d.op, d.name, d.changes])).toEqual([
			["update", "web", ["image nginx:1.28 → nginx:1.29", "env MODE added"]],
			["create", "worker", ["new application from acme/worker:2"]],
			["remove", "old", ["removed; its volumes are kept"]],
		]);
		const web = delta[0];
		if (web?.op !== "update") throw new Error("expected an update");
		// Only the changed top-level fields, with source and build together.
		expect(Object.keys(web.spec.set).sort()).toEqual(["build", "source"]);
	});

	test("a service deleted by hand is created again", () => {
		const plan = [app("web", "nginx:1.29")];
		expect(diffStack(plan, plan, members()).map((d) => d.op)).toEqual([
			"create",
		]);
	});

	test("a secret value change is reported without the value", () => {
		const after = {
			...db,
			env: [{ key: "POSTGRES_PASSWORD", value: "new", isSecret: true }],
		};
		const [d] = diffStack([db], [after], members(["db", "database"]));
		expect(d?.changes).toEqual(["env POSTGRES_PASSWORD changed"]);
		expect(JSON.stringify(d?.changes)).not.toContain("new");
	});

	test("changing kind is refused", () => {
		expect(() =>
			diffStack([db], [app("db", "postgres:17")], members(["db", "database"])),
		).toThrow(StackUpdateError);
	});
});

test("patchSpec keeps fields the compose never mentioned", () => {
	const current = {
		...(app("web", "nginx:1.28").spec as ApplicationSpec),
		resources: { memoryMb: 512 },
		replicas: 3,
	};
	const [d] = diffStack(
		[app("web", "nginx:1.28")],
		[
			app("web", "nginx:1.29", {
				spec: {
					...(app("web", "nginx:1.29").spec as ApplicationSpec),
					command: ["serve"],
				},
			}),
		],
		members(["web", "application"]),
	);
	if (d?.op !== "update") throw new Error("expected an update");
	expect(patchSpec(current, d.spec)).toEqual({
		...current,
		source: { type: "image", image: "nginx:1.29" },
		command: ["serve"],
	});
});

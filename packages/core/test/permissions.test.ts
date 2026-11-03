import { describe, expect, test } from "bun:test";
import type { PermissionAction } from "@logistack/contracts";
import { can, type Grant, type Resource } from "../src/permissions.ts";

// org1 > fldA > fldB > prj1 > env1 > svc1
//                         > env2 > svc2
// org1 > prj2 (no folder) > env3 > svc3
const org: Resource = { type: "organization", organizationId: "org1" };
const gitProvider: Resource = { type: "git_provider", organizationId: "org1" };
const prj1: Resource = {
	type: "project",
	organizationId: "org1",
	folderIds: ["fldA", "fldB"],
	projectId: "prj1",
};
const env1: Resource = { ...prj1, type: "environment", environmentId: "env1" };
const svc1: Resource = { ...env1, type: "service", serviceId: "svc1" };
const svc2: Resource = {
	...prj1,
	type: "service",
	environmentId: "env2",
	serviceId: "svc2",
};
const svc3: Resource = {
	type: "service",
	organizationId: "org1",
	projectId: "prj2",
	environmentId: "env3",
	serviceId: "svc3",
};

const grants: Grant[] = [
	{
		subjectId: "alice",
		scope: { kind: "organization", id: "org1" },
		role: "owner",
	},
	{
		subjectId: "dave",
		scope: { kind: "organization", id: "org1" },
		role: "admin",
	},
	{
		subjectId: "bob",
		scope: { kind: "folder", id: "fldA" },
		role: "developer",
	},
	{
		subjectId: "carol",
		scope: { kind: "project", id: "prj2" },
		role: "viewer",
	},
	{
		subjectId: "erin",
		scope: { kind: "environment", id: "env1" },
		role: { id: "deployer", actions: ["deploy"] },
	},
	{
		subjectId: "frank",
		scope: { kind: "service", id: "svc1" },
		role: "developer",
	},
	{
		subjectId: "ghost",
		scope: { kind: "organization", id: "org2" },
		role: "owner",
	},
	{
		subjectId: "sec",
		scope: { kind: "project", id: "prj1" },
		role: { id: "auditor", actions: ["read", "read:secrets", "delete"] },
	},
];

const cases: [
	actor: string,
	action: PermissionAction,
	resource: Resource,
	expected: boolean,
	why: string,
][] = [
	["alice", "delete", org, true, "owner deletes the org"],
	["alice", "read:secrets", svc3, true, "owner reads secrets everywhere"],
	["dave", "delete", org, false, "admin cannot delete the org"],
	["dave", "admin", org, true, "admin administers the org"],
	["dave", "delete", prj1, true, "admin deletes projects"],
	["dave", "delete", gitProvider, true, "admin deletes org-level resources"],
	["dave", "read:secrets", svc1, true, "admin reads secrets"],
	[
		"bob",
		"deploy",
		svc1,
		true,
		"folder grant reaches through subfolder to service",
	],
	["bob", "write", env1, true, "developer writes below its folder"],
	["bob", "read:secrets", svc1, false, "developer lacks read:secrets"],
	["bob", "delete", svc1, false, "developer cannot delete"],
	[
		"bob",
		"deploy",
		svc3,
		false,
		"folder grant does not reach a project outside it",
	],
	["bob", "read", org, false, "folder grant does not reach upward"],
	["carol", "read", svc3, true, "viewer reads below its project"],
	["carol", "read:secrets", svc3, false, "read does not imply read:secrets"],
	["carol", "deploy", svc3, false, "viewer cannot deploy"],
	["carol", "read", svc1, false, "viewer of prj2 sees nothing in prj1"],
	[
		"erin",
		"deploy",
		svc1,
		true,
		"custom role action on env applies to its services",
	],
	[
		"erin",
		"deploy",
		svc2,
		false,
		"custom role does not reach a sibling environment",
	],
	["erin", "read", svc1, false, "custom role grants only its listed actions"],
	["frank", "write", svc1, true, "service-level grant"],
	[
		"frank",
		"write",
		env1,
		false,
		"service grant does not apply to its environment",
	],
	["sec", "read:secrets", svc2, true, "custom role with read:secrets"],
	["sec", "delete", svc1, true, "custom role delete on a service"],
	[
		"sec",
		"delete",
		org,
		false,
		"only owners delete the org, even with a custom delete",
	],
	["ghost", "read", svc1, false, "owner of another org has no access"],
	["nobody", "read", svc1, false, "no grants means no access"],
];

describe("can", () => {
	for (const [actor, action, resource, expected, why] of cases) {
		test(`${actor} ${action} ${resource.type} -> ${expected} (${why})`, () => {
			expect(can({ id: actor }, action, resource, grants)).toBe(expected);
		});
	}
});

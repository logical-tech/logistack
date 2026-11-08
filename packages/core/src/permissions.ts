import { type PermissionAction, permissionActions } from "@logistack/contracts";

export type ScopeKind =
	| "organization"
	| "folder"
	| "project"
	| "environment"
	| "service";
export type Scope = { kind: ScopeKind; id: string };

/**
 * A resource located by its full ancestry. Fill every level above the resource
 * (both folder ids when the project sits in a subfolder) and none below it.
 */
export type Resource = {
	/** `"organization"` for the organization itself, otherwise the resource's own type. */
	type: ScopeKind | (string & {});
	organizationId: string;
	/** Outermost first. */
	folderIds?: readonly string[];
	projectId?: string;
	environmentId?: string;
	serviceId?: string;
};

export type BuiltinRole =
	| "owner"
	| "admin"
	| "developer"
	| "viewer"
	/** Project manager: Work only, no ops `read`. */
	| "manager"
	/** Reads and comments on Work; granted on a project scope only. */
	| "guest";
export type CustomRole = { id: string; actions: readonly PermissionAction[] };
export type Grant = {
	subjectId: string;
	scope: Scope;
	role: BuiltinRole | CustomRole;
};
export type Actor = { id: string };

const builtinActions: Record<BuiltinRole, readonly PermissionAction[]> = {
	owner: permissionActions,
	admin: permissionActions,
	developer: ["read", "deploy", "write", "read:work", "work"],
	viewer: ["read", "read:work", "comment:work"],
	manager: ["read:work", "work", "work:admin"],
	guest: ["read:work", "comment:work"],
};

/** Holding the key implies each listed action, so a custom role may list just `work`. */
const implied: Partial<Record<PermissionAction, readonly PermissionAction[]>> =
	{
		"comment:work": ["work"],
		"read:work": ["comment:work", "work"],
	};

function ancestry(r: Resource): Set<string> {
	const keys = [`organization:${r.organizationId}`];
	for (const id of r.folderIds ?? []) keys.push(`folder:${id}`);
	if (r.projectId) keys.push(`project:${r.projectId}`);
	if (r.environmentId) keys.push(`environment:${r.environmentId}`);
	if (r.serviceId) keys.push(`service:${r.serviceId}`);
	return new Set(keys);
}

function allows(
	role: Grant["role"],
	action: PermissionAction,
	resource: Resource,
): boolean {
	// Deleting the organization itself is reserved to owners, whatever other roles hold.
	if (action === "delete" && resource.type === "organization")
		return role === "owner";
	const actions =
		typeof role === "string" ? builtinActions[role] : role.actions;
	return (
		actions.includes(action) ||
		(implied[action]?.some((a) => actions.includes(a)) ?? false)
	);
}

/** True when `role` allows `action` somewhere below the organization (used for shell surfaces). */
export const roleAllows = (role: Grant["role"], action: PermissionAction) =>
	allows(role, action, { type: "project", organizationId: "_" });

/** Allow-only: true when some grant held by `actor`, on the resource or an ancestor scope, includes `action`. */
export function can(
	actor: Actor,
	action: PermissionAction,
	resource: Resource,
	grants: readonly Grant[],
): boolean {
	const chain = ancestry(resource);
	return grants.some(
		(g) =>
			g.subjectId === actor.id &&
			chain.has(`${g.scope.kind}:${g.scope.id}`) &&
			allows(g.role, action, resource),
	);
}

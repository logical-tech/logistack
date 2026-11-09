import { createRoute, z } from "@hono/zod-openapi";
import { PermissionAction, permissionActions } from "@logistack/contracts";
import {
	instanceSettings,
	invitation,
	invitationGrant,
	member,
	organization,
	organizationRole,
	passkey,
	roleGrant,
	user,
} from "@logistack/db";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Context } from "hono";
import {
	actionsOf,
	assertEmailVouched,
	assertGuestScope,
	assertOwnershipChange,
	builtinRoleNames,
	customRoleRow,
	resolveRole,
	scopeLabel,
	scopeResource,
} from "../access.ts";
import { customActions, KeyScope, requireActor } from "../actor.ts";
import { auditInTx, mutation } from "../audit.ts";
import type { Env } from "../env.ts";
import { Failure, notFound, one } from "../errors.ts";
import { body, errors, IdParam, json, router, security } from "../openapi.ts";
import { check, inOrganization, requirePermission } from "../scope.ts";
import { sendInstanceMail } from "../work/notify.ts";

const Role = z
	.object({
		name: z.string(),
		builtin: z.boolean(),
		actions: z.array(z.string()),
		/** Members, service accounts and scoped grants holding it. */
		usage: z.int(),
	})
	.openapi("Role");

const Member = z
	.object({
		id: z.string(),
		userId: z.string(),
		name: z.string(),
		email: z.string(),
		role: z.string(),
		twoFactorEnabled: z.boolean(),
		/** Has at least one passkey, which satisfies a two-factor requirement on its own. */
		passkey: z.boolean(),
		createdAt: z.string(),
	})
	.openapi("Member");

const Invitation = z
	.object({
		id: z.string(),
		email: z.string(),
		role: z.string(),
		status: z.string(),
		expiresAt: z.string(),
		createdAt: z.string(),
		/** Send this to the invitee: it signs them up or in, then joins them. */
		url: z.string(),
	})
	.openapi("Invitation");

const RoleGrant = KeyScope.extend({
	id: z.string(),
	userId: z.string(),
	scopeLabel: z.string(),
	createdAt: z.string(),
}).openapi("RoleGrant");

const RoleInput = z.object({ role: z.string().min(1) });

const CustomRoleName = z
	.string()
	.regex(
		/^[a-z][a-z0-9-]{0,31}$/,
		"lowercase letters, digits and dashes, starting with a letter",
	)
	.refine(
		(n) => !(builtinRoleNames as string[]).includes(n) && n !== "member",
		"that name is a built-in role",
	);

const Actions = z.array(PermissionAction).min(1);

const NameParam = z.object({ name: z.string() });

const INVITATION_DAYS = 7;

async function memberRow(c: Context<Env>, id: string) {
	const rows = await c.var.deps.db
		.select({ id: member.id, userId: member.userId, role: member.role })
		.from(member)
		.where(
			and(
				eq(member.id, id),
				eq(member.organizationId, requireActor(c).organizationId),
			),
		);
	return one(rows, "member");
}

async function invitationUrl(c: Context<Env>, id: string) {
	const [s] = await c.var.deps.db
		.select({ publicUrl: instanceSettings.publicUrl })
		.from(instanceSettings)
		.where(eq(instanceSettings.id, "singleton"));
	const base = s?.publicUrl ?? c.var.deps.config.WEB_ORIGIN;
	return new URL(`/accept-invitation/${id}`, base).href;
}

/** Emails the link when instance mail is set up; otherwise the inviter shares it by hand. */
async function sendInvitationEmail(c: Context<Env>, to: string, url: string) {
	const { db } = c.var.deps;
	const actor = requireActor(c);
	const [who] = await db
		.select({ name: user.name, org: organization.name })
		.from(user)
		.innerJoin(organization, eq(organization.id, actor.organizationId))
		.where(eq(user.id, actor.userId));
	const inviter = who?.name ?? "Someone";
	const org = who?.org ?? "LogiStack";
	await sendInstanceMail(c.var.deps, {
		to,
		subject: `${inviter} invited you to ${org} on LogiStack`,
		text: `${inviter} invited you to join ${org} on LogiStack.\n\nAccept the invitation: ${url}\n\nThe link expires in ${INVITATION_DAYS} days.`,
	});
}

export const members = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/members",
			tags: ["members"],
			security,
			summary: "People in the organization (service accounts are listed apart)",
			middleware: [requirePermission("read", inOrganization)],
			responses: { 200: json(z.array(Member), "Members"), ...errors },
		}),
		async (c) => {
			const rows = await c.var.deps.db
				.select({
					id: member.id,
					userId: member.userId,
					name: user.name,
					email: user.email,
					role: member.role,
					twoFactorEnabled: sql<boolean>`coalesce(${user.twoFactorEnabled}, false)`,
					passkey: sql<boolean>`exists (select 1 from ${passkey} where ${passkey.userId} = ${user.id})`,
					createdAt: member.createdAt,
				})
				.from(member)
				.innerJoin(user, eq(user.id, member.userId))
				.where(
					and(
						eq(member.organizationId, requireActor(c).organizationId),
						eq(user.kind, "human"),
					),
				)
				.orderBy(member.createdAt);
			return c.json(rows, 200);
		},
	)
	.openapi(
		mutation(
			"member.create",
			createRoute({
				method: "post",
				path: "/members",
				tags: ["members"],
				security,
				summary: "Add an existing user to the organization",
				middleware: [requirePermission("admin", inOrganization)],
				request: body(RoleInput.extend({ email: z.email().toLowerCase() })),
				responses: { 201: json(Member, "Added"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const orgId = requireActor(c).organizationId;
			assertGuestScope(input.role, "organization");
			await resolveRole(c, input.role);
			await assertOwnershipChange(c, undefined, input.role);
			const u = one(
				await db
					.select({
						id: user.id,
						name: user.name,
						email: user.email,
						twoFactorEnabled: user.twoFactorEnabled,
						passkey: sql<boolean>`exists (select 1 from ${passkey} where ${passkey.userId} = ${user.id})`,
					})
					.from(user)
					.where(and(eq(user.email, input.email), eq(user.kind, "human"))),
				"user",
			);
			await assertEmailVouched(c, u.id);
			const existing = await db.$count(
				member,
				and(eq(member.organizationId, orgId), eq(member.userId, u.id)),
			);
			if (existing > 0) throw new Failure("conflict", "already a member");
			const row = await db.transaction(async (tx) => {
				const row = one(
					await tx
						.insert(member)
						.values({
							id: crypto.randomUUID(),
							organizationId: orgId,
							userId: u.id,
							role: input.role,
							createdAt: new Date(),
						})
						.returning(),
				);
				await auditInTx(c, tx, { resourceId: row.id });
				return row;
			});
			return c.json(
				{
					...row,
					name: u.name,
					email: u.email,
					twoFactorEnabled: u.twoFactorEnabled ?? false,
					passkey: u.passkey,
				},
				201,
			);
		},
	)
	.openapi(
		mutation(
			"member.update",
			createRoute({
				method: "patch",
				path: "/members/{id}",
				tags: ["members"],
				security,
				summary: "Change a member's organization-wide role",
				middleware: [requirePermission("admin", inOrganization)],
				request: { params: IdParam, ...body(RoleInput) },
				responses: {
					200: json(z.object({ id: z.string(), role: z.string() }), "Updated"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { role } = c.req.valid("json");
			c.set("auditResourceId", id);
			const current = await memberRow(c, id);
			assertGuestScope(role, "organization");
			await resolveRole(c, role);
			await assertOwnershipChange(c, current.role, role);
			await c.var.deps.db.transaction(async (tx) => {
				await tx.update(member).set({ role }).where(eq(member.id, id));
				await auditInTx(c, tx, {
					diff: { before: { role: current.role }, after: { role } },
				});
			});
			return c.json({ id, role }, 200);
		},
	)
	.openapi(
		mutation(
			"member.delete",
			createRoute({
				method: "delete",
				path: "/members/{id}",
				tags: ["members"],
				security,
				summary: "Remove a member and their scoped grants",
				middleware: [requirePermission("admin", inOrganization)],
				request: { params: IdParam },
				responses: { 204: { description: "Removed" }, ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			c.set("auditResourceId", id);
			const current = await memberRow(c, id);
			await assertOwnershipChange(c, current.role, undefined);
			const orgId = requireActor(c).organizationId;
			await c.var.deps.db.transaction(async (tx) => {
				await tx
					.delete(roleGrant)
					.where(
						and(
							eq(roleGrant.userId, current.userId),
							eq(roleGrant.organizationId, orgId),
						),
					);
				await tx.delete(member).where(eq(member.id, id));
				await auditInTx(c, tx);
			});
			return c.body(null, 204);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/invitations",
			tags: ["members"],
			security,
			summary: "Pending invitations",
			middleware: [requirePermission("admin", inOrganization)],
			responses: { 200: json(z.array(Invitation), "Invitations"), ...errors },
		}),
		async (c) => {
			const rows = await c.var.deps.db
				.select()
				.from(invitation)
				.where(
					and(
						eq(invitation.organizationId, requireActor(c).organizationId),
						eq(invitation.status, "pending"),
						gt(invitation.expiresAt, new Date()),
					),
				)
				.orderBy(asc(invitation.createdAt));
			return c.json(
				await Promise.all(
					rows.map(async (r) => ({
						id: r.id,
						email: r.email,
						role: r.role ?? "viewer",
						status: r.status,
						expiresAt: r.expiresAt.toISOString(),
						createdAt: r.createdAt.toISOString(),
						url: await invitationUrl(c, r.id),
					})),
				),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"invitation.create",
			createRoute({
				method: "post",
				path: "/invitations",
				tags: ["members"],
				security,
				summary: "Invite someone by email",
				description: `Creates a better-auth invitation valid for ${INVITATION_DAYS} days. LogiStack emails the link when instance mail is set up; otherwise share the returned \`url\`. The invitee accepts with better-auth's \`organization/accept-invitation\`.`,
				middleware: [requirePermission("admin", inOrganization)],
				request: body(
					RoleInput.extend({
						email: z.email().toLowerCase(),
						/**
						 * Scoped grants created on acceptance. With `role: "guest"` the invitee gets no
						 * organization-wide access, only these (a guest on one project).
						 */
						grants: z.array(KeyScope).max(20).optional(),
					}),
				),
				responses: { 201: json(Invitation, "Invited"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const actor = requireActor(c);
			const { db } = c.var.deps;
			const grants = input.grants ?? [];
			// A guest member holds nothing organization-wide, so it needs at least one scoped grant.
			if (input.role !== "guest" || !grants.length)
				assertGuestScope(input.role, "organization");
			await resolveRole(c, input.role);
			await assertOwnershipChange(c, undefined, input.role);
			for (const g of grants) {
				if (g.role === "owner")
					throw new Failure("bad_request", "ownership is organization-wide");
				assertGuestScope(g.role, g.scope.kind);
				await resolveRole(c, g.role);
				await scopeResource(c, g.scope);
			}
			const already = await db
				.select({ id: member.id })
				.from(member)
				.innerJoin(user, eq(user.id, member.userId))
				.where(
					and(
						eq(member.organizationId, actor.organizationId),
						eq(user.email, input.email),
					),
				);
			if (already.length > 0) throw new Failure("conflict", "already a member");
			const id = crypto.randomUUID();
			const row = one(
				await db.transaction(async (tx) => {
					await auditInTx(c, tx, { resourceId: id });
					// Re-inviting replaces the pending invitation instead of stacking a second one.
					await tx
						.update(invitation)
						.set({ status: "canceled" })
						.where(
							and(
								eq(invitation.organizationId, actor.organizationId),
								eq(invitation.email, input.email),
								eq(invitation.status, "pending"),
							),
						);
					const rows = await tx
						.insert(invitation)
						.values({
							id,
							organizationId: actor.organizationId,
							email: input.email,
							role: input.role,
							status: "pending",
							expiresAt: new Date(Date.now() + INVITATION_DAYS * 86_400_000),
							inviterId: actor.userId,
						})
						.returning();
					if (grants.length)
						await tx
							.insert(invitationGrant)
							.values(
								grants.map((g) => ({
									invitationId: id,
									role: g.role,
									scopeKind: g.scope.kind,
									scopeId: g.scope.id,
								})),
							)
							.onConflictDoNothing();
					return rows;
				}),
			);
			const url = await invitationUrl(c, id);
			await sendInvitationEmail(c, input.email, url);
			return c.json(
				{
					id,
					email: row.email,
					role: input.role,
					status: row.status,
					expiresAt: row.expiresAt.toISOString(),
					createdAt: row.createdAt.toISOString(),
					url,
				},
				201,
			);
		},
	)
	.openapi(
		mutation(
			"invitation.delete",
			createRoute({
				method: "delete",
				path: "/invitations/{id}",
				tags: ["members"],
				security,
				summary: "Cancel a pending invitation",
				middleware: [requirePermission("admin", inOrganization)],
				request: { params: IdParam },
				responses: { 204: { description: "Canceled" }, ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			c.set("auditResourceId", id);
			await c.var.deps.db.transaction(async (tx) => {
				one(
					await tx
						.update(invitation)
						.set({ status: "canceled" })
						.where(
							and(
								eq(invitation.id, id),
								eq(invitation.organizationId, requireActor(c).organizationId),
							),
						)
						.returning({ id: invitation.id }),
					"invitation",
				);
				await auditInTx(c, tx);
			});
			return c.body(null, 204);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/grants",
			tags: ["members"],
			security,
			summary: "Scoped role grants of members and service accounts",
			middleware: [requirePermission("read", inOrganization)],
			request: { query: z.object({ userId: z.string().optional() }) },
			responses: { 200: json(z.array(RoleGrant), "Grants"), ...errors },
		}),
		async (c) => {
			const { userId } = c.req.valid("query");
			const rows = await c.var.deps.db
				.select()
				.from(roleGrant)
				.where(
					and(
						eq(roleGrant.organizationId, requireActor(c).organizationId),
						userId ? eq(roleGrant.userId, userId) : undefined,
					),
				)
				.orderBy(asc(roleGrant.createdAt));
			return c.json(
				await Promise.all(
					rows.map(async (g) => {
						const scope = { kind: g.scopeKind, id: g.scopeId };
						return {
							id: g.id,
							userId: g.userId,
							role: g.role,
							scope,
							scopeLabel: await scopeLabel(c, scope),
							createdAt: g.createdAt.toISOString(),
						};
					}),
				),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"grant.create",
			createRoute({
				method: "post",
				path: "/grants",
				tags: ["members"],
				security,
				summary: "Give a member or service account a role on one scope",
				description:
					"Needs `admin` on the scope itself. The grant applies to everything below the scope: a developer on a folder can deploy every service of every project in it.",
				request: body(KeyScope.extend({ userId: z.string() })),
				responses: { 201: json(RoleGrant, "Granted"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const actor = requireActor(c);
			const { db } = c.var.deps;
			check(c, "admin", await scopeResource(c, input.scope));
			if (input.role === "owner")
				throw new Failure(
					"bad_request",
					"ownership is organization-wide; change the member's role instead",
				);
			assertGuestScope(input.role, input.scope.kind);
			await resolveRole(c, input.role);
			const isMember = await db.$count(
				member,
				and(
					eq(member.organizationId, actor.organizationId),
					eq(member.userId, input.userId),
				),
			);
			if (isMember === 0) throw notFound("member");
			const row = await db.transaction(async (tx) => {
				const row = one(
					await tx
						.insert(roleGrant)
						.values({
							organizationId: actor.organizationId,
							userId: input.userId,
							role: input.role,
							scopeKind: input.scope.kind,
							scopeId: input.scope.id,
							createdBy: actor.userId,
						})
						.returning(),
				);
				await auditInTx(c, tx, { resourceId: row.id });
				return row;
			});
			return c.json(
				{
					id: row.id,
					userId: row.userId,
					role: row.role,
					scope: input.scope,
					scopeLabel: await scopeLabel(c, input.scope),
					createdAt: row.createdAt.toISOString(),
				},
				201,
			);
		},
	)
	.openapi(
		mutation(
			"grant.delete",
			createRoute({
				method: "delete",
				path: "/grants/{id}",
				tags: ["members"],
				security,
				summary: "Revoke a scoped grant",
				request: { params: IdParam },
				responses: { 204: { description: "Revoked" }, ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { db } = c.var.deps;
			c.set("auditResourceId", id);
			const g = one(
				await db
					.select()
					.from(roleGrant)
					.where(
						and(
							eq(roleGrant.id, id),
							eq(roleGrant.organizationId, requireActor(c).organizationId),
						),
					),
				"grant",
			);
			const scope = { kind: g.scopeKind, id: g.scopeId };
			// A grant whose scope is gone can be cleaned up by an organization admin.
			const resource = await scopeResource(c, scope).catch(() =>
				scopeResource(c, {
					kind: "organization",
					id: requireActor(c).organizationId,
				}),
			);
			check(c, "admin", resource);
			await db.transaction(async (tx) => {
				await tx.delete(roleGrant).where(eq(roleGrant.id, id));
				await auditInTx(c, tx, {
					diff: { before: { role: g.role, scope, userId: g.userId } },
				});
			});
			return c.body(null, 204);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/roles",
			tags: ["roles"],
			security,
			summary: "Built-in and custom roles with the actions each allows",
			middleware: [requirePermission("read", inOrganization)],
			responses: { 200: json(z.array(Role), "Roles"), ...errors },
		}),
		async (c) => {
			const { db } = c.var.deps;
			const orgId = requireActor(c).organizationId;
			const [custom, memberRoles, grantRoles] = await Promise.all([
				db
					.select({
						name: organizationRole.role,
						permission: organizationRole.permission,
					})
					.from(organizationRole)
					.where(eq(organizationRole.organizationId, orgId))
					.orderBy(asc(organizationRole.createdAt)),
				db
					.select({ role: member.role })
					.from(member)
					.where(eq(member.organizationId, orgId)),
				db
					.select({ role: roleGrant.role })
					.from(roleGrant)
					.where(eq(roleGrant.organizationId, orgId)),
			]);
			const usage = (name: string) =>
				memberRoles.filter((m) =>
					m.role.split(",").some((r) => r.trim() === name),
				).length + grantRoles.filter((g) => g.role === name).length;
			return c.json(
				[
					...builtinRoleNames.map((name) => ({
						name,
						builtin: true,
						actions: actionsOf(name),
						usage: usage(name),
					})),
					// Plugin service accounts' roles (`plugin:…`) belong to their install, not to people.
					...custom
						.filter((r) => !r.name.startsWith("plugin:"))
						.map((r) => ({
							name: r.name,
							builtin: false,
							actions: customActions(r.permission),
							usage: usage(r.name),
						})),
				],
				200,
			);
		},
	)
	.openapi(
		mutation(
			"role.create",
			createRoute({
				method: "post",
				path: "/roles",
				tags: ["roles"],
				security,
				summary: "Create a custom role",
				middleware: [requirePermission("admin", inOrganization)],
				request: body(z.object({ name: CustomRoleName, actions: Actions })),
				responses: { 201: json(Role, "Created"), ...errors },
			}),
		),
		async (c) => {
			const { name, actions } = c.req.valid("json");
			const orgId = requireActor(c).organizationId;
			const exists = await c.var.deps.db.$count(
				organizationRole,
				and(
					eq(organizationRole.organizationId, orgId),
					eq(organizationRole.role, name),
				),
			);
			if (exists > 0) throw new Failure("conflict", `role '${name}' exists`);
			const ordered = permissionActions.filter((a) => actions.includes(a));
			await c.var.deps.db.transaction(async (tx) => {
				const row = one(
					await tx
						.insert(organizationRole)
						.values({
							id: crypto.randomUUID(),
							organizationId: orgId,
							role: name,
							permission: JSON.stringify({ logistack: ordered }),
						})
						.returning(),
				);
				await auditInTx(c, tx, { resourceId: row.id });
			});
			return c.json({ name, builtin: false, actions: ordered, usage: 0 }, 201);
		},
	)
	.openapi(
		mutation(
			"role.update",
			createRoute({
				method: "patch",
				path: "/roles/{name}",
				tags: ["roles"],
				security,
				summary: "Change a custom role's actions",
				description:
					"Applies at once to every member, service account and grant holding the role.",
				middleware: [requirePermission("admin", inOrganization)],
				request: { params: NameParam, ...body(z.object({ actions: Actions })) },
				responses: {
					200: json(
						z.object({ name: z.string(), actions: z.array(z.string()) }),
						"Updated",
					),
					...errors,
				},
			}),
		),
		async (c) => {
			const { name } = c.req.valid("param");
			const { actions } = c.req.valid("json");
			const row = await customRoleRow(c, name);
			c.set("auditResourceId", row.id);
			const ordered = permissionActions.filter((a) => actions.includes(a));
			await c.var.deps.db.transaction(async (tx) => {
				await tx
					.update(organizationRole)
					.set({ permission: JSON.stringify({ logistack: ordered }) })
					.where(eq(organizationRole.id, row.id));
				await auditInTx(c, tx, {
					diff: {
						before: { actions: customActions(row.permission) },
						after: { actions: ordered },
					},
				});
			});
			return c.json({ name, actions: ordered }, 200);
		},
	)
	.openapi(
		mutation(
			"role.delete",
			createRoute({
				method: "delete",
				path: "/roles/{name}",
				tags: ["roles"],
				security,
				summary: "Delete a custom role nobody holds",
				middleware: [requirePermission("admin", inOrganization)],
				request: { params: NameParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const { name } = c.req.valid("param");
			const { db } = c.var.deps;
			const orgId = requireActor(c).organizationId;
			const row = await customRoleRow(c, name);
			c.set("auditResourceId", row.id);
			const [held, granted] = await Promise.all([
				db
					.select({ role: member.role })
					.from(member)
					.where(eq(member.organizationId, orgId)),
				db.$count(
					roleGrant,
					and(eq(roleGrant.organizationId, orgId), eq(roleGrant.role, name)),
				),
			]);
			const holders = held.filter((m) =>
				m.role.split(",").some((r) => r.trim() === name),
			).length;
			if (holders + granted > 0)
				throw new Failure(
					"conflict",
					`role '${name}' is held by ${holders + granted} member(s) or grant(s)`,
				);
			await db.transaction(async (tx) => {
				await tx
					.delete(organizationRole)
					.where(eq(organizationRole.id, row.id));
				await auditInTx(c, tx);
			});
			return c.body(null, 204);
		},
	);

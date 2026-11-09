import { createRoute, z } from "@hono/zod-openapi";
import {
	ClickUpConnection,
	ClickUpInspection,
	ClickUpInspectRequest,
	ClickUpToken,
	ClickUpTreeRequest,
	CsvImportConfig,
	CsvUpload,
	WorkGuestInvite,
	WorkGuestInvited,
	WorkImport,
	WorkImportCreate,
	type WorkRouteName,
	WorkShare,
	WorkShareCreate,
	WorkShareCreated,
	workRoutes,
} from "@logistack/contracts";
import {
	decrypt,
	detectDelimiter,
	encrypt,
	parseCsv,
	roleAllows,
} from "@logistack/core";
import {
	environment,
	instanceSettings,
	invitation,
	invitationGrant,
	member,
	project,
	user,
	workField,
	workImport,
	workImportMap,
	workList,
	workProject,
	workShare,
	workView,
} from "@logistack/db";
import { ProviderError } from "@logistack/providers";
import {
	ClickUpApi,
	clickUpInspect,
	clickUpTree,
	testClickUp,
	WORK_IMPORT_JOB,
	type WorkImportJob,
} from "@logistack/worker/work-import";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Context } from "hono";
import { scopeResource } from "../../access.ts";
import { type Actor, requireActor } from "../../actor.ts";
import { auditInTx, mutation } from "../../audit.ts";
import type { Env } from "../../env.ts";
import { Failure, notFound } from "../../errors.ts";
import {
	body,
	errors,
	json,
	router,
	security,
	slugify,
} from "../../openapi.ts";
import { redisFor } from "../../redis.ts";
import { runQueues } from "../../run-queues.ts";
import { actorCan, check, locate, organizationResource } from "../../scope.ts";
import { checkWork, ensureWorkProject } from "../../work/context.ts";
import {
	newShareToken,
	sharePages,
	shareTokenHash,
} from "../../work/share-pages.ts";

/**
 * Work extras: ClickUp and CSV imports (12.5, 12.6), read-only share links (12.7) and guest
 * invitations (12.8). One router: the `/api/work/*` routes from `workRoutes` plus the public
 * `/share/<token>` pages.
 */

/**
 * OpenAPI fields of a `workRoutes` entry. Method and path are repeated as literals so the typed
 * client keeps them; a mismatch with the contract throws at startup.
 */
const route = <M extends "get" | "post" | "delete", P extends string>(
	name: WorkRouteName,
	method: M,
	path: P,
) => {
	const r = workRoutes[name];
	if (
		r.method.toLowerCase() !== method ||
		r.path.replace(/:(\w+)/g, "{$1}") !== path
	)
		throw new Error(`work route ${name} drifted from the contract`);
	return { method, path, operationId: r.operationId, tags: ["work"], security };
};

const IdParam = z.object({ id: z.string() });
const TreeNodeDoc = z.object({
	id: z.string(),
	type: z.enum(["space", "folder", "list"]),
	name: z.string(),
	taskCount: z.number().int().nullable(),
	archived: z.boolean(),
	/** Nested nodes of the same shape. */
	children: z.array(z.unknown()),
});
const CSV_MAX_BYTES = 10 * 1024 * 1024;
const CSV_TTL_SEC = 24 * 3600;
const csvKey = (orgId: string, uploadId: string) =>
	`ls:work:csv:${orgId}:${uploadId}`;

/** Holds `action` on some scope, a scoped key's own scopes included: the org-level gate of cross-project routes. */
async function requireSomewhere(
	c: Context<Env>,
	action: "work:admin" | "work",
) {
	const actor = requireActor(c);
	// Where both the grants and the key allow it, the key's scopes (each within a grant) witness it.
	for (const g of actor.keyScopes ?? actor.grants) {
		if (!roleAllows(g.role, action)) continue;
		const resource = await scopeResource(c, g.scope).catch(() => null);
		if (resource && actorCan(actor, action, resource)) return actor;
	}
	throw new Failure("forbidden", `missing permission '${action}'`);
}

const orgAdmin = (actor: Actor) =>
	actorCan(actor, "work:admin", organizationResource(actor.organizationId));

async function publicBase(c: Context<Env>) {
	const [s] = await c.var.deps.db
		.select({ publicUrl: instanceSettings.publicUrl })
		.from(instanceSettings)
		.where(eq(instanceSettings.id, "singleton"));
	return s?.publicUrl ?? c.var.deps.config.WEB_ORIGIN;
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

type ImportRow = typeof workImport.$inferSelect;

const importDto = (r: ImportRow): WorkImport => ({
	id: r.id,
	kind: r.kind,
	status: r.status,
	createdBy: r.createdBy,
	plan: r.plan,
	progress: r.progress,
	report: r.report,
	startedAt: r.startedAt?.toISOString() ?? null,
	finishedAt: r.finishedAt?.toISOString() ?? null,
	createdAt: r.createdAt.toISOString(),
});

/** The import, visible to its creator and to org-wide Work admins. */
async function loadImport(c: Context<Env>, id: string) {
	const actor = await requireSomewhere(c, "work:admin");
	const [row] = await c.var.deps.db
		.select()
		.from(workImport)
		.where(
			and(
				eq(workImport.id, id),
				eq(workImport.organizationId, actor.organizationId),
			),
		);
	if (!row || (row.createdBy !== actor.userId && !orgAdmin(actor)))
		throw notFound("import");
	return row;
}

function clickUpApi(token: string) {
	return new ClickUpApi({ token });
}

/** ClickUp's 401 is the user's token, not our session. */
async function clickUp<T>(f: () => Promise<T>): Promise<T> {
	try {
		return await f();
	} catch (e) {
		if (e instanceof ProviderError)
			throw new Failure(
				"bad_request",
				e.status === 401
					? "ClickUp rejected the token"
					: `ClickUp: ${e.message}`,
			);
		throw e;
	}
}

/** Permission on every target: `work:admin` on existing projects, `write` where a new one goes. */
async function checkTargets(
	c: Context<Env>,
	input: z.output<typeof WorkImportCreate>,
) {
	const { db } = c.var.deps;
	const orgId = requireActor(c).organizationId;
	if (input.kind === "csv") {
		const [l] = await db
			.select({ projectId: workList.projectId })
			.from(workList)
			.where(eq(workList.id, input.config.listId));
		if (!l) throw notFound("list");
		await checkWork(c, "work:admin", l.projectId);
		return;
	}
	for (const t of input.config.targets) {
		if (t.target.kind === "existing")
			await checkWork(c, "work:admin", t.target.projectId);
		else
			check(
				c,
				"write",
				t.target.folderId
					? await locate(db, orgId, "folder", t.target.folderId)
					: organizationResource(orgId),
			);
	}
}

/** Creates the "new project" targets (reusing ones a previous run created) and seeds their Work data. */
async function prepareTargets(c: Context<Env>, row: ImportRow) {
	const { db, masterKey } = c.var.deps;
	if (row.kind !== "clickup" || !row.configEncrypted) return;
	const cfg = JSON.parse(
		await decrypt(masterKey, row.configEncrypted),
	) as z.output<typeof WorkImportCreate>["config"] & {
		targets: {
			sourceId: string;
			target: {
				kind: string;
				name?: string;
				folderId?: string | null;
				projectId?: string;
			};
		}[];
		teamId: string;
	};
	let changed = false;
	for (const t of cfg.targets) {
		if (t.target.kind === "existing" && t.target.projectId) {
			await ensureWorkProject(db, t.target.projectId);
			continue;
		}
		const source = `clickup:${cfg.teamId}`;
		const [mapped] = await db
			.select({ localId: workImportMap.localId })
			.from(workImportMap)
			.innerJoin(project, eq(project.id, workImportMap.localId))
			.where(
				and(
					eq(workImportMap.organizationId, row.organizationId),
					eq(workImportMap.source, source),
					eq(workImportMap.externalType, "project"),
					eq(workImportMap.externalId, t.sourceId),
				),
			);
		let projectId = mapped?.localId;
		if (!projectId) {
			const name = t.target.name ?? "Imported";
			projectId = await db.transaction(async (tx) => {
				let slug = slugify(name);
				for (let n = 2; ; n++) {
					const [taken] = await tx
						.select({ id: project.id })
						.from(project)
						.where(
							and(
								eq(project.organizationId, row.organizationId),
								eq(project.slug, slug),
							),
						);
					if (!taken) break;
					slug = `${slugify(name).slice(0, 58)}-${n}`;
				}
				const [p] = await tx
					.insert(project)
					.values({
						organizationId: row.organizationId,
						folderId: t.target.folderId ?? null,
						name,
						slug,
					})
					.returning({ id: project.id });
				if (!p) throw new Error("project insert failed");
				await tx.insert(environment).values({
					projectId: p.id,
					name: "Production",
					slug: "production",
					kind: "production",
					isDefault: true,
				});
				await tx
					.insert(workImportMap)
					.values({
						organizationId: row.organizationId,
						source,
						externalType: "project",
						externalId: t.sourceId,
						localId: p.id,
						localType: "project",
					})
					.onConflictDoUpdate({
						target: [
							workImportMap.organizationId,
							workImportMap.source,
							workImportMap.externalType,
							workImportMap.externalId,
						],
						set: { localId: p.id, updatedAt: new Date() },
					});
				return p.id;
			});
		}
		await ensureWorkProject(db, projectId);
		t.target = { kind: "existing", projectId };
		changed = true;
	}
	if (changed)
		await db
			.update(workImport)
			.set({ configEncrypted: await encrypt(masterKey, JSON.stringify(cfg)) })
			.where(eq(workImport.id, row.id));
}

async function enqueue(c: Context<Env>, data: WorkImportJob) {
	await runQueues(c.var.deps.config.REDIS_URL).work.add(WORK_IMPORT_JOB, data, {
		removeOnComplete: { count: 200 },
		removeOnFail: { count: 500 },
	});
}

// ---------------------------------------------------------------------------
// Shares
// ---------------------------------------------------------------------------

type ShareRow = typeof workShare.$inferSelect;
const shareDto = (s: ShareRow): WorkShare => ({
	id: s.id,
	projectId: s.projectId,
	listId: s.listId,
	viewId: s.viewId,
	name: s.name,
	showComments: s.showComments,
	showAssignees: s.showAssignees,
	fieldIds: s.fieldIds,
	hasPassword: !!s.passwordHash,
	expiresAt: s.expiresAt?.toISOString() ?? null,
	revokedAt: s.revokedAt?.toISOString() ?? null,
	lastViewedAt: s.lastViewedAt?.toISOString() ?? null,
	viewCount: s.viewCount,
	createdBy: s.createdBy,
	createdAt: s.createdAt.toISOString(),
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const workImportsSharesGuests = router()
	.openapi(
		createRoute({
			...route("importList", "get", "/api/work/imports"),
			summary: "Imports into Work",
			description: "Your own imports; org-wide Work admins see every import.",
			responses: { 200: json(z.array(WorkImport), "Imports"), ...errors },
		}),
		async (c) => {
			const actor = await requireSomewhere(c, "work:admin");
			const rows = await c.var.deps.db
				.select()
				.from(workImport)
				.where(
					and(
						eq(workImport.organizationId, actor.organizationId),
						orgAdmin(actor)
							? undefined
							: eq(workImport.createdBy, actor.userId),
					),
				)
				.orderBy(desc(workImport.createdAt))
				.limit(100);
			return c.json(rows.map(importDto), 200);
		},
	)
	.openapi(
		createRoute({
			...route("importGet", "get", "/api/work/imports/{id}"),
			summary: "One import with its plan, progress and report",
			request: { params: IdParam },
			responses: { 200: json(WorkImport, "Import"), ...errors },
		}),
		async (c) =>
			c.json(importDto(await loadImport(c, c.req.valid("param").id)), 200),
	)
	.openapi(
		mutation(
			"work_import.create",
			createRoute({
				...route("importCreate", "post", "/api/work/imports"),
				summary: "Create a draft import",
				description:
					"Stores the wizard's choices encrypted (the ClickUp token is wiped once a run ends). Needs `work:admin` on every existing target and `write` where a new project goes. A CSV import takes the file uploaded with `POST /imports/csv/upload`.",
				request: body(WorkImportCreate),
				responses: { 201: json(WorkImport, "Draft"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const actor = await requireSomewhere(c, "work:admin");
			await checkTargets(c, input);
			const { db, masterKey } = c.var.deps;
			let config: unknown = input.config;
			if (input.kind === "csv") {
				const text = await redisFor(c.var.deps.config.REDIS_URL).get(
					csvKey(actor.organizationId, input.config.uploadId),
				);
				if (!text)
					throw new Failure(
						"bad_request",
						"the uploaded file expired; upload it again",
					);
				config = { ...CsvImportConfig.parse(input.config), csv: text };
			}
			const row = await db.transaction(async (tx) => {
				const [r] = await tx
					.insert(workImport)
					.values({
						organizationId: actor.organizationId,
						kind: input.kind,
						createdBy: actor.userId,
						configEncrypted: await encrypt(masterKey, JSON.stringify(config)),
					})
					.returning();
				if (!r) throw new Error("import insert failed");
				await auditInTx(c, tx, {
					resourceId: r.id,
					diff: { kind: input.kind },
				});
				return r;
			});
			return c.json(importDto(row), 201);
		},
	)
	.openapi(
		mutation(
			"work_import.dry_run",
			createRoute({
				...route("importDryRun", "post", "/api/work/imports/{id}/dry-run"),
				summary: "Fetch and count without writing",
				description:
					"Queues a dry run; the import turns `ready` with its `plan`.",
				request: { params: IdParam },
				responses: { 202: json(WorkImport, "Queued"), ...errors },
			}),
		),
		async (c) => {
			const row = await loadImport(c, c.req.valid("param").id);
			if (!["draft", "ready", "failed"].includes(row.status))
				throw new Failure("conflict", `the import is ${row.status}`);
			await enqueue(c, { importId: row.id, dryRun: true });
			return c.json(importDto(row), 202);
		},
	)
	.openapi(
		mutation(
			"work_import.run",
			createRoute({
				...route("importRun", "post", "/api/work/imports/{id}/run"),
				summary: "Run the import",
				description:
					"Creates the new target projects, then queues the import. Progress arrives on the import (`progress`) and over the WebSocket; rerunning updates what an earlier run created.",
				request: { params: IdParam },
				responses: { 202: json(WorkImport, "Running"), ...errors },
			}),
		),
		async (c) => {
			const row = await loadImport(c, c.req.valid("param").id);
			if (!["draft", "ready", "failed"].includes(row.status))
				throw new Failure("conflict", `the import is ${row.status}`);
			if (row.finishedAt)
				throw new Failure(
					"conflict",
					"this import already ran; start a new one to import again",
				);
			await prepareTargets(c, row);
			const [running] = await c.var.deps.db
				.update(workImport)
				.set({
					status: "running",
					startedAt: new Date(),
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(workImport.id, row.id),
						inArray(workImport.status, ["draft", "ready", "failed"]),
					),
				)
				.returning();
			if (!running)
				throw new Failure("conflict", "the import is already running");
			await enqueue(c, { importId: row.id, dryRun: false });
			return c.json(importDto(running), 202);
		},
	)
	.openapi(
		mutation(
			"work_import.cancel",
			createRoute({
				...route("importCancel", "post", "/api/work/imports/{id}/cancel"),
				summary: "Cancel an import",
				description:
					"A running import stops after the entity it is writing; what it wrote stays.",
				request: { params: IdParam },
				responses: { 200: json(WorkImport, "Cancelled"), ...errors },
			}),
		),
		async (c) => {
			const row = await loadImport(c, c.req.valid("param").id);
			const [updated] = await c.var.deps.db
				.update(workImport)
				.set({
					status: "cancelled",
					finishedAt: new Date(),
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(workImport.id, row.id),
						inArray(workImport.status, ["draft", "ready", "running"]),
					),
				)
				.returning();
			if (!updated)
				throw new Failure("conflict", `the import is ${row.status}`);
			return c.json(importDto(updated), 200);
		},
	)
	.openapi(
		mutation(
			"work_import.clickup_test",
			createRoute({
				...route("clickupTest", "post", "/api/work/imports/clickup/test"),
				summary: "Test a ClickUp token",
				description:
					"Calls ClickUp's `GET /user` and `GET /team` with the token; nothing is stored.",
				request: body(ClickUpToken),
				responses: { 200: json(ClickUpConnection, "Connected"), ...errors },
			}),
		),
		async (c) => {
			await requireSomewhere(c, "work:admin");
			const { token } = c.req.valid("json");
			return c.json(await clickUp(() => testClickUp(clickUpApi(token))), 200);
		},
	)
	.openapi(
		mutation(
			"work_import.clickup_tree",
			createRoute({
				...route("clickupTree", "post", "/api/work/imports/clickup/tree"),
				summary: "ClickUp spaces, folders and lists",
				request: body(ClickUpTreeRequest),
				// The recursive `ClickUpTreeNode` overflows the OpenAPI generator; documented one level deep.
				responses: { 200: json(z.array(TreeNodeDoc), "Tree"), ...errors },
			}),
		),
		async (c) => {
			await requireSomewhere(c, "work:admin");
			const { token, teamId } = c.req.valid("json");
			return c.json(
				await clickUp(() => clickUpTree(clickUpApi(token), teamId)),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"work_import.clickup_inspect",
			createRoute({
				...route("clickupInspect", "post", "/api/work/imports/clickup/inspect"),
				summary: "Statuses, fields and people of ClickUp lists",
				description:
					"What the wizard maps in its Statuses, Fields and People steps, with a proposed mapping. People match org members by email.",
				request: body(ClickUpInspectRequest),
				responses: { 200: json(ClickUpInspection, "Inspection"), ...errors },
			}),
		),
		async (c) => {
			const actor = await requireSomewhere(c, "work:admin");
			const { token, teamId, listIds } = c.req.valid("json");
			const found = await clickUp(() =>
				clickUpInspect(clickUpApi(token), teamId, listIds),
			);
			// The org's directory is for org-wide Work admins; a project admin maps people by hand.
			const orgMembers = orgAdmin(actor)
				? await c.var.deps.db
						.select({ userId: user.id, name: user.name, email: user.email })
						.from(member)
						.innerJoin(user, eq(user.id, member.userId))
						.where(eq(member.organizationId, actor.organizationId))
				: [];
			const byEmail = new Map(
				orgMembers.map((m) => [m.email.toLowerCase(), m.userId]),
			);
			return c.json(
				{
					...found,
					members: found.members.map((m) => ({
						...m,
						matchUserId:
							(m.email && byEmail.get(m.email.toLowerCase())) || null,
					})),
					orgMembers,
				},
				200,
			);
		},
	)
	.openapi(
		mutation(
			"work_import.csv_upload",
			createRoute({
				...route("csvUpload", "post", "/api/work/imports/csv/upload"),
				summary: "Upload a CSV for import",
				description:
					"Multipart with a `file` field, up to 10 MB. Detects the delimiter (override with `?delimiter=`) and the encoding (UTF-8, else Windows-1252); returns the headers and the first 20 rows. The file is kept for 24 hours.",
				request: {
					query: z.object({ delimiter: z.string().length(1).optional() }),
				},
				responses: { 200: json(CsvUpload, "Parsed"), ...errors },
			}),
		),
		async (c) => {
			const actor = await requireSomewhere(c, "work:admin");
			const form = await c.req.parseBody();
			const file = form.file;
			if (!(file instanceof File))
				throw new Failure("bad_request", "send the CSV as a `file` form field");
			if (file.size > CSV_MAX_BYTES)
				throw new Failure(
					"payload_too_large",
					"CSV files are limited to 10 MB",
				);
			const bytes = new Uint8Array(await file.arrayBuffer());
			let text: string;
			let encoding: "utf-8" | "windows-1252" = "utf-8";
			try {
				text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			} catch {
				encoding = "windows-1252";
				text = new TextDecoder(encoding).decode(bytes);
			}
			const delimiter = c.req.valid("query").delimiter ?? detectDelimiter(text);
			const rows = parseCsv(text, delimiter);
			if (!rows.length)
				throw new Failure("bad_request", "the file has no rows");
			const uploadId = crypto.randomUUID();
			await redisFor(c.var.deps.config.REDIS_URL).set(
				csvKey(actor.organizationId, uploadId),
				text,
				"EX",
				CSV_TTL_SEC,
			);
			c.set("auditResourceId", uploadId);
			c.set("auditDiff", { name: file.name, size: file.size });
			return c.json(
				{
					uploadId,
					delimiter,
					encoding,
					headers: rows[0] ?? [],
					rows: rows.slice(1, 21),
					rowCount: rows.length - 1,
				},
				200,
			);
		},
	)
	.openapi(
		createRoute({
			...route("shareList", "get", "/api/work/projects/{id}/shares"),
			summary: "Share links of a project",
			request: { params: IdParam },
			responses: { 200: json(z.array(WorkShare), "Share links"), ...errors },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			await checkWork(c, "work", id);
			const rows = await c.var.deps.db
				.select()
				.from(workShare)
				.where(eq(workShare.projectId, id))
				.orderBy(desc(workShare.createdAt));
			return c.json(rows.map(shareDto), 200);
		},
	)
	.openapi(
		mutation(
			"work_share.create",
			createRoute({
				...route("shareCreate", "post", "/api/work/projects/{id}/shares"),
				summary: "Create a read-only share link",
				description:
					"Shares one list or one view, read-only, with anyone holding the link. Needs `allowShareLinks` on the project. The token is in `url` and shown only now.",
				request: { params: IdParam, ...body(WorkShareCreate) },
				responses: { 201: json(WorkShareCreated, "Created"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { actor } = await checkWork(c, "work", id);
			const { db } = c.var.deps;
			const wp = await ensureWorkProject(db, id);
			if (!wp.allowShareLinks)
				throw new Failure("conflict", "share links are off for this project");
			if (input.listId) {
				const [l] = await db
					.select({ id: workList.id })
					.from(workList)
					.where(
						and(eq(workList.id, input.listId), eq(workList.projectId, id)),
					);
				if (!l) throw notFound("list");
			}
			if (input.viewId) {
				const [v] = await db
					.select({ id: workView.id })
					.from(workView)
					.where(
						and(
							eq(workView.id, input.viewId),
							eq(workView.projectId, id),
							or(isNull(workView.ownerId), eq(workView.ownerId, actor.userId)),
						),
					);
				if (!v) throw notFound("view");
			}
			const fieldIds = [...new Set(input.fieldIds)];
			if (fieldIds.length) {
				const found = await db
					.select({ id: workField.id })
					.from(workField)
					.where(
						and(eq(workField.projectId, id), inArray(workField.id, fieldIds)),
					);
				if (found.length !== fieldIds.length)
					throw new Failure("bad_request", "a field isn't in this project");
			}
			const token = newShareToken();
			const row = await db.transaction(async (tx) => {
				const [r] = await tx
					.insert(workShare)
					.values({
						projectId: id,
						listId: input.listId ?? null,
						viewId: input.viewId ?? null,
						tokenHash: await shareTokenHash(token),
						createdBy: actor.userId,
						name: input.name,
						showComments: input.showComments,
						showAssignees: input.showAssignees,
						fieldIds,
						passwordHash: input.password
							? await Bun.password.hash(input.password, {
									algorithm: "argon2id",
								})
							: null,
						expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
					})
					.returning();
				if (!r) throw new Error("share insert failed");
				const { password: _, ...diff } = input;
				await auditInTx(c, tx, {
					resourceId: r.id,
					diff: { ...diff, password: !!input.password },
				});
				return r;
			});
			return c.json(
				{
					share: shareDto(row),
					url: new URL(`/share/${token}`, await publicBase(c)).href,
				},
				201,
			);
		},
	)
	.openapi(
		mutation(
			"work_share.revoke",
			createRoute({
				...route("shareRevoke", "delete", "/api/work/shares/{id}"),
				summary: "Revoke a share link",
				description:
					"Its creator or a Work admin of the project. The link stops working at once.",
				request: { params: IdParam },
				responses: { 204: { description: "Revoked" }, ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { db } = c.var.deps;
			const [s] = await db
				.select({
					projectId: workShare.projectId,
					createdBy: workShare.createdBy,
				})
				.from(workShare)
				.innerJoin(project, eq(project.id, workShare.projectId))
				.where(
					and(
						eq(workShare.id, id),
						eq(project.organizationId, requireActor(c).organizationId),
					),
				);
			if (!s) throw notFound("share link");
			const { actor, resource } = await checkWork(c, "work", s.projectId);
			if (s.createdBy !== actor.userId) check(c, "work:admin", resource);
			await db.transaction(async (tx) => {
				await tx
					.update(workShare)
					.set({
						revokedAt: sql`coalesce(${workShare.revokedAt}, now())`,
						updatedAt: new Date(),
					})
					.where(eq(workShare.id, id));
				await auditInTx(c, tx, { resourceId: id });
			});
			return c.body(null, 204);
		},
	)
	.openapi(
		mutation(
			"work_guest.invite",
			createRoute({
				...route("guestInvite", "post", "/api/work/projects/{id}/guests"),
				summary: "Invite a guest to one project",
				description:
					"Creates an invitation that joins the organization with no organization-wide access and grants the `guest` role on this project only. `canCreate` turns on the project's `guestsCanCreate`. LogiStack sends no email: share the returned `url`.",
				request: { params: IdParam, ...body(WorkGuestInvite) },
				responses: { 201: json(WorkGuestInvited, "Invited"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { actor } = await checkWork(c, "work:admin", id);
			const { db } = c.var.deps;
			const email = input.email.toLowerCase();
			const already = await db
				.select({ id: member.id })
				.from(member)
				.innerJoin(user, eq(user.id, member.userId))
				.where(
					and(
						eq(member.organizationId, actor.organizationId),
						sql`lower(${user.email}) = ${email}`,
					),
				);
			if (already.length)
				throw new Failure(
					"conflict",
					"already a member: grant them the guest role on this project from Members",
				);
			await ensureWorkProject(db, id);
			const invitationId = crypto.randomUUID();
			await db.transaction(async (tx) => {
				await tx
					.update(invitation)
					.set({ status: "canceled" })
					.where(
						and(
							eq(invitation.organizationId, actor.organizationId),
							eq(invitation.email, email),
							eq(invitation.status, "pending"),
						),
					);
				await tx.insert(invitation).values({
					id: invitationId,
					organizationId: actor.organizationId,
					email,
					role: "guest",
					status: "pending",
					expiresAt: new Date(Date.now() + 7 * 86_400_000),
					inviterId: actor.userId,
				});
				await tx.insert(invitationGrant).values({
					invitationId,
					role: "guest",
					scopeKind: "project",
					scopeId: id,
				});
				if (input.canCreate)
					await tx
						.update(workProject)
						.set({ guestsCanCreate: true, updatedAt: new Date() })
						.where(eq(workProject.projectId, id));
				await auditInTx(c, tx, {
					resourceId: invitationId,
					diff: { email, projectId: id, canCreate: input.canCreate },
				});
			});
			return c.json(
				{
					invitationId,
					url: new URL(
						`/accept-invitation/${invitationId}`,
						await publicBase(c),
					).href,
					emailed: false,
				},
				201,
			);
		},
	);

// Public pages: no session, the token is the credential (see share-pages.ts).
workImportsSharesGuests.route("/share", sharePages);

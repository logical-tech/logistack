import { createRoute, z } from "@hono/zod-openapi";
import { checkFolderPlacement } from "@logistack/core";
import { type Db, folder } from "@logistack/db";
import { and, asc, eq } from "drizzle-orm";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import { Failure, notFound, one } from "../errors.ts";
import {
	body,
	errors,
	Folder,
	IdParam,
	json,
	Name,
	patchOf,
	router,
	Slug,
	security,
	slugify,
} from "../openapi.ts";
import {
	byParam,
	check,
	inOrganization,
	locate,
	organizationResource,
	requirePermission,
} from "../scope.ts";

const FolderTree = Folder.extend({ children: z.array(Folder) }).openapi(
	"FolderTree",
);

const FolderInput = z.object({
	name: Name,
	slug: Slug.optional(),
	parentId: z.string().nullable().optional(),
	position: z.int().min(0).optional(),
});

const FolderPatch = patchOf(FolderInput);

async function parentRow(db: Db, organizationId: string, id: string) {
	const [row] = await db
		.select({
			id: folder.id,
			organizationId: folder.organizationId,
			parentId: folder.parentId,
		})
		.from(folder)
		.where(and(eq(folder.id, id), eq(folder.organizationId, organizationId)));
	if (!row) throw notFound("parent folder");
	return row;
}

/** Applies the two-level rule before the DB trigger has to. */
async function assertPlacement(
	db: Db,
	organizationId: string,
	folderId: string | undefined,
	parentId: string | null,
) {
	const parent = parentId
		? await parentRow(db, organizationId, parentId)
		: null;
	const hasChildren = folderId
		? (await db.$count(folder, eq(folder.parentId, folderId))) > 0
		: false;
	const error = checkFolderPlacement({
		folder: { id: folderId, organizationId, hasChildren },
		parent,
	});
	if (error)
		throw new Failure("bad_request", "folders nest at most two levels", {
			reason: error,
		});
}

const tags = ["folders"];

export const folders = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/folders",
			tags,
			security,
			summary: "Folder tree of the organization",
			middleware: [requirePermission("read", inOrganization)],
			responses: {
				200: json(z.array(FolderTree), "Top-level folders"),
				...errors,
			},
		}),
		async (c) => {
			const rows = await c.var.deps.db
				.select()
				.from(folder)
				.where(eq(folder.organizationId, requireActor(c).organizationId))
				.orderBy(asc(folder.position), asc(folder.name));
			const tree = rows
				.filter((f) => f.parentId === null)
				.map((f) => ({
					...f,
					children: rows.filter((x) => x.parentId === f.id),
				}));
			return c.json(tree, 200);
		},
	)
	.openapi(
		mutation(
			"folder.create",
			createRoute({
				method: "post",
				path: "/folders",
				tags,
				security,
				request: body(FolderInput),
				responses: { 201: json(Folder, "Created"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const orgId = requireActor(c).organizationId;
			const parentId = input.parentId ?? null;
			check(
				c,
				"write",
				parentId
					? await locate(db, orgId, "folder", parentId)
					: organizationResource(orgId),
			);
			await assertPlacement(db, orgId, undefined, parentId);
			const row = one(
				await db
					.insert(folder)
					.values({
						organizationId: orgId,
						parentId,
						name: input.name,
						slug: input.slug ?? slugify(input.name),
						position: input.position ?? 0,
					})
					.returning(),
			);
			c.set("auditResourceId", row.id);
			return c.json(row, 201);
		},
	)
	.openapi(
		mutation(
			"folder.update",
			createRoute({
				method: "patch",
				path: "/folders/{id}",
				tags,
				security,
				summary: "Rename or move a folder",
				middleware: [requirePermission("write", byParam("folder"))],
				request: { params: IdParam, ...body(FolderPatch) },
				responses: { 200: json(Folder, "Updated"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const orgId = requireActor(c).organizationId;
			const [cur] = await db
				.select({ parentId: folder.parentId })
				.from(folder)
				.where(eq(folder.id, id));
			if (input.parentId !== undefined && input.parentId !== cur?.parentId) {
				// Placing at the top level is an organization-wide change.
				check(
					c,
					"write",
					input.parentId
						? await locate(db, orgId, "folder", input.parentId)
						: organizationResource(orgId),
				);
				await assertPlacement(db, orgId, id, input.parentId);
			}
			const row = one(
				await db.update(folder).set(input).where(eq(folder.id, id)).returning(),
			);
			return c.json(row, 200);
		},
	)
	.openapi(
		mutation(
			"folder.delete",
			createRoute({
				method: "delete",
				path: "/folders/{id}",
				tags,
				security,
				summary:
					"Delete a folder and its subfolders; its projects move to the top level",
				middleware: [requirePermission("delete", byParam("folder"))],
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			await c.var.deps.db
				.delete(folder)
				.where(eq(folder.id, c.req.valid("param").id));
			return c.body(null, 204);
		},
	);

import { createRoute, z } from "@hono/zod-openapi";
import { encrypt } from "@logistack/core";
import { backupPolicy, node, s3Destination } from "@logistack/db";
import {
	ProviderError,
	type RcloneKind,
	rcloneDestination,
	rcloneSecrets,
	rcloneSettings,
} from "@logistack/providers";
import {
	destinationKinds,
	localDestination,
	localSettings,
	rcloneConfig,
	rcloneHost,
} from "@logistack/worker/destinations";
import { and, asc, count, eq } from "drizzle-orm";
import type { Context } from "hono";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import { Failure, notFound, one } from "../errors.ts";
import {
	body,
	errors,
	IdParam,
	json,
	Name,
	router,
	security,
} from "../openapi.ts";
import { guardedDestination } from "../s3.ts";
import { inOrganization, requirePermission } from "../scope.ts";
import { BlockedHostError, hostPolicy, resolvePublic } from "../ssrf.ts";
import { Connection } from "./s3-destinations.ts";

// Every kind of backup destination. Rows live in `s3_destination` (named for its first kind):
// S3 keeps its columns, the others keep clear settings in `config` and secrets encrypted as JSON.

const Kind = z.enum(destinationKinds);

export const BackupDestinationView = z
	.object({
		id: z.string(),
		name: z.string(),
		kind: Kind,
		/** Where backups land, for display (`sftp://backup@nas:22/backups`). */
		location: z.string(),
		/** The kind's settings without its secrets. */
		settings: z.record(z.string(), z.unknown()),
		/** `local`: the node that holds the folder. */
		nodeId: z.string().nullable(),
		/** Backup policies writing here; a destination in use cannot be deleted. */
		usedBy: z.int(),
		createdAt: z.string(),
	})
	.openapi("BackupDestination");

const rclone = <K extends RcloneKind>(kind: K) =>
	z.object({
		kind: z.literal(kind),
		settings: rcloneSettings[kind],
		secrets: rcloneSecrets[kind],
	});

const { secretAccessKey: _, ...s3Settings } = Connection.shape;
export const DestinationInput = z
	.discriminatedUnion("kind", [
		z.object({
			kind: z.literal("s3"),
			settings: z.object(s3Settings),
			secrets: z.object({ secretAccessKey: z.string().min(1) }),
		}),
		rclone("sftp"),
		rclone("webdav"),
		rclone("azureblob"),
		rclone("drive"),
		rclone("b2"),
		z.object({
			kind: z.literal("local"),
			/** A node of this organization; the folder must already exist on it. */
			nodeId: z.string().min(1),
			settings: localSettings,
			secrets: z.object({}).default({}),
		}),
	])
	.openapi("BackupDestinationInput");
type DestinationInput = z.infer<typeof DestinationInput>;

const Check = z
	.object({
		ok: z.boolean(),
		message: z.string(),
		detail: z.string().optional(),
	})
	.openapi("BackupDestinationCheck");

type Row = typeof s3Destination.$inferSelect;

function location(d: Row, hostname?: string): string {
	const c = d.config as Record<string, string | number | undefined>;
	const path = (p: unknown) => String(p ?? "").replace(/^\/*/, "/");
	switch (d.kind) {
		case "s3":
			return `s3://${d.bucket}/${d.prefix}`;
		case "sftp":
			return `sftp://${c.user}@${c.host}:${c.port}${path(c.path)}`;
		case "webdav":
			return `${String(c.url).replace(/\/+$/, "")}${c.path ? path(c.path) : ""}`;
		case "azureblob":
			return `azure://${c.account}/${c.container}${c.path ? path(c.path) : ""}`;
		case "drive":
			return `drive:${c.path ? path(c.path) : "/"}`;
		case "b2":
			return `b2://${c.bucket}${c.path ? path(c.path) : ""}`;
		case "local":
			return `${hostname ?? "a removed node"}:${c.path}`;
		default:
			return d.kind;
	}
}

/** The node row for a `local` destination, scoped to the organization. */
async function orgNode(c: Context, nodeId: string) {
	const [n] = await c.var.deps.db
		.select({ id: node.id, swarm: node.swarmNodeId, hostname: node.hostname })
		.from(node)
		.where(
			and(
				eq(node.id, nodeId),
				eq(node.organizationId, requireActor(c).organizationId),
			),
		);
	if (!n) throw notFound("node");
	return n;
}

/** Writes, reads back and deletes a probe through the same code backups use. */
async function probe(c: Context, input: DestinationInput) {
	const policy = await hostPolicy(c.var.deps.db);
	if (input.kind === "s3") {
		const dest = await guardedDestination(
			{ ...input.settings, ...input.secrets },
			policy,
		);
		await dest.probe();
		return `Wrote, read and deleted a probe object in ${input.settings.bucket}`;
	}
	if (input.kind === "local") {
		const n = await orgNode(c, input.nodeId);
		await localDestination({
			nodes: c.var.deps.nodes,
			swarmNodeId: n.swarm,
			path: input.settings.path,
			image: c.var.deps.config.LS_BACKUP_TOOLS_IMAGE,
			jobName: () => `ls-dst-probe-${crypto.randomUUID().slice(0, 12)}`,
			labels: { "logistack.kind": "backup-destination-probe" },
		}).probe();
		return `Wrote, read and deleted a probe file in ${input.settings.path} on ${n.hostname}`;
	}
	const config = rcloneConfig(input.kind, input.settings, input.secrets);
	const dial = rcloneHost(config);
	if (dial) {
		if (dial.plain && !policy.allowPrivateHosts)
			throw new BlockedHostError(
				"only https WebDAV servers are allowed; an instance owner can allow private hosts in Settings",
			);
		await resolvePublic(dial.host, policy);
	}
	await rcloneDestination(config).probe();
	return "Wrote, read and deleted a probe file";
}

export const backupDestinations = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/backup-destinations",
			tags: ["backups"],
			security,
			summary: "Every backup destination, of every kind",
			middleware: [requirePermission("read", inOrganization)],
			responses: {
				200: json(z.array(BackupDestinationView), "Destinations"),
				...errors,
			},
		}),
		async (c) => {
			const { db } = c.var.deps;
			const rows = await db
				.select({
					d: s3Destination,
					hostname: node.hostname,
					usedBy: count(backupPolicy.id),
				})
				.from(s3Destination)
				.leftJoin(node, eq(node.id, s3Destination.nodeId))
				.leftJoin(
					backupPolicy,
					eq(backupPolicy.s3DestinationId, s3Destination.id),
				)
				.where(eq(s3Destination.organizationId, requireActor(c).organizationId))
				.groupBy(s3Destination.id, node.hostname)
				.orderBy(asc(s3Destination.name));
			return c.json(
				rows.map(({ d, hostname, usedBy }) => ({
					id: d.id,
					name: d.name,
					kind: Kind.catch("s3").parse(d.kind),
					location: location(d, hostname ?? undefined),
					settings:
						d.kind === "s3"
							? {
									endpoint: d.endpoint,
									region: d.region,
									bucket: d.bucket,
									prefix: d.prefix,
									accessKeyId: d.accessKeyId,
									forcePathStyle: d.forcePathStyle,
								}
							: d.config,
					nodeId: d.nodeId,
					usedBy,
					createdAt: d.createdAt.toISOString(),
				})),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"backup_destination.test",
			createRoute({
				method: "post",
				path: "/backup-destinations/test",
				tags: ["backups"],
				security,
				summary: "Write, read back and delete a probe in a destination",
				description:
					"Writes `.logistack-probe-<uuid>` at the destination's root, reads it, deletes it. Nothing is stored in LogiStack.",
				middleware: [requirePermission("admin", inOrganization)],
				request: body(DestinationInput),
				responses: { 200: json(Check, "Result"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const started = performance.now();
			try {
				const message = await probe(c, input);
				return c.json(
					{
						ok: true,
						message,
						detail: `Round trip in ${Math.round(performance.now() - started)} ms`,
					},
					200,
				);
			} catch (e) {
				if (!(e instanceof ProviderError || e instanceof BlockedHostError))
					throw e;
				return c.json(
					{
						ok: false,
						message:
							e instanceof BlockedHostError
								? "Host not allowed"
								: "The destination refused the probe",
						detail: e.message,
					},
					200,
				);
			}
		},
	)
	.openapi(
		mutation(
			"backup_destination.create",
			createRoute({
				method: "post",
				path: "/backup-destinations",
				tags: ["backups"],
				security,
				summary: "Add a backup destination",
				description:
					"Secrets are stored encrypted and never returned. Probe first with `POST /backup-destinations/test`.",
				middleware: [requirePermission("admin", inOrganization)],
				request: body(
					z.intersection(DestinationInput, z.object({ name: Name })),
				),
				responses: {
					201: json(z.object({ id: z.string() }), "Created"),
					...errors,
				},
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const { db, masterKey } = c.var.deps;
			const organizationId = requireActor(c).organizationId;
			const values =
				input.kind === "s3"
					? {
							...input.settings,
							secretEncrypted: await encrypt(
								masterKey,
								input.secrets.secretAccessKey,
							),
						}
					: {
							endpoint: "",
							region: "",
							bucket: "",
							prefix: "",
							accessKeyId: "",
							config: input.settings,
							nodeId:
								input.kind === "local"
									? (await orgNode(c, input.nodeId)).id
									: null,
							secretEncrypted: await encrypt(
								masterKey,
								JSON.stringify(input.secrets),
							),
						};
			const row = one(
				await db
					.insert(s3Destination)
					.values({
						...values,
						kind: input.kind,
						name: input.name,
						organizationId,
					})
					.returning({ id: s3Destination.id }),
			);
			c.set("auditResourceId", row.id);
			return c.json(row, 201);
		},
	)
	.openapi(
		mutation(
			"backup_destination.delete",
			createRoute({
				method: "delete",
				path: "/backup-destinations/{id}",
				tags: ["backups"],
				security,
				summary: "Remove a destination no backup policy uses",
				description:
					"Backups already written stay where they are. Refused with 409 while a policy still writes here.",
				middleware: [requirePermission("admin", inOrganization)],
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { db } = c.var.deps;
			c.set("auditResourceId", id);
			const owned = and(
				eq(s3Destination.id, id),
				eq(s3Destination.organizationId, requireActor(c).organizationId),
			);
			one(
				await db
					.select({ id: s3Destination.id })
					.from(s3Destination)
					.where(owned),
				"backup destination",
			);
			const inUse = await db.$count(
				backupPolicy,
				eq(backupPolicy.s3DestinationId, id),
			);
			if (inUse)
				throw new Failure(
					"conflict",
					`${inUse} backup ${inUse === 1 ? "policy writes" : "policies write"} here; move or delete ${inUse === 1 ? "it" : "them"} first`,
					{ usedBy: inUse },
				);
			const rows = await db
				.delete(s3Destination)
				.where(owned)
				.returning({ id: s3Destination.id });
			if (!rows.length) throw notFound("backup destination");
			return c.body(null, 204);
		},
	);

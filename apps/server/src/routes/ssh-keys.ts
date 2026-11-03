import { createRoute, z } from "@hono/zod-openapi";
import { encrypt } from "@logistack/core";
import { sshKey } from "@logistack/db";
import { and, asc, eq } from "drizzle-orm";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import { Failure, one } from "../errors.ts";
import { body, errors, IdParam, json, router, security } from "../openapi.ts";
import { inOrganization, requirePermission } from "../scope.ts";
import { generateEd25519, parsePrivateKey, SshKeyError } from "../ssh.ts";

const SshKey = z
	.object({
		id: z.string(),
		name: z.string(),
		publicKey: z.string(),
		fingerprint: z.string(),
		createdAt: z.string(),
	})
	.openapi("SshKey");

const columns = {
	id: sshKey.id,
	name: sshKey.name,
	publicKey: sshKey.publicKey,
	fingerprint: sshKey.fingerprint,
	createdAt: sshKey.createdAt,
};

export const sshKeys = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/ssh-keys",
			tags: ["ssh-keys"],
			security,
			summary: "SSH keys of the organization (public halves only)",
			middleware: [requirePermission("read", inOrganization)],
			responses: { 200: json(z.array(SshKey), "Keys"), ...errors },
		}),
		async (c) => {
			const rows = await c.var.deps.db
				.select(columns)
				.from(sshKey)
				.where(eq(sshKey.organizationId, requireActor(c).organizationId))
				.orderBy(asc(sshKey.createdAt));
			return c.json(
				rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"ssh_key.create",
			createRoute({
				method: "post",
				path: "/ssh-keys",
				tags: ["ssh-keys"],
				security,
				summary: "Generate an ed25519 key, or import an OpenSSH private key",
				description:
					"Without `privateKey` the server generates an ed25519 pair. The private key is encrypted at rest and never returned.",
				middleware: [requirePermission("admin", inOrganization)],
				request: body(
					z.object({
						name: z.string().trim().min(1).max(64),
						privateKey: z.string().max(16_384).optional(),
					}),
				),
				responses: { 201: json(SshKey, "Created"), ...errors },
			}),
		),
		async (c) => {
			const { name, privateKey } = c.req.valid("json");
			const { db, masterKey } = c.var.deps;
			const comment = `${name.replace(/\s+/g, "-")}@logistack`;
			let material: ReturnType<typeof generateEd25519>;
			try {
				material = privateKey
					? parsePrivateKey(privateKey, comment)
					: generateEd25519(comment);
			} catch (err) {
				if (err instanceof SshKeyError)
					throw new Failure("bad_request", err.message);
				throw err;
			}
			// The audit row keeps the name only, never the key.
			c.set("auditDiff", {
				input: { name, imported: Boolean(privateKey) },
				fingerprint: material.fingerprint,
			});
			const row = one(
				await db
					.insert(sshKey)
					.values({
						organizationId: requireActor(c).organizationId,
						name,
						publicKey: material.publicKey,
						fingerprint: material.fingerprint,
						privateKeyEncrypted: await encrypt(masterKey, material.privateKey),
					})
					.returning(columns),
			);
			c.set("auditResourceId", row.id);
			return c.json({ ...row, createdAt: row.createdAt.toISOString() }, 201);
		},
	)
	.openapi(
		mutation(
			"ssh_key.delete",
			createRoute({
				method: "delete",
				path: "/ssh-keys/{id}",
				tags: ["ssh-keys"],
				security,
				summary: "Delete an SSH key",
				middleware: [requirePermission("admin", inOrganization)],
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			c.set("auditResourceId", id);
			one(
				await c.var.deps.db
					.delete(sshKey)
					.where(
						and(
							eq(sshKey.id, id),
							eq(sshKey.organizationId, requireActor(c).organizationId),
						),
					)
					.returning({ id: sshKey.id }),
				"ssh key",
			);
			return c.body(null, 204);
		},
	);

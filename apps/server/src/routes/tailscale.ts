import { createRoute, z } from "@hono/zod-openapi";
import { encrypt } from "@logistack/core";
import {
	environment,
	node,
	project,
	service,
	tailscaleNetwork,
	tailscalePublication,
} from "@logistack/db";
import { and, asc, eq } from "drizzle-orm";
import type { Context } from "hono";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import type { Env } from "../env.ts";
import { Failure, notFound, one } from "../errors.ts";
import { log } from "../log.ts";
import { body, errors, IdParam, json, router, security } from "../openapi.ts";
import { requestProxySync } from "../redis.ts";
import {
	inOrganization,
	locate,
	requireInstanceAdmin,
	requirePermission,
} from "../scope.ts";

const Publication = z
	.object({
		id: z.string(),
		serviceId: z.string(),
		serviceName: z.string(),
		projectId: z.string(),
		hostname: z.string(),
		port: z.int(),
		https: z.boolean(),
		/** The worker's last error running its publisher; null when it runs. */
		statusMessage: z.string().nullable(),
		createdAt: z.string(),
	})
	.openapi("TailscalePublication");

export const TailscaleView = z
	.object({
		enabled: z.boolean(),
		/** True once the worker started tailscaled on every node. */
		nodesRunning: z.boolean(),
		statusMessage: z.string().nullable(),
		publications: z.array(Publication),
	})
	.openapi("Tailscale");

const AuthKey = z
	.string()
	.trim()
	.regex(
		/^tskey-[A-Za-z0-9-]+$/,
		"paste an auth key from the Tailscale admin console (tskey-auth-…)",
	)
	.max(200);

/** A tailnet machine name: one DNS label. */
const MachineName = z
	.string()
	.trim()
	.toLowerCase()
	.regex(
		/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/,
		"use lowercase letters, digits and hyphens",
	);

const CreatePublication = z.object({
	serviceId: z.string().min(1),
	hostname: MachineName,
	port: z.int().min(1).max(65535),
	https: z.boolean().default(true),
});

const TestResult = z
	.object({
		ok: z.boolean(),
		message: z.string(),
		detail: z.string().optional(),
	})
	.openapi("TailscaleTest");

const sync = (c: Context<Env>, reason: string) =>
	requestProxySync(c.var.deps.config.REDIS_URL, reason).catch((err: unknown) =>
		log("warn", "proxy sync request failed", { error: String(err) }),
	);

async function view(c: Context<Env>): Promise<z.infer<typeof TailscaleView>> {
	const { db } = c.var.deps;
	const org = requireActor(c).organizationId;
	const [n] = await db
		.select()
		.from(tailscaleNetwork)
		.where(eq(tailscaleNetwork.organizationId, org));
	const pubs = await db
		.select({
			p: tailscalePublication,
			name: service.name,
			projectId: project.id,
		})
		.from(tailscalePublication)
		.innerJoin(service, eq(service.id, tailscalePublication.serviceId))
		.innerJoin(environment, eq(environment.id, service.environmentId))
		.innerJoin(project, eq(project.id, environment.projectId))
		.where(eq(tailscalePublication.organizationId, org))
		.orderBy(asc(tailscalePublication.hostname));
	return {
		enabled: Boolean(n),
		nodesRunning: Boolean(n?.nodeServiceId),
		statusMessage: n?.statusMessage ?? null,
		publications: pubs.map(({ p, name, projectId }) => ({
			id: p.id,
			serviceId: p.serviceId,
			serviceName: name,
			projectId,
			hostname: p.hostname,
			port: p.port,
			https: p.https,
			statusMessage: p.statusMessage,
			createdAt: p.createdAt.toISOString(),
		})),
	};
}

// tailscaled runs as a host-network global service on every node, shared by every organization.
const admin = [
	requirePermission("admin", inOrganization),
	requireInstanceAdmin,
];

export const tailscale = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/tailscale",
			tags: ["networking"],
			security,
			summary: "Tailscale status and the services published on the tailnet",
			middleware: [requirePermission("read", inOrganization)],
			responses: { 200: json(TailscaleView, "Tailscale"), ...errors },
		}),
		async (c) => c.json(await view(c), 200),
	)
	.openapi(
		mutation(
			"tailscale.enable",
			createRoute({
				method: "put",
				path: "/tailscale",
				tags: ["networking"],
				security,
				summary: "Join every node to the tailnet, or rotate the auth key",
				description:
					"Stores the auth key encrypted; the worker runs tailscaled on every node with it. Use a reusable, ephemeral key so restarted nodes rejoin and stale ones leave the tailnet.",
				middleware: admin,
				request: body(z.object({ authKey: AuthKey })),
				responses: { 200: json(TailscaleView, "Tailscale"), ...errors },
			}),
		),
		async (c) => {
			const { db, masterKey } = c.var.deps;
			const org = requireActor(c).organizationId;
			const authKeyEncrypted = await encrypt(
				masterKey,
				c.req.valid("json").authKey,
			);
			const row = one(
				await db
					.insert(tailscaleNetwork)
					.values({ organizationId: org, authKeyEncrypted })
					.onConflictDoUpdate({
						target: tailscaleNetwork.organizationId,
						set: { authKeyEncrypted, updatedAt: new Date() },
					})
					.returning(),
			);
			c.set("auditResourceId", row.id);
			await sync(c, "tailscale enabled");
			return c.json(await view(c), 200);
		},
	)
	.openapi(
		mutation(
			"tailscale.disable",
			createRoute({
				method: "delete",
				path: "/tailscale",
				tags: ["networking"],
				security,
				summary: "Leave the tailnet and remove everything Tailscale created",
				description:
					"Deletes the auth key and every publication; the worker removes the tailscaled and publisher services and their configs.",
				middleware: admin,
				responses: { 204: { description: "Disabled" }, ...errors },
			}),
		),
		async (c) => {
			const { db } = c.var.deps;
			const org = requireActor(c).organizationId;
			await db.transaction(async (tx) => {
				await tx
					.delete(tailscalePublication)
					.where(eq(tailscalePublication.organizationId, org));
				await tx
					.delete(tailscaleNetwork)
					.where(eq(tailscaleNetwork.organizationId, org));
			});
			await sync(c, "tailscale disabled");
			return c.body(null, 204);
		},
	)
	.openapi(
		mutation(
			"tailscale_publication.create",
			createRoute({
				method: "post",
				path: "/tailscale/publications",
				tags: ["networking"],
				security,
				summary: "Publish a service on its own tailnet hostname",
				description:
					"The worker runs a tailnet machine named `hostname` next to the service; `tailscale serve` proxies it to `port`, over HTTPS with a tailnet certificate or plain HTTP.",
				middleware: admin,
				request: body(CreatePublication),
				responses: { 201: json(Publication, "Published"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const org = requireActor(c).organizationId;
			await locate(db, org, "service", input.serviceId);
			const [n] = await db
				.select({ id: tailscaleNetwork.id })
				.from(tailscaleNetwork)
				.where(eq(tailscaleNetwork.organizationId, org));
			if (!n) throw new Failure("conflict", "turn Tailscale on first");
			const [taken] = await db
				.select({ id: tailscalePublication.id })
				.from(tailscalePublication)
				.where(
					and(
						eq(tailscalePublication.organizationId, org),
						eq(tailscalePublication.hostname, input.hostname),
					),
				);
			if (taken)
				throw new Failure("conflict", `${input.hostname} is already published`);
			const p = one(
				await db
					.insert(tailscalePublication)
					.values({ ...input, organizationId: org })
					.returning(),
			);
			c.set("auditResourceId", p.id);
			await sync(c, "tailscale publication created");
			const created = (await view(c)).publications.find((x) => x.id === p.id);
			if (!created) throw notFound("publication");
			return c.json(created, 201);
		},
	)
	.openapi(
		mutation(
			"tailscale_publication.delete",
			createRoute({
				method: "delete",
				path: "/tailscale/publications/{id}",
				tags: ["networking"],
				security,
				summary: "Stop publishing a service on the tailnet",
				middleware: admin,
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const id = c.req.valid("param").id;
			const [p] = await c.var.deps.db
				.delete(tailscalePublication)
				.where(
					and(
						eq(tailscalePublication.id, id),
						eq(
							tailscalePublication.organizationId,
							requireActor(c).organizationId,
						),
					),
				)
				.returning({ id: tailscalePublication.id });
			if (!p) throw notFound("publication");
			c.set("auditResourceId", p.id);
			await sync(c, "tailscale publication deleted");
			return c.body(null, 204);
		},
	)
	.openapi(
		mutation(
			"tailscale.test",
			createRoute({
				method: "post",
				path: "/tailscale/test",
				tags: ["networking"],
				security,
				summary: "Check the tailnet from a node",
				description:
					"Runs in tailscaled on a ready node. With `publicationId` it pings that publication's tailnet machine; without, it reports the node's tailnet address.",
				middleware: admin,
				request: body(z.object({ publicationId: z.string().optional() })),
				responses: { 200: json(TestResult, "Result"), ...errors },
			}),
		),
		async (c) => {
			const { db, nodes } = c.var.deps;
			const org = requireActor(c).organizationId;
			const { publicationId } = c.req.valid("json");
			const [n] = await db
				.select()
				.from(tailscaleNetwork)
				.where(eq(tailscaleNetwork.organizationId, org));
			if (!n) throw new Failure("conflict", "turn Tailscale on first");
			let hostname: string | undefined;
			if (publicationId) {
				const [p] = await db
					.select()
					.from(tailscalePublication)
					.where(
						and(
							eq(tailscalePublication.id, publicationId),
							eq(tailscalePublication.organizationId, org),
						),
					);
				if (!p) throw notFound("publication");
				hostname = p.hostname;
			}
			if (!n.nodeServiceId)
				return c.json(
					{
						ok: false,
						message: "tailscaled isn't running yet",
						detail:
							n.statusMessage ?? "The worker starts it within a few seconds.",
					},
					200,
				);
			const [target] = await db
				.select({ swarmNodeId: node.swarmNodeId })
				.from(node)
				.where(and(eq(node.organizationId, org), eq(node.status, "ready")))
				.orderBy(asc(node.role));
			if (!target)
				throw new Failure("conflict", "no node is ready to run the check");
			// containerboot's socket; the CLI's default path does not exist in the image.
			const cli = ["tailscale", "--socket=/tmp/tailscaled.sock"];
			const cmd = hostname
				? [
						...cli,
						"ping",
						"-c",
						"1",
						"--until-direct=false",
						"--timeout",
						"10s",
						hostname,
					]
				: [...cli, "ip", "-4"];
			let out = "";
			let code: number | null = null;
			try {
				const exec = nodes.exec(
					target.swarmNodeId,
					{ target: { kind: "service", serviceId: n.nodeServiceId }, cmd },
					{ signal: AbortSignal.timeout(30_000) },
				);
				const decoder = new TextDecoder();
				for await (const chunk of exec) out += decoder.decode(chunk.data);
				code = (await exec.result).code;
			} catch (e) {
				return c.json(
					{
						ok: false,
						message: "The node couldn't run the check",
						detail: e instanceof Error ? e.message : String(e),
					},
					200,
				);
			}
			out = out.trim().slice(-2000);
			if (code !== 0)
				return c.json(
					{
						ok: false,
						message: hostname
							? `${hostname} didn't answer over the tailnet`
							: "This node hasn't joined the tailnet",
						detail: out || `exit ${code}`,
					},
					200,
				);
			return c.json(
				{
					ok: true,
					message: hostname
						? `${hostname} answers over the tailnet`
						: `The node joined the tailnet at ${out.split("\n")[0]}`,
					detail: hostname ? out : undefined,
				},
				200,
			);
		},
	);

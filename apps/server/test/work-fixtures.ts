import { member, organizationRole, roleGrant, user } from "@logistack/db";
import { eq } from "drizzle-orm";
import { type Actor, grantsFor } from "../src/actor.ts";
import { createApp } from "../src/app.ts";
import { type Harness, setupBody, startHarness } from "./harness.ts";

/**
 * A Work test world: an organization with a folder F holding projects P and P2, a project Q
 * outside it, and one actor per access shape. Requests run in-process as each actor.
 */

export const actorNames = [
	"owner",
	"admin",
	"developer",
	"viewer",
	"manager",
	"guest",
	"custom",
	"folder",
	"env",
] as const;
export type ActorName = (typeof actorNames)[number];

export type Call = (
	method: string,
	path: string,
	body?: unknown,
	headers?: Record<string, string>,
	// biome-ignore lint/suspicious/noExplicitAny: tests poke at arbitrary JSON.
) => Promise<{ status: number; json: any; text: string; headers: Headers }>;

export type World = Awaited<ReturnType<typeof startWorld>>;

export async function startWorld(area: string) {
	const h: Harness = await startHarness({ area, label: area });
	try {
		const { db } = h.deps;
		const setup = await h.call("POST", "/api/setup", { body: setupBody });
		const orgId = setup.json.organizationId as string;
		const [ownerRow] = await db
			.select({ id: member.userId })
			.from(member)
			.where(eq(member.organizationId, orgId));
		const users = {} as Record<ActorName, string>;
		users.owner = ownerRow?.id as string;
		await db.insert(organizationRole).values({
			id: crypto.randomUUID(),
			organizationId: orgId,
			role: "worker-bee",
			permission: JSON.stringify({ logistack: ["work"] }),
		});
		const memberRole: Partial<Record<ActorName, string>> = {
			admin: "admin",
			developer: "developer",
			viewer: "viewer",
			custom: "worker-bee",
		};
		for (const name of actorNames) {
			if (name === "owner") continue;
			const id = crypto.randomUUID();
			users[name] = id;
			await db.insert(user).values({
				id,
				name: `${name[0]?.toUpperCase()}${name.slice(1)} User`,
				email: `${name}@example.com`,
			});
			await db.insert(member).values({
				id: crypto.randomUUID(),
				organizationId: orgId,
				userId: id,
				// "none" resolves to no role: these actors only hold their scoped grant.
				role: memberRole[name] ?? "none",
				createdAt: new Date(),
			});
		}
		const actorOf = async (name: ActorName): Promise<Actor> => ({
			kind: "user",
			id: users[name],
			userId: users[name],
			organizationId: orgId,
			grants: (await grantsFor(db, users[name], users[name], orgId)) ?? [],
		});
		const ownerApp = createApp(h.deps, { actor: await actorOf("owner") });
		const callAs =
			(app: ReturnType<typeof createApp>): Call =>
			async (method, path, body, headers = {}) => {
				const res = await app.request(path, {
					method,
					headers: {
						...(body === undefined
							? {}
							: { "content-type": "application/json" }),
						...headers,
					},
					body: body === undefined ? undefined : JSON.stringify(body),
				});
				const text = await res.text();
				const json = res.headers.get("content-type")?.includes("json")
					? JSON.parse(text)
					: undefined;
				return { status: res.status, json, text, headers: res.headers };
			};
		const owner = callAs(ownerApp);
		const ok = async (method: string, path: string, body?: unknown) => {
			const r = await owner(method, path, body);
			if (r.status >= 300)
				throw new Error(`${method} ${path}: ${r.status} ${r.text}`);
			return r.json;
		};
		const folderId = (await ok("POST", "/api/folders", { name: "Clients" })).id;
		const project = async (name: string, inFolder: boolean) =>
			(
				await ok("POST", "/api/projects", {
					name,
					...(inFolder ? { folderId } : {}),
				})
			).id as string;
		const P = await project("Shop", true);
		const P2 = await project("Blog relaunch", true);
		const Q = await project("Internal", false);
		const envOf = async (projectId: string) =>
			(await ok("GET", `/api/projects/${projectId}/environments`))[0]
				.id as string;
		const grant = (
			name: ActorName,
			role: string,
			kind: string,
			scopeId: string,
		) =>
			db.insert(roleGrant).values({
				organizationId: orgId,
				userId: users[name],
				role,
				scopeKind: kind as "project",
				scopeId,
			});
		await grant("manager", "manager", "project", P);
		await grant("guest", "guest", "project", P);
		await grant("folder", "manager", "folder", folderId);
		await grant("env", "manager", "environment", await envOf(P));
		const actors = {} as Record<ActorName, Actor>;
		const calls = {} as Record<ActorName, Call>;
		for (const name of actorNames) {
			actors[name] = await actorOf(name);
			calls[name] = callAs(createApp(h.deps, { actor: actors[name] }));
		}
		const work = (path: string) => `/api/work${path}`;
		const lists = async (projectId: string) =>
			(await ok("GET", work(`/projects/${projectId}/lists`))) as {
				id: string;
				name: string;
			}[];
		const statuses = async (projectId: string) =>
			(await ok("GET", work(`/projects/${projectId}/statuses`))) as {
				id: string;
				name: string;
				category: string;
			}[];
		const listOf = async (projectId: string) =>
			(await lists(projectId))[0]?.id as string;
		const task = async (
			projectId: string,
			extra: Record<string, unknown> = {},
		) =>
			(await ok("POST", work("/tasks"), {
				listId: await listOf(projectId),
				title: "A task",
				...extra,
			})) as { id: string; key: string; number: number; updatedAt: string };
		return {
			h,
			db,
			orgId,
			users,
			actors,
			calls,
			owner,
			ok,
			work,
			folderId,
			P,
			P2,
			Q,
			envOf,
			lists,
			listOf,
			statuses,
			task,
			close: () => h.close(),
		};
	} catch (e) {
		await h.close();
		throw e;
	}
}

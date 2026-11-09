import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AGENT_WS_PATH } from "@logistack/contracts";
import { deployment, domain } from "@logistack/db";
import { createApp } from "../src/app.ts";
import { hasDocker } from "./harness.ts";
import { startWorld, type World } from "./work-fixtures.ts";

/**
 * Plan 17.2: a project manager or a guest granted on a project reaches nothing outside Work.
 * Walks every registered route, so a new route that forgets its permission check fails here.
 */

/** Routes without an organization actor: sign-in, health, signed webhooks, setup, docs. */
const PUBLIC = [
	/^\/api\/auth\//,
	/^\/api\/health$/,
	/^\/api\/webhooks\//,
	/^\/api\/storage\/shared\//,
	/^\/api\/setup/,
	/^\/api\/openapi\.json$/,
	/^\/api\/docs$/,
];
/** Surfaces every member has: Work itself and the actor's own `/api/me`. */
const OWN = [/^\/api\/work\//, /^\/api\/me(\/|$)/];
/** Instance metadata with no organization data in it. */
const STATIC = new Set([
	"GET /api/version",
	"GET /api/manifest/schema.json",
	"GET /api/integrations/schemas",
	"GET /api/sso/status",
]);

describe.skipIf(!hasDocker)("work isolation", () => {
	let w: World;
	beforeAll(async () => {
		w = await startWorld("work-iso");
	}, 120_000);
	afterAll(() => w?.close());

	test("manager and guest get 403/404 on every non-Work route", async () => {
		const env = await w.envOf(w.P);
		const svc = await w.ok("POST", `/api/environments/${env}/services`, {
			name: "Web",
			spec: {
				kind: "application",
				source: { type: "image", image: "nginx:1.27" },
				build: { type: "image" },
				ports: [{ target: 80, protocol: "tcp" }],
				replicas: 1,
				resources: {},
				placement: [],
			},
		});
		const [dep] = await w.db
			.insert(deployment)
			.values({ serviceId: svc.id, status: "healthy", trigger: "manual" })
			.returning();
		await w.db
			.insert(domain)
			.values({ serviceId: svc.id, hostname: "shop.example.com", port: 80 });
		// Lists filtered per row may answer 200, but never with these.
		const secrets = [w.P, env, svc.id, dep?.id as string, "shop.example.com"];
		// Ids of real rows in the granted project, by the collection a parameter follows.
		const ids: Record<string, string> = {
			projects: w.P,
			environments: env,
			services: svc.id,
			folders: w.folderId,
			deployments: dep?.id as string,
			projectId: w.P,
			environmentId: env,
			serviceId: svc.id,
			folderId: w.folderId,
			deploymentId: dep?.id as string,
		};
		const fill = (path: string) => {
			const parts = path.split("/");
			return parts
				.map((p, i) =>
					p.startsWith(":")
						? encodeURIComponent(
								ids[p.slice(1).replace(/\{.*\}$/, "")] ??
									ids[parts[i - 1] ?? ""] ??
									"x",
							)
						: p,
				)
				.join("/");
		};
		const app = createApp(w.h.deps);
		const routes = [
			...new Map(
				app.routes
					.filter(
						(r) =>
							r.method !== "ALL" &&
							r.path.startsWith("/api/") &&
							!r.path.includes("*") &&
							r.path !== AGENT_WS_PATH &&
							![...PUBLIC, ...OWN].some((re) => re.test(r.path)),
					)
					.map((r) => [`${r.method} ${r.path}`, r]),
			).values(),
		];
		expect(routes.length).toBeGreaterThan(200);
		const offenders: string[] = [];
		for (const who of ["manager", "guest"] as const)
			for (const r of routes) {
				const body = r.method === "GET" ? undefined : {};
				const res = await Promise.race([
					w.calls[who](r.method, fill(r.path), body),
					Bun.sleep(5000).then(() => ({ status: 0, text: "timeout" })),
				]);
				const key = `${r.method} ${r.path}`;
				const leaked =
					res.status === 0 ||
					(res.status < 400 &&
						!STATIC.has(key) &&
						(r.method !== "GET" || secrets.some((x) => res.text.includes(x))));
				if (leaked)
					offenders.push(
						`${who} ${r.method} ${r.path} -> ${res.status} ${res.text.slice(0, 300)}`,
					);
			}
		expect(offenders).toEqual([]);
	}, 300_000);
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { service } from "@logistack/db";
import { eq } from "drizzle-orm";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const spec = (replicas: number) => ({
	kind: "application",
	source: { type: "image", image: "nginx:alpine" },
	build: { type: "image" },
	ports: [{ target: 80, protocol: "tcp" }],
	replicas,
	resources: {},
	placement: [],
});

describe.skipIf(!hasDocker)(
	"project archive, environment color, default",
	() => {
		let h: Harness;
		let cookie: string;
		let projectId: string;
		let prodId: string;
		let web: string;
		let worker: string;
		const as = (body?: unknown) => ({ headers: { cookie }, body });

		const state = async (id: string) => {
			const [row] = await h.deps.db
				.select()
				.from(service)
				.where(eq(service.id, id));
			return {
				desired: row?.desiredState,
				replicas: row?.spec.kind === "application" ? row.spec.replicas : null,
			};
		};

		beforeAll(async () => {
			h = await startHarness({ area: "archive", label: "archive" });
			await h.call("POST", "/api/setup", { body: setupBody });
			cookie = await h.signIn(owner.email, owner.password);
			projectId = (await h.call("POST", "/api/projects", as({ name: "Shop" })))
				.json.id;
			prodId = (
				await h.call("GET", `/api/projects/${projectId}/environments`, as())
			).json[0].id;
			web = (
				await h.call(
					"POST",
					`/api/environments/${prodId}/services`,
					as({ name: "Web", spec: spec(3) }),
				)
			).json.id;
			worker = (
				await h.call(
					"POST",
					`/api/environments/${prodId}/services`,
					as({ name: "Worker", spec: spec(2) }),
				)
			).json.id;
			expect(
				(await h.call("POST", `/api/services/${worker}/stop`, as())).status,
			).toBe(200);
		}, 90_000);
		afterAll(() => h?.close());

		test("archive stops running services, hides the project and refuses deploys", async () => {
			const res = await h.call(
				"POST",
				`/api/projects/${projectId}/archive`,
				as(),
			);
			expect(res.status).toBe(200);
			expect(res.json.archivedAt).not.toBeNull();
			expect(await state(web)).toEqual({ desired: "stopped", replicas: 3 });
			expect(await state(worker)).toEqual({ desired: "stopped", replicas: 2 });

			const active = await h.call("GET", "/api/projects", as());
			expect(active.json.map((p: { id: string }) => p.id)).not.toContain(
				projectId,
			);
			const archived = await h.call("GET", "/api/projects?archived=true", as());
			expect(archived.json.map((p: { id: string }) => p.id)).toEqual([
				projectId,
			]);

			for (const path of [
				`/api/services/${web}/deploy`,
				`/api/services/${web}/start`,
			]) {
				const refused = await h.call("POST", path, as());
				expect(refused.status).toBe(409);
			}
		});

		test("archiving twice keeps the first timestamp and the restore set", async () => {
			const before = (await h.call("GET", `/api/projects/${projectId}`, as()))
				.json.archivedAt;
			const again = await h.call(
				"POST",
				`/api/projects/${projectId}/archive`,
				as(),
			);
			expect(again.json.archivedAt).toBe(before);
		});

		test("unarchive restarts exactly what archiving stopped, at the same replicas", async () => {
			const res = await h.call(
				"POST",
				`/api/projects/${projectId}/unarchive`,
				as(),
			);
			expect(res.status).toBe(200);
			expect(res.json.archivedAt).toBeNull();
			expect(await state(web)).toEqual({ desired: "running", replicas: 3 });
			expect(await state(worker)).toEqual({ desired: "stopped", replicas: 2 });
			const active = await h.call("GET", "/api/projects", as());
			expect(active.json.map((p: { id: string }) => p.id)).toContain(projectId);
			expect(
				(await h.call("POST", `/api/services/${web}/deploy`, as())).status,
			).toBe(202);
		});

		test("environment color and a single default per project", async () => {
			const staging = await h.call(
				"POST",
				`/api/projects/${projectId}/environments`,
				as({ name: "Staging", kind: "staging", color: "amber" }),
			);
			expect(staging.status).toBe(201);
			expect(staging.json.color).toBe("amber");
			expect(
				(
					await h.call(
						"PATCH",
						`/api/environments/${prodId}`,
						as({ color: "pink" }),
					)
				).status,
			).toBe(400);

			const made = await h.call(
				"PATCH",
				`/api/environments/${staging.json.id}`,
				as({ isDefault: true }),
			);
			expect(made.status).toBe(200);
			const envs = (
				await h.call("GET", `/api/projects/${projectId}/environments`, as())
			).json as { id: string; isDefault: boolean }[];
			expect(envs.filter((e) => e.isDefault).map((e) => e.id)).toEqual([
				staging.json.id,
			]);

			const list = await h.call("GET", "/api/projects", as());
			const item = list.json.find((p: { id: string }) => p.id === projectId);
			expect(
				item.environments.find((e: { id: string }) => e.id === staging.json.id)
					.color,
			).toBe("amber");
		});
	},
);

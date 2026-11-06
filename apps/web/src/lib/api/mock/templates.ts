import {
	dependencyOrder,
	Hostname,
	type Template,
	type TemplateSummary,
} from "@logistack/contracts";
import catalog from "@logistack/templates/catalog/index.json";
import { ApiError } from "../adapter";
import type { DeployedService, TemplatesApi } from "../templates";
import type { Deployment, Service, ServiceSpec } from "../types";
import type { MockDb } from "./fixtures";

// Root-relative through the workspace link, so the mock reads the real catalog files.
const templateFiles = import.meta.glob<Template>(
	[
		"/node_modules/@logistack/templates/catalog/*.json",
		"!**/index.json",
		"!**/skipped.json",
	],
	{ import: "default" },
);
const logoFiles = import.meta.glob<string>(
	"/node_modules/@logistack/templates/catalog/logos/*",
	{ query: "?url", import: "default", eager: true },
);

const summaries = catalog as TemplateSummary[];
const logoOf = new Map(
	summaries.flatMap((s) => {
		const url = s.logo
			? logoFiles[`/node_modules/@logistack/templates/catalog/${s.logo}`]
			: undefined;
		return url ? [[s.id, url] as const] : [];
	}),
);

function delay<T>(value: T, ms = 180 + Math.random() * 260): Promise<T> {
	return new Promise((resolve) =>
		setTimeout(() => resolve(structuredClone(value)), ms),
	);
}

const rid = (prefix: string) =>
	`${prefix}_${Math.random().toString(36).slice(2, 10)}`;

async function load(id: string): Promise<Template> {
	const file =
		templateFiles[`/node_modules/@logistack/templates/catalog/${id}.json`];
	if (!file) throw new ApiError(404, "template not found", "not_found");
	return file();
}

function specOf(s: Template["services"][number]): ServiceSpec {
	const resources = { cpu: 1, memoryMb: 512 };
	return s.kind === "database"
		? {
				kind: "database",
				engine: s.engine,
				version: s.version,
				credentialsRef: rid("cred"),
				resources,
			}
		: {
				kind: "application",
				source: { type: "image", image: s.image },
				build: { type: "image" },
				ports: s.ports,
				replicas: 1,
				resources,
				placement: [],
			};
}

/** Mirrors the server: unknown keys, bad hostnames and missing required text are refused. */
function inputIssues(t: Template, given: Record<string, string>) {
	const issues: string[] = [];
	const keys = new Set(t.inputs.map((i) => i.key));
	for (const k of Object.keys(given))
		if (!keys.has(k)) issues.push(`${k}: not an input of ${t.id}`);
	for (const i of t.inputs) {
		const v = given[i.key]?.trim() ?? "";
		if (
			i.type === "domain" &&
			v &&
			(!Hostname.safeParse(v).success || v.startsWith("*."))
		)
			issues.push(`${i.key}: not a hostname`);
		if (i.type === "text" && i.default === undefined && !v)
			issues.push(`${i.key}: required`);
	}
	return issues;
}

export const templatesMock = (db: MockDb): TemplatesApi => {
	/** Queued, then deploying, then healthy, one service after another in dependency order. */
	function progress(service: Service, deployment: Deployment, order: number) {
		const at = (ms: number, fn: () => void) =>
			setTimeout(fn, ms + order * 1_100);
		at(700, () => {
			deployment.status = "deploying";
			deployment.startedAt = new Date().toISOString();
		});
		at(2_400, () => {
			const now = new Date().toISOString();
			deployment.status = "healthy";
			deployment.finishedAt = now;
			deployment.updatedAt = now;
			service.status = {
				...service.status,
				observed: "running",
				replicasRunning: service.status.replicasDesired,
				observedAt: now,
			};
		});
	}

	return {
		list: () => delay(summaries, 260),
		get: async (id) => delay(await load(id)),
		logoUrl: (id) => logoOf.get(id) ?? "",
		deploy: async (environmentId, templateId, { name, inputs = {} }) => {
			const t = await load(templateId);
			const instance = name ?? t.id;
			const inEnv = db.services.filter(
				(s) => s.environmentId === environmentId,
			);
			const again = inEnv.filter((s) =>
				s.importedFrom?.endsWith(`:${instance}/${s.slug}`),
			);
			if (again.length)
				return delay({
					created: false,
					name: instance,
					templateId: t.id,
					stackId: again[0]?.stackId ?? "",
					services: again.map((s) => ({
						id: s.id,
						name: s.slug,
						kind: s.kind as DeployedService["kind"],
						deploymentId: null,
						hostname: s.domains[0] ?? null,
					})),
				});
			const issues = inputIssues(t, inputs);
			if (issues.length)
				throw new ApiError(
					400,
					"invalid template inputs",
					"validation_failed",
					issues,
				);
			const taken = inEnv
				.map((s) => s.slug)
				.filter((slug) => t.services.some((s) => s.name === slug));
			if (taken.length)
				throw new ApiError(
					409,
					`this environment already has services named ${taken.join(", ")}; deploy the template into another environment`,
					"conflict",
					{ conflicts: taken },
				);

			const created: DeployedService[] = [];
			const stackId = rid("stk");
			const now = new Date().toISOString();
			db.stacks.push({
				id: stackId,
				environmentId,
				name: instance,
				source: "template",
				templateId: t.id,
				git: null,
				createdBy: null,
				createdAt: now,
				updatedAt: now,
				composeYaml: null,
				composeHidden: false,
			});
			dependencyOrder(t.services).forEach((s, order) => {
				const id = rid("svc");
				const at = new Date().toISOString();
				const domainKey = s.kind === "application" ? s.public?.domain : null;
				const hostname = domainKey
					? inputs[domainKey]?.trim().toLowerCase() ||
						`${s.name}-${id.slice(-6)}.${db.publicIp.replaceAll(".", "-")}.sslip.io`
					: null;
				const deployment: Deployment = {
					id: rid("dep"),
					serviceId: id,
					status: "queued",
					trigger: "manual",
					commitSha: null,
					commitMessage: null,
					gitRef: null,
					imageRef: null,
					platforms: null,
					startedAt: null,
					finishedAt: null,
					error: null,
					reason: null,
					logPath: null,
					supersededBy: null,
					createdAt: at,
					updatedAt: at,
				};
				const service: Service = {
					id,
					environmentId,
					name: s.name,
					slug: s.name,
					kind: s.kind,
					spec: specOf(s),
					desiredState: "running",
					status: {
						observed: "starting",
						replicasRunning: 0,
						replicasDesired: 1,
						observedAt: at,
					},
					latestDeployment: deployment,
					domains: hostname ? [hostname] : [],
					nodeId: null,
					createdBy: null,
					icon: null,
					importedFrom: `template:${t.id}:${instance}/${s.name}`,
					stackId,
					createdAt: at,
					updatedAt: at,
				};
				db.services.push(service);
				db.deployments.push(deployment);
				progress(service, deployment, order);
				created.push({
					id,
					name: s.name,
					kind: s.kind,
					deploymentId: deployment.id,
					hostname,
				});
			});
			return delay(
				{
					created: true,
					name: instance,
					templateId: t.id,
					stackId,
					services: created,
				},
				900,
			);
		},
		deployment: (id) => {
			const d = db.deployments.find((x) => x.id === id);
			return d
				? delay(d, 120)
				: Promise.reject(new ApiError(404, "deployment not found"));
		},
	};
};

import type { ClientResponse } from "hono/client";
import { httpAccess } from "./access-adapter";
import { type ApiAdapter, ApiError } from "./adapter";
import { client, setupHeader } from "./client";
import { networkingHttp } from "./networking";
import { serviceOpsHttp } from "./service-ops";
import { ssoHttp } from "./sso";
import { stacksHttp } from "./stacks";
import { templatesHttp } from "./templates";
import { variablesHttp } from "./variables";

const api = client.api;

type Success<R> =
	R extends ClientResponse<infer T, infer S, "json">
		? S extends 200 | 201 | 202
			? T
			: never
		: never;

/** The success body, or an ApiError from the server's `{error:{code,message,details?}}`. */
export async function ok<R extends ClientResponse<unknown, number, "json">>(
	pending: Promise<R>,
): Promise<Success<R>> {
	const res = await pending;
	if (res.ok) return (await res.json()) as Success<R>;
	const payload = (await res.json().catch(() => null)) as {
		error?: { code?: string; message?: string; details?: unknown };
	} | null;
	throw new ApiError(
		res.status,
		payload?.error?.message ?? `${res.url} failed with ${res.status}`,
		payload?.error?.code,
		payload?.error?.details,
	);
}

/** 204 responses carry no JSON; this checks the status and drops the body. */
export async function done(
	pending: Promise<ClientResponse<unknown, number, string>>,
): Promise<void> {
	const res = await pending;
	if (!res.ok) await ok(Promise.resolve(res) as never);
}

export const httpAdapter: ApiAdapter = {
	access: httpAccess,
	instance: {
		status: () => ok(api.setup.status.$get()),
		checkDns: (hostname, setupToken) =>
			ok(
				api.setup["dns-check"].$post({
					json: { hostname },
					header: setupHeader(setupToken),
				}),
			),
		completeSetup: async (input, setupToken) => {
			await ok(
				api.setup.$post({ json: input, header: setupHeader(setupToken) }),
			);
		},
		version: () => ok(api.version.$get()),
	},
	overview: {
		get: async () => {
			const s = await ok(api.home.summary.$get());
			return {
				projectCount: s.projects,
				servicesByStatus: s.services,
				recentDeployments: s.recentDeployments,
				failedBackups: [],
				expiringCertificates: [],
			};
		},
	},
	folders: {
		// The server nests subfolders under their parent; the UI works on a flat list.
		list: async () =>
			(await ok(api.folders.$get())).flatMap(({ children, ...f }) => [
				f,
				...children,
			]),
		create: (input) => ok(api.folders.$post({ json: input })),
	},
	projects: {
		list: ({ archived = false } = {}) =>
			ok(
				api.projects.$get({
					query: archived ? { archived: "true" } : {},
				}),
			),
		get: async (id) => {
			const param = { param: { id } };
			const [project, environments] = await Promise.all([
				ok(api.projects[":id"].$get(param)),
				ok(api.projects[":id"].environments.$get(param)),
			]);
			return { ...project, environments };
		},
		create: (input) => ok(api.projects.$post({ json: input })),
		setArchived: (id, archived) =>
			ok(
				archived
					? api.projects[":id"].archive.$post({ param: { id } })
					: api.projects[":id"].unarchive.$post({ param: { id } }),
			),
		updateEnvironment: (id, input) =>
			ok(api.environments[":id"].$patch({ param: { id }, json: input })),
		createEnvironment: (id, input) =>
			ok(
				api.projects[":id"].environments.$post({ param: { id }, json: input }),
			),
		duplicateEnvironment: (id, json) =>
			ok(api.environments[":id"].duplicate.$post({ param: { id }, json })),
	},
	services: {
		listByEnvironment: (id) =>
			ok(api.environments[":id"].services.$get({ param: { id } })),
		create: async ({
			environmentId,
			name,
			spec,
			domain,
			extraDomains = [],
			mounts,
			importedFrom,
			resourceProfile,
			nodeId,
			gameToken,
		}) => {
			const service = await ok(
				api.environments[":id"].services.$post({
					param: { id: environmentId },
					json: {
						name,
						spec,
						mounts,
						importedFrom,
						resourceProfile,
						nodeId,
						gameToken,
					},
				}),
			);
			const param = { param: { id: service.id } };
			for (const d of domain ? [domain, ...extraDomains] : extraDomains) {
				if (d.kind === "generated")
					await ok(
						api.services[":id"].domains.generated.$post({
							...param,
							json: { port: d.port },
						}),
					);
				else
					await ok(
						api.services[":id"].domains.$post({
							...param,
							json: {
								hostname: d.hostname,
								port: d.port,
								https: d.https,
								cert: "auto",
							},
						}),
					);
			}
			await ok(api.services[":id"].deploy.$post(param));
			return service;
		},
		checkSource: (source) =>
			ok(api.services["check-source"].$post({ json: source })),
	},
	nodes: {
		list: () => ok(api.nodes.$get()),
		get: (id) => ok(api.nodes[":id"].$get({ param: { id } })),
		update: (id, json) => ok(api.nodes[":id"].$patch({ param: { id }, json })),
		remove: (id) => ok(api.nodes[":id"].$delete({ param: { id } })),
		disk: (id) => ok(api.nodes[":id"].disk.$get({ param: { id } })),
		prune: (id, json) =>
			ok(api.nodes[":id"].disk.prune.$post({ param: { id }, json })),
		hostDirs: (id, path) =>
			ok(
				api.nodes[":id"]["host-dirs"].$get({ param: { id }, query: { path } }),
			),
	},
	joins: {
		create: (json) => ok(api.nodes.joins.$post({ json })),
		get: (id) => ok(api.nodes.joins[":id"].$get({ param: { id } })),
		update: (id, json) =>
			ok(api.nodes.joins[":id"].$put({ param: { id }, json })),
		run: (id, step) =>
			ok(api.nodes.joins[":id"].steps.$post({ param: { id }, json: { step } })),
	},
	metrics: {
		hosts: ({ range, nodeId, perNode }) =>
			ok(
				api.metrics.hosts.$get({
					query: { range, nodeId, perNode: perNode ? "true" : "false" },
				}),
			),
		service: (id, range) =>
			ok(api.metrics.services[":id"].$get({ param: { id }, query: { range } })),
		usage: (range) => ok(api.usage.$get({ query: { range } })),
		projectUsage: (id, range) =>
			ok(api.projects[":id"].usage.$get({ param: { id }, query: { range } })),
	},
	monitoring: {
		settings: () => ok(api.monitoring.settings.$get()),
		save: (json) => ok(api.monitoring.settings.$put({ json })),
		serviceThresholds: (id) =>
			ok(api.services[":id"].thresholds.$get({ param: { id } })),
		saveServiceThresholds: (id, json) =>
			ok(api.services[":id"].thresholds.$put({ param: { id }, json })),
	},
	networking: networkingHttp,
	serviceOps: serviceOpsHttp,
	sso: ssoHttp,
	stacks: stacksHttp,
	templates: templatesHttp,
	variables: variablesHttp,
};

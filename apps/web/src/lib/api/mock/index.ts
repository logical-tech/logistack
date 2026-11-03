import { type ApiAdapter, ApiError } from "../adapter";
import type {
	Deployment,
	DeploymentListItem,
	ObservedStatus,
	ProjectSummary,
	Service,
} from "../types";
import { mockAccess } from "./access";
import { createMockDb } from "./fixtures";
import { monitoringAdapter } from "./monitoring";
import { networkingMock } from "./networking";
import { serviceOpsMock } from "./service-ops";
import { ssoMock } from "./sso";
import { templatesMock } from "./templates";

const db = createMockDb();

/** The storage mock reads services and projects from the same in-memory world. */
export { db as mockDb };

/** Realistic, jittered latency so loading states are seen in dev. */
function delay<T>(value: T, ms = 220 + Math.random() * 380): Promise<T> {
	return new Promise((resolve) =>
		setTimeout(() => resolve(structuredClone(value)), ms),
	);
}

const rid = (prefix: string) =>
	`${prefix}_${Math.random().toString(36).slice(2, 10)}`;

const slugify = (name: string) =>
	name
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "") || "untitled";

function contextOf(serviceId: Service["id"]) {
	const service = db.services.find((s) => s.id === serviceId);
	const env = db.environments.find((e) => e.id === service?.environmentId);
	const project = db.projects.find((p) => p.id === env?.projectId);
	if (!service || !env || !project) {
		throw new Error(`mock: dangling service ${serviceId}`);
	}
	return { service, env, project };
}

function listItem(d: Deployment): DeploymentListItem {
	const { service, env, project } = contextOf(d.serviceId);
	return {
		...d,
		service: { id: service.id, name: service.name },
		project: { id: project.id, name: project.name },
		environment: { id: env.id, name: env.name },
	};
}

function summarize(projectId: ProjectSummary["id"]): ProjectSummary {
	const project = db.projects.find((p) => p.id === projectId);
	if (!project) throw new Error(`mock: unknown project ${projectId}`);
	const envs = db.environments.filter((e) => e.projectId === projectId);
	const envIds = new Set(envs.map((e) => e.id));
	return {
		...project,
		environments: envs.map(({ id, name, kind }) => ({ id, name, kind })),
		services: db.services
			.filter((s) => envIds.has(s.environmentId))
			.map((s) => ({ id: s.id, name: s.name, status: s.status.observed })),
	};
}

export const mockAdapter: ApiAdapter = {
	...monitoringAdapter,
	access: mockAccess,
	instance: {
		status: () =>
			delay(
				{
					setupCompleted: db.setupCompleted,
					hasUsers: db.setupCompleted,
					publicIp: db.publicIp,
					authProviders: { github: true, google: false },
				},
				120,
			),
		checkDns: (hostname) => {
			const generated = /\.(sslip|nip)\.io$/.test(hostname);
			const ok =
				generated || !/(^|\.)example\.(com|org)$|\.invalid$/.test(hostname);
			return delay(
				{
					hostname,
					expected: db.publicIp,
					resolved: ok ? [db.publicIp] : [],
					ok,
				},
				900,
			);
		},
		completeSetup: () => {
			db.setupCompleted = true;
			return delay(undefined, 1200);
		},
		version: () => delay({ version: "0.1.0", commit: "98edb6e" }, 120),
	},
	overview: {
		get: () => {
			const servicesByStatus: Record<ObservedStatus, number> = {
				running: 0,
				starting: 0,
				unhealthy: 0,
				stopped: 0,
				failed: 0,
				unknown: 0,
			};
			for (const s of db.services) servicesByStatus[s.status.observed] += 1;
			const recent = [...db.deployments]
				.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
				.slice(0, 8)
				.map(listItem);
			return delay({
				projectCount: db.projects.length,
				servicesByStatus,
				recentDeployments: recent,
				failedBackups: db.backupRuns.map((run) => {
					const serviceId = db.backupServiceIds[run.id];
					if (!serviceId) throw new Error(`mock: backup ${run.id} unlinked`);
					const { service, project } = contextOf(serviceId);
					return {
						...run,
						service: { id: service.id, name: service.name },
						project: { id: project.id, name: project.name },
					};
				}),
				expiringCertificates: db.certificates,
			});
		},
	},
	folders: {
		list: () => delay(db.folders),
		create: ({ name, parentId }) => {
			const parent = db.folders.find((f) => f.id === parentId);
			if (parentId && !parent) {
				return Promise.reject(new ApiError(404, "Parent folder not found"));
			}
			if (parent?.parentId) {
				return Promise.reject(
					new ApiError(422, "Folders can be nested two levels deep at most."),
				);
			}
			const at = new Date().toISOString();
			const folder = {
				id: rid("fld"),
				organizationId: "org_logical",
				parentId: parentId ?? null,
				name,
				slug: slugify(name),
				position: db.folders.filter((f) => f.parentId === parentId).length,
				createdAt: at,
				updatedAt: at,
			};
			db.folders.push(folder);
			return delay(folder, 400);
		},
	},
	projects: {
		list: () => delay(db.projects.map((p) => summarize(p.id))),
		get: (id) => {
			const project = db.projects.find((p) => p.id === id);
			if (!project)
				return Promise.reject(new ApiError(404, "Project not found"));
			return delay({
				...project,
				environments: db.environments.filter((e) => e.projectId === id),
			});
		},
		create: ({ name, description, folderId }) => {
			const id = rid("prj");
			const at = new Date().toISOString();
			const project = {
				id,
				organizationId: "org_logical",
				folderId: folderId ?? null,
				name,
				slug: slugify(name),
				description: description ?? null,
				createdAt: at,
				updatedAt: at,
			};
			db.projects.push(project);
			db.environments.push({
				id: `env_${id.slice(4)}_production`,
				projectId: id,
				name: "Production",
				slug: "production",
				kind: "production",
				isDefault: true,
				createdAt: at,
				updatedAt: at,
			});
			return delay(project, 500);
		},
	},
	services: {
		listByEnvironment: (environmentId) =>
			delay(db.services.filter((s) => s.environmentId === environmentId)),
		create: ({ environmentId, name, spec, domain, extraDomains = [] }) => {
			const id = rid("svc");
			const at = new Date().toISOString();
			const deployment: Deployment = {
				id: rid("dep"),
				serviceId: id,
				status: "queued",
				trigger: "manual",
				commitSha: null,
				commitMessage: null,
				imageRef: null,
				startedAt: null,
				finishedAt: null,
				error: null,
				logPath: null,
				supersededBy: null,
				createdAt: at,
				updatedAt: at,
			};
			const service: Service = {
				id,
				environmentId,
				name,
				slug: slugify(name),
				kind: spec.kind,
				spec,
				desiredState: "running",
				status: {
					observed: "starting",
					replicasRunning: 0,
					replicasDesired: spec.kind === "application" ? spec.replicas : 1,
					observedAt: at,
				},
				latestDeployment: deployment,
				domains: (domain ? [domain, ...extraDomains] : extraDomains).map(
					(d, i) =>
						d.kind === "custom"
							? d.hostname
							: `${slugify(name)}${i ? `-${i}` : ""}-${id.slice(-6)}.${db.publicIp.replaceAll(".", "-")}.sslip.io`,
				),
				nodeId: null,
				createdBy: null,
				importedFrom: null,
				createdAt: at,
				updatedAt: at,
			};
			db.services.push(service);
			db.deployments.push(deployment);
			return delay(service, 700);
		},
		checkSource: (source) => {
			if (source.type === "image") {
				const ok =
					/^[a-z0-9][\w./-]*(:[\w.-]+)?(@sha256:[a-f0-9]{64})?$/i.test(
						source.image,
					) && !source.image.includes("notfound");
				return delay(
					ok
						? {
								ok,
								message: "Image found",
								detail:
									"Manifest for linux/amd64 and linux/arm64 · 48.2 MB compressed",
							}
						: {
								ok,
								message: "Image not found",
								detail: `The registry returned 404 for ${source.image}. Check the name and tag, or add registry credentials.`,
							},
					1100,
				);
			}
			const privateRepo = /private|secret/.test(source.repository);
			return delay(
				privateRepo
					? {
							ok: false,
							message: "No access to this repository",
							detail:
								"Connect a Git provider that can read it under Integrations → Git providers, then test again.",
						}
					: {
							ok: true,
							message: `Branch ${source.branch} found`,
							detail: "Latest commit 8f3c2a1 · Dockerfile detected at the root",
						},
				1100,
			);
		},
	},
	networking: networkingMock,
	serviceOps: serviceOpsMock(db),
	sso: ssoMock,
	templates: templatesMock(db),
};

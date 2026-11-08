import { ApiError } from "../adapter";
import type {
	DeploymentRow,
	EffectiveEnvVar,
	PendingDiff,
	ServiceOpsApi,
	ServiceOverview,
} from "../service-ops";
import type { Service } from "../types";
import type { MockDb } from "./fixtures";
import type { SecretsStore } from "./secrets";
import type { VariablesStore } from "./variables";

const delay = <T>(value: T, ms = 180 + Math.random() * 260): Promise<T> =>
	new Promise((resolve) =>
		setTimeout(() => resolve(structuredClone(value)), ms),
	);
const rid = (prefix: string) =>
	`${prefix}_${Math.random().toString(36).slice(2, 10)}`;
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

const E = "\x1b";
const BUILD_LOG = [
	`${E}[2m#1${E}[0m resolve image config for docker.io/library/node:22-alpine`,
	`${E}[2m#2${E}[0m [internal] load build context`,
	`${E}[2m#3${E}[0m ${E}[34m[deps 1/3]${E}[0m RUN pnpm install --frozen-lockfile`,
	"Progress: resolved 812, reused 790, downloaded 22, added 812, done",
	`${E}[2m#4${E}[0m ${E}[34m[build 2/3]${E}[0m RUN pnpm build`,
	`${E}[32m✓${E}[0m Compiled successfully in 8.4s`,
	`${E}[33mwarn${E}[0m  Bundle size of /checkout exceeds 250 kB`,
	`${E}[2m#5${E}[0m exporting to image`,
	`${E}[1mpushing${E}[0m registry.logical.it/logical/storefront-web`,
	`${E}[32mhealthy${E}[0m 2/2 replicas passed the http check on :3000/`,
];
const RUNTIME_LOG = [
	`${E}[32mready${E}[0m - started server on 0.0.0.0:3000`,
	'10.0.1.12 - - "GET / HTTP/1.1" 200 5123 "-" "Mozilla/5.0"',
	'10.0.1.12 - - "GET /products/oak-chair HTTP/1.1" 200 8811 "-" "Mozilla/5.0"',
	`${E}[33mwarn${E}[0m slow query on /api/cart (412 ms)`,
	'10.0.1.9 - - "POST /api/cart HTTP/1.1" 201 312 "-" "Mozilla/5.0"',
	`${E}[31merror${E}[0m payment provider timed out, retrying`,
];

const MOCK_CHANGES: PendingDiff["changes"] = [
	{
		summary: "image node:22-alpine → node:24-alpine",
		change: {
			area: "image",
			before: "node:22-alpine",
			after: "node:24-alpine",
		},
	},
	{
		summary: "env var API_URL changed",
		change: {
			area: "env",
			op: "changed",
			key: "API_URL",
			secret: false,
			before: "https://api.storefront.example.com",
			after: "https://api-v2.storefront.example.com",
		},
	},
	{
		summary: "env var STRIPE_SECRET_KEY changed",
		change: {
			area: "env",
			op: "changed",
			key: "STRIPE_SECRET_KEY",
			secret: true,
		},
	},
	{
		summary: "env var FEATURE_CHECKOUT_V2 added",
		change: {
			area: "env",
			op: "added",
			key: "FEATURE_CHECKOUT_V2",
			secret: false,
			after: "true",
		},
	},
	{
		summary: "domain shop.example.com added",
		change: { area: "domain", op: "added", hostname: "shop.example.com" },
	},
	{
		summary: "memory limit 512 MB → 1 GB",
		change: {
			area: "resources",
			resource: "memory",
			before: 536870912,
			after: 1073741824,
		},
	},
	{
		summary: "volume mount /data/cache removed",
		change: {
			area: "mount",
			op: "removed",
			target: "/data/cache",
			before: { type: "volume", source: "ls-vol-x1y2z3", readOnly: false },
		},
	},
];

export function serviceOpsMock(
	db: MockDb,
	shared: VariablesStore,
	secrets: SecretsStore,
): ServiceOpsApi {
	const find = (id: string) => {
		const service = db.services.find((s) => s.id === id);
		if (!service) throw new ApiError(404, "Service not found");
		return service;
	};
	const deploymentsOf = (id: string) =>
		db.deployments
			.filter((d) => d.serviceId === id)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	const record = ({ status, latestDeployment, domains, ...rest }: Service) =>
		rest;
	const queue = (
		serviceId: Service["id"],
		trigger: DeploymentRow["trigger"],
		from?: DeploymentRow,
	): DeploymentRow => {
		const d: DeploymentRow = {
			id: rid("dep"),
			serviceId,
			status: "queued",
			trigger,
			commitSha: from?.commitSha ?? null,
			commitMessage: from?.commitMessage ?? null,
			gitRef: null,
			imageRef: from?.imageRef ?? null,
			platforms: from?.platforms ?? null,
			startedAt: iso(),
			finishedAt: null,
			error: null,
			reason: null,
			logPath: null,
			supersededBy: null,
			warning: null,
			createdAt: iso(),
			updatedAt: iso(),
		};
		db.deployments.push(d);
		// The worker of the mock: deploying after a moment (releasing first with a pre-deploy), healthy after a few.
		const spec = db.services.find((s) => s.id === serviceId)?.spec;
		const release = spec?.kind === "application" && !!spec.preDeploy;
		if (release)
			setTimeout(() => Object.assign(d, { status: "releasing" }), 500);
		setTimeout(
			() => Object.assign(d, { status: "deploying" }),
			release ? 4000 : 1500,
		);
		setTimeout(
			() => Object.assign(d, { status: "healthy", finishedAt: iso() }),
			release ? 8000 : 6000,
		);
		return d;
	};
	/** Service-scope variables; the scopes above come from the shared store. */
	const vars = new Map<string, EffectiveEnvVar[]>();
	const own = (s: Service): EffectiveEnvVar[] => {
		const existing = vars.get(s.id);
		if (existing) return existing;
		const v = (
			key: string,
			value: string | null,
			secretId: string | null = null,
		): EffectiveEnvVar => ({
			id: rid("env"),
			scope: "service",
			scopeId: s.id,
			key,
			value: secretId ? null : value,
			isSecret: secretId !== null,
			secretId,
			asFile: false,
			isBuildTime: false,
			overridden: false,
			createdAt: iso(86_400_000 * 20),
			updatedAt: iso(86_400_000 * 2),
		});
		const ref = (key: string, secret?: { id: string }) =>
			secret ? [v(key, null, secret.id)] : [];
		const list = [
			v("PORT", "3000"),
			...ref(
				"SESSION_SECRET",
				secrets.serviceSecret(s.id, "SESSION_SECRET", "s3cr3t-session-value"),
			),
		];
		if (s.environmentId === "env_storefront_production")
			list.push(
				...ref(
					"STRIPE_SECRET_KEY",
					secrets.byKey("project", "prj_storefront", "STRIPE_SECRET_KEY"),
				),
				...ref(
					"DB_PASSWORD",
					secrets.byKey(
						"environment",
						"env_storefront_production",
						"DATABASE_PASSWORD",
					),
				),
			);
		// A reference left behind when Booking API moved from Acme to Nordwind: shows as broken.
		if (s.id === "svc_booking_production_api")
			list.push(
				...ref(
					"SFTP_PASSWORD",
					secrets.byKey("folder", "fld_acme", "ACME_SFTP_PASSWORD"),
				),
			);
		vars.set(
			s.id,
			list.sort((a, b) => a.key.localeCompare(b.key)),
		);
		return list;
	};
	secrets.setRefs(() =>
		db.services.flatMap((s) =>
			own(s).flatMap((v) =>
				v.secretId
					? [
							{
								envVarId: v.id,
								key: v.key,
								serviceId: s.id,
								secretId: v.secretId,
							},
						]
					: [],
			),
		),
	);
	const rank = ["organization", "project", "environment", "service"];
	const varsOf = (s: Service): EffectiveEnvVar[] => {
		const env = db.environments.find((e) => e.id === s.environmentId);
		const all = [
			...shared.get("organization", "org_logical"),
			...shared.get("project", env?.projectId ?? ""),
			...shared.get("environment", s.environmentId),
			...own(s),
		];
		return all
			.map((v) => ({
				...v,
				overridden: all.some(
					(o) =>
						o.key === v.key && rank.indexOf(o.scope) > rank.indexOf(v.scope),
				),
			}))
			.sort(
				(a, b) =>
					a.key.localeCompare(b.key) ||
					rank.indexOf(a.scope) - rank.indexOf(b.scope),
			);
	};

	return {
		overview: async (id) => {
			const s = find(id);
			const [env, deps] = [
				db.environments.find((e) => e.id === s.environmentId),
				deploymentsOf(id),
			];
			const replicas = s.status.replicasDesired;
			const overview: ServiceOverview = {
				...record(s),
				projectId: env?.projectId ?? "prj_unknown",
				environmentName: env?.name ?? "Production",
				status: {
					...s.status,
					tasks: Array.from({ length: s.status.replicasRunning }, (_, i) => ({
						id: `task${i + 1}${s.id.slice(-4)}`,
						slot: i + 1,
						nodeId: `swarm_fra${(i % 2) + 1}`,
						hostname: `fra-${(i % 2) + 1}`,
						state: "running",
						message: "started",
						error: null,
						at: iso(3_600_000 * (i + 2)),
						containerName: `ls-svc-${s.id.slice(4)}.${i + 1}.task${i + 1}${s.id.slice(-4)}`,
					})).slice(0, replicas),
					crashLoop:
						s.status.observed === "failed"
							? {
									since: iso(8 * 60_000),
									failures: 4,
									reason: "task: non-zero exit (1)",
									exitCode: 1,
								}
							: null,
				},
				current: deps.find((d) => d.status === "healthy") ?? null,
				latest: deps[0] ?? null,
			};
			return delay(overview);
		},
		update: async (id, patch) => {
			const s = find(id);
			Object.assign(s, patch, { updatedAt: iso() });
			return delay(record(s));
		},
		remove: async (id) => {
			db.services = db.services.filter((s) => s.id !== find(id).id);
			return delay(undefined);
		},
		deployments: async (id, limit) =>
			delay(deploymentsOf(id).slice(0, limit), 160),
		deploy: async (id) => delay(queue(find(id).id, "manual")),
		pendingDiff: async (id) => {
			const current = deploymentsOf(find(id).id).find(
				(d) => d.status === "healthy",
			);
			if (!current) return delay({ baseline: null, changes: [] });
			return delay({
				baseline: { deploymentId: current.id, createdAt: current.createdAt },
				changes: MOCK_CHANGES,
			});
		},
		restart: async (id) => {
			const current = deploymentsOf(id).find((d) => d.status === "healthy");
			if (!current)
				throw new ApiError(
					409,
					"the service has no healthy deployment to restart",
				);
			return delay(queue(find(id).id, "manual", current));
		},
		stop: async (id) => {
			const s = find(id);
			s.desiredState = "stopped";
			s.status = { ...s.status, observed: "stopped", replicasRunning: 0 };
			return delay(record(s));
		},
		start: async (id) => {
			const s = find(id);
			s.desiredState = "running";
			s.status = {
				...s.status,
				observed: "running",
				replicasRunning: s.status.replicasDesired,
			};
			return delay(record(s));
		},
		rollback: async (id) => {
			const target = db.deployments.find((d) => d.id === id);
			if (target?.status !== "healthy")
				throw new ApiError(
					409,
					"only a healthy deployment can be rolled back to",
				);
			return delay(queue(target.serviceId, "rollback", target));
		},
		cancel: async (id) => {
			const d = db.deployments.find((x) => x.id === id);
			if (
				!d ||
				!["queued", "cloning", "building", "pushing", "releasing"].includes(
					d.status,
				)
			)
				throw new ApiError(409, "this deployment can no longer be cancelled");
			Object.assign(d, { status: "cancelled", finishedAt: iso() });
			return delay(d);
		},
		envVars: async (id) => delay(varsOf(find(id))),
		saveEnvVars: async (id, variables) => {
			const s = find(id);
			const previous = own(s);
			const onChain = new Set(secrets.available(id).map((x) => x.id));
			const outside = variables.flatMap((v) =>
				v.secretId && !onChain.has(v.secretId) ? [v.secretId] : [],
			);
			if (outside.length)
				throw new ApiError(
					400,
					"a referenced secret is not defined on this service's chain, or you cannot read its scope",
					"bad_request",
					{ secretIds: outside },
				);
			const missing = variables.filter((v) => {
				if (v.secretId || v.value !== undefined) return false;
				const prev = previous.find((p) => p.key === v.key);
				return !prev || prev.isSecret !== v.isSecret;
			});
			if (missing.length)
				throw new ApiError(400, "a new variable needs a value", "bad_request", {
					keys: missing.map((v) => v.key),
				});
			// shortcut: service secrets this save leaves unreferenced stay listed; the server drops them.
			vars.set(
				id,
				variables.map((input): EffectiveEnvVar => {
					const prev = previous.find((p) => p.key === input.key);
					const base = prev ?? {
						id: rid("env"),
						scope: "service" as const,
						scopeId: s.id,
						createdAt: iso(),
						overridden: false,
						value: null,
						isSecret: false,
						secretId: null,
						asFile: false,
					};
					const kind = input.secretId
						? { isSecret: true, secretId: input.secretId, value: null }
						: input.isSecret && input.value !== undefined
							? {
									isSecret: true,
									secretId: secrets.serviceSecret(s.id, input.key, input.value)
										.id,
									value: null,
								}
							: input.value !== undefined
								? { isSecret: false, secretId: null, value: input.value }
								: {};
					return {
						...base,
						...kind,
						asFile: !!input.asFile && (kind.isSecret ?? base.isSecret),
						key: input.key,
						isBuildTime: input.isBuildTime,
						updatedAt: iso(),
					};
				}),
			);
			return delay(undefined);
		},
		exec: () =>
			Promise.reject(
				new ApiError(403, "The mock API has no terminal.", "forbidden"),
			),
		streamLogs: (source, fn) => {
			const channel = `${source.kind}:${source.id}`;
			const lines = source.kind === "deployment" ? BUILD_LOG : RUNTIME_LOG;
			let i = 0;
			const timer = setInterval(() => {
				const line = lines[i % lines.length] as string;
				fn({
					type: "line",
					channel,
					line,
					seq: source.kind === "deployment" ? i : undefined,
					at: iso(),
					slot: source.kind === "service" ? (i % 2) + 1 : undefined,
					stream: "stdout",
				});
				i += 1;
				if (source.kind === "deployment" && i === lines.length) {
					clearInterval(timer);
					fn({ type: "end", channel, reason: "healthy" });
				}
			}, 120);
			return () => clearInterval(timer);
		},
	};
}

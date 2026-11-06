import { ApiError } from "../adapter";
import type { ManifestApi, ManifestChange, ManifestScope } from "../manifest";
import { mockDb as db } from ".";

function delay<T>(value: T, ms = 300 + Math.random() * 400): Promise<T> {
	return new Promise((resolve) =>
		setTimeout(() => resolve(structuredClone(value)), ms),
	);
}

function scoped({ kind, id }: ManifestScope) {
	const env =
		kind === "environment"
			? db.environments.find((e) => e.id === id)
			: undefined;
	const project = db.projects.find(
		(p) => p.id === (kind === "project" ? id : env?.projectId),
	);
	if (!project) throw new ApiError(404, `${kind} not found`, "not_found");
	const envs = env
		? [env]
		: db.environments.filter((e) => e.projectId === project.id);
	return { project, envs };
}

function exportYaml(scope: ManifestScope) {
	const { project, envs } = scoped(scope);
	// `first` prefixes an environment's first line: "- " inside the project's list.
	const envYaml = (e: (typeof envs)[number], pad: string, first: string) => [
		`${first}name: ${e.name}`,
		`${pad}slug: ${e.slug}`,
		`${pad}kind: ${e.kind}`,
		`${pad}services:`,
		...db.services
			.filter((s) => s.environmentId === e.id)
			.flatMap((s) => [
				`${pad}  - name: ${s.name}`,
				`${pad}    slug: ${s.slug}`,
				`${pad}    spec:`,
				`${pad}      kind: ${s.spec.kind}`,
			]),
	];
	const lines = [
		`# yaml-language-server: $schema=${location.origin}/api/manifest/schema.json`,
		"version: 1",
		`kind: ${scope.kind}`,
		...(scope.kind === "project"
			? [
					"project:",
					`  name: ${project.name}`,
					"environments:",
					...envs.flatMap((e) => envYaml(e, "    ", "  - ")),
				]
			: ["environment:", ...envs.flatMap((e) => envYaml(e, "  ", "  "))]),
	];
	return `${lines.join("\n")}\n`;
}

/** The mock reads nothing from the file: a fixed, plausible plan against the first environment. */
function plan(scope: ManifestScope, prune: boolean): ManifestChange[] {
	const { envs } = scoped(scope);
	const env = envs[0];
	if (!env) return [];
	const services = db.services.filter((s) => s.environmentId === env.id);
	const [first, ...rest] = services;
	const changes: ManifestChange[] = [];
	if (scope.kind === "project")
		changes.push({
			op: "update",
			resource: "variable",
			name: "SENTRY_DSN",
			changes: ["value changed"],
		});
	if (first)
		changes.push(
			{
				op: "update",
				resource: "service",
				environment: env.slug,
				name: first.slug,
				changes: ["replicas 2 → 3", "health check path /health → /healthz"],
			},
			{
				op: "create",
				resource: "domain",
				environment: env.slug,
				service: first.slug,
				name: `www.${first.domains[0] ?? "example.com"}`,
				changes: ["port 3000, HTTPS, automatic certificate"],
			},
			{
				op: "update",
				resource: "variable",
				environment: env.slug,
				service: first.slug,
				name: "LOG_LEVEL",
				changes: ["value changed"],
			},
		);
	changes.push(
		{
			op: "create",
			resource: "service",
			environment: env.slug,
			name: "mailer",
			changes: ["image ghcr.io/logical-tech/mailer:1.4.0", "1 replica"],
		},
		{
			op: "create",
			resource: "backup",
			environment: env.slug,
			service: "mailer",
			name: "volume /data 0 3 * * *",
			changes: ["to backups-eu, keep 7 daily", "encrypted"],
		},
	);
	if (prune)
		for (const s of rest.slice(-1))
			changes.push({
				op: "delete",
				resource: "service",
				environment: env.slug,
				name: s.slug,
				changes: ["not in the manifest"],
			});
	return changes;
}

export const mockManifest: ManifestApi = {
	export: async (scope) => delay(exportYaml(scope), 400),
	apply: async (scope, { manifest, prune, dryRun }) => {
		if (!/\bkind\b/.test(manifest))
			throw new ApiError(
				400,
				"This is not a LogiStack manifest",
				"validation_failed",
				["kind: required, project or environment"],
			);
		// A manifest that lists no services reads as already applied, so the empty plan is reachable.
		const changes = /\bservices\b/.test(manifest) ? plan(scope, prune) : [];
		const env = scoped(scope).envs[0];
		return delay(
			{
				applied: !dryRun,
				changes,
				warnings: [
					"Secret DATABASE_URL has no value in the manifest; the stored value is kept.",
				],
				backupKeys:
					dryRun || !env || !changes.length
						? []
						: [
								{
									environment: env.slug,
									service: "mailer",
									backup: "volume /data 0 3 * * *",
									key: "AGE-SECRET-KEY-1QZ8M5LNE0K3V9W7XJ2Y4T6R8P0S2U4W6Y8A0C2E4G6J8L0N2Q4S6U8W0",
								},
							],
			},
			dryRun ? 700 : 1100,
		);
	},
};

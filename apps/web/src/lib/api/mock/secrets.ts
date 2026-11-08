import { ApiError } from "../adapter";
import type {
	AvailableSecret,
	SecretMeta,
	SecretProvider,
	SecretScope,
	SecretsApi,
	SecretUsage,
} from "../secrets";
import type { MockDb } from "./fixtures";

const ORG = "org_logical";
// Not imported from ../secrets: that module imports the adapter, which awaits this mock.
const SCOPE_RANK: Record<SecretScope, number> = {
	organization: 0,
	folder: 1,
	project: 2,
	environment: 3,
	service: 4,
};
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const DAY = 86_400_000;
const rid = () => `sec_${Math.random().toString(36).slice(2, 10)}`;
const delay = <T>(value: T, ms = 160 + Math.random() * 240): Promise<T> =>
	new Promise((r) => setTimeout(() => r(structuredClone(value)), ms));

type Version = { version: number; value: string; by: string; at: string };
type Row = {
	id: string;
	scope: SecretScope;
	scopeId: string;
	key: string;
	description: string | null;
	/** Empty for an external secret. */
	versions: Version[];
	/** Read from a provider at deploy time: `<path>#<key>` after `secret://<name>/`. */
	external?: { providerId: string; ref: string };
	createdAt: string;
};
/** A service variable that references a secret, as the service-ops mock reports it. */
export type SecretRef = {
	envVarId: string;
	key: string;
	serviceId: string;
	secretId: string;
};

/**
 * Secrets like the server keeps them: versioned values, metadata-only lists, reveal by
 * version, usages from service references, 409 on deleting a used one.
 */
export function secretsStore(db: MockDb) {
	const rows: Row[] = [];
	let keyVersion = 1;
	const add = (
		scope: SecretScope,
		scopeId: string,
		key: string,
		values: string[],
		description: string | null = null,
	) => {
		const row: Row = {
			id: rid(),
			scope,
			scopeId,
			key,
			description,
			createdAt: iso(DAY * 40),
			versions: values.map((value, i) => ({
				version: i + 1,
				value,
				by: i % 2 ? "usr_giulia" : "usr_simone",
				at: iso(DAY * (30 - i * 9)),
			})),
		};
		rows.push(row);
		return row;
	};
	add(
		"organization",
		ORG,
		"RESEND_API_KEY",
		["re_9fK2mQ7xLp"],
		"Transactional email",
	);
	add("organization", ORG, "SENTRY_AUTH_TOKEN", ["sntrys_a1", "sntrys_b2"]);
	add(
		"folder",
		"fld_acme",
		"ACME_SFTP_PASSWORD",
		["Rk7!pq2Z"],
		"Acme's nightly order export",
	);
	add("project", "prj_storefront", "STRIPE_SECRET_KEY", [
		"sk_live_51Hx0a",
		"sk_live_51Hx0b",
		"sk_live_51Hx0c",
	]);
	add("project", "prj_storefront", "STRIPE_WEBHOOK_SECRET", ["whsec_7Gm2"]);
	add("environment", "env_storefront_production", "DATABASE_PASSWORD", [
		"Xk29fQ7m",
		"Pz81tR4c",
	]);
	add("environment", "env_storefront_staging", "DATABASE_PASSWORD", [
		"stg-Lq3v",
	]);
	add("project", "prj_booking", "AMADEUS_API_SECRET", ["am_s3cr3t"]);

	const providers: SecretProvider[] = [
		{
			id: "ssp_vaultprod",
			kind: "vault",
			name: "vault-prod",
			url: "https://vault.logical.internal:8200",
			secrets: 0,
			createdAt: iso(DAY * 12),
			updatedAt: iso(DAY * 12),
		},
	];
	const external = (
		scope: SecretScope,
		scopeId: string,
		key: string,
		providerId: string,
		ref: string,
	) => {
		const row = add(scope, scopeId, key, []);
		row.external = { providerId, ref };
		return row;
	};
	external(
		"organization",
		ORG,
		"OPENAI_API_KEY",
		"ssp_vaultprod",
		"secret/shared/openai#api_key",
	);
	const providerByName = (reference: string) => {
		const m = /^secret:\/\/([a-z0-9-]+)\/(.+#.+)$/.exec(reference.trim());
		const p = m && providers.find((x) => x.name === m[1]);
		if (!m || !p)
			throw new ApiError(
				400,
				`no secret provider named "${m?.[1] ?? ""}"; add it in Integrations > Secret providers`,
				"validation_failed",
			);
		return { providerId: p.id, ref: m[2] as string };
	};

	/** Replaced by the service-ops mock, which owns service variables. */
	let refs: () => SecretRef[] = () => [];

	const find = (id: string) => {
		const row = rows.find((r) => r.id === id);
		if (!row) throw new ApiError(404, "Secret not found", "not_found");
		return row;
	};
	const current = (r: Row) => r.versions[r.versions.length - 1] as Version;
	const externalOf = (r: Row): SecretMeta["external"] => {
		const p =
			r.external && providers.find((x) => x.id === r.external?.providerId);
		if (!r.external || !p) return null;
		return {
			providerId: p.id,
			providerName: p.name,
			kind: p.kind,
			reference: `secret://${p.name}/${r.external.ref}`,
			checkedAt: iso(DAY / 8),
			error: null,
		};
	};
	const meta = (r: Row): SecretMeta => ({
		id: r.id,
		scope: r.scope,
		scopeId: r.scopeId,
		key: r.key,
		description: r.description,
		version: r.versions.at(-1)?.version ?? 0,
		usedBy: refs().filter((x) => x.secretId === r.id).length,
		external: externalOf(r),
		updatedBy: r.versions.at(-1)?.by ?? "usr_simone",
		createdAt: r.createdAt,
		updatedAt: r.versions.at(-1)?.at ?? r.createdAt,
	});
	const externalOnly = (r: Row) => {
		if (r.external)
			throw new ApiError(
				400,
				`${r.key} is read from an external provider at deploy time; change its value there`,
				"bad_request",
			);
	};
	const usages = (id: string): SecretUsage[] =>
		refs()
			.filter((x) => x.secretId === id)
			.flatMap((x) => {
				const svc = db.services.find((s) => s.id === x.serviceId);
				const env = db.environments.find((e) => e.id === svc?.environmentId);
				if (!svc || !env) return [];
				return [
					{
						envVarId: x.envVarId,
						key: x.key,
						serviceId: svc.id,
						serviceName: svc.name,
						environmentId: env.id,
						projectId: env.projectId,
					},
				];
			});

	/** Scope links from the service up to the organization, with display names. */
	const chain = (serviceId: string) => {
		const svc = db.services.find((s) => s.id === serviceId);
		if (!svc) throw new ApiError(404, "Service not found", "not_found");
		const env = db.environments.find((e) => e.id === svc.environmentId);
		const project = db.projects.find((p) => p.id === env?.projectId);
		const links: { scope: SecretScope; id: string; name: string }[] = [
			{ scope: "service", id: svc.id, name: svc.name },
		];
		if (env) links.push({ scope: "environment", id: env.id, name: env.name });
		if (project)
			links.push({ scope: "project", id: project.id, name: project.name });
		let folder = db.folders.find((f) => f.id === project?.folderId);
		while (folder) {
			links.push({ scope: "folder", id: folder.id, name: folder.name });
			const parent = folder.parentId;
			folder = db.folders.find((f) => f.id === parent);
		}
		links.push({ scope: "organization", id: ORG, name: "" });
		return links;
	};
	const available = (serviceId: string): AvailableSecret[] => {
		const links = chain(serviceId);
		const on = rows
			.map((r) => ({
				r,
				link: links.find((l) => l.scope === r.scope && l.id === r.scopeId),
				depth: links.findIndex(
					(l) => l.scope === r.scope && l.id === r.scopeId,
				),
			}))
			.filter((x) => x.link);
		return on
			.map(({ r, link, depth }) => ({
				...meta(r),
				scopeName: link?.name ?? "",
				shadowed: on.some((o) => o.r.key === r.key && o.depth < depth),
			}))
			.sort(
				(a, b) =>
					SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] ||
					a.key.localeCompare(b.key),
			);
	};

	/** The service's own secret for `key`: a new version, or a new secret. */
	const serviceSecret = (serviceId: string, key: string, value: string) => {
		const own = rows.find(
			(r) => r.scope === "service" && r.scopeId === serviceId && r.key === key,
		);
		if (!own) return add("service", serviceId, key, [value]);
		own.external = undefined;
		if (own.versions.at(-1)?.value !== value)
			own.versions.push({
				version: (own.versions.at(-1)?.version ?? 0) + 1,
				value,
				by: "usr_simone",
				at: iso(),
			});
		return own;
	};

	const api: SecretsApi = {
		list: async (scope, scopeId) =>
			delay(
				rows
					.filter((r) => r.scope === scope && r.scopeId === scopeId)
					.sort((a, b) => a.key.localeCompare(b.key))
					.map(meta),
			),
		available: async (serviceId) => delay(available(serviceId)),
		create: async (input) => {
			if (
				rows.some(
					(r) =>
						r.scope === input.scope &&
						r.scopeId === input.scopeId &&
						r.key === input.key,
				)
			)
				throw new ApiError(
					409,
					`${input.key} already exists at this scope`,
					"conflict",
				);
			const row = add(
				input.scope,
				input.scopeId,
				input.key,
				input.reference === undefined ? [input.value ?? ""] : [],
				input.description ?? null,
			);
			if (input.reference !== undefined)
				row.external = providerByName(input.reference);
			else current(row).at = iso();
			row.createdAt = iso();
			return delay(meta(row));
		},
		update: async (id, patch) => {
			const row = find(id);
			if (patch.value !== undefined) externalOnly(row);
			if (patch.reference !== undefined && row.external)
				row.external = providerByName(patch.reference);
			if (patch.description !== undefined) row.description = patch.description;
			if (patch.value !== undefined && patch.value !== current(row).value)
				row.versions.push({
					version: current(row).version + 1,
					value: patch.value,
					by: "usr_simone",
					at: iso(),
				});
			return delay(meta(row));
		},
		reveal: async (id, version) => {
			const row = find(id);
			externalOnly(row);
			const v = row.versions.find(
				(x) => x.version === (version ?? current(row).version),
			);
			if (!v) throw new ApiError(404, "Secret version not found", "not_found");
			return delay({ version: v.version, value: v.value }, 260);
		},
		versions: async (id) => {
			const row = find(id);
			const top = current(row).version;
			return delay(
				row.versions
					.map((v) => ({
						version: v.version,
						createdBy: v.by,
						createdAt: v.at,
						current: v.version === top,
					}))
					.reverse(),
			);
		},
		rollback: async (id, version) => {
			const row = find(id);
			externalOnly(row);
			const v = row.versions.find((x) => x.version === version);
			if (!v) throw new ApiError(404, "Secret version not found", "not_found");
			if (v.version === current(row).version)
				throw new ApiError(
					400,
					"That is already the current version",
					"bad_request",
				);
			row.versions.push({
				version: current(row).version + 1,
				value: v.value,
				by: "usr_simone",
				at: iso(),
			});
			return delay(meta(row));
		},
		usages: async (id) => delay(usages(find(id).id)),
		remove: async (id) => {
			const row = find(id);
			const used = usages(row.id);
			if (used.length)
				throw new ApiError(
					409,
					`${row.key} is used by ${used.length} service variable(s); remove those references first`,
					"conflict",
					{ usages: used },
				);
			rows.splice(rows.indexOf(row), 1);
			return delay(undefined);
		},
		rotateKey: async () => {
			keyVersion += 1;
			return delay(
				{
					version: keyVersion,
					reencrypted: rows.reduce((n, r) => n + r.versions.length, 0),
				},
				900,
			);
		},
		providers: {
			list: async () =>
				delay(
					providers.map((p) => ({
						...p,
						secrets: rows.filter((r) => r.external?.providerId === p.id).length,
					})),
				),
			testConfig: async (kind, config) => {
				await delay(undefined, 700);
				if (Object.values(config).includes("wrong"))
					throw new ApiError(
						400,
						`${kind} test: HTTP 403: permission denied`,
						"bad_request",
					);
			},
			create: async (input) => {
				if (providers.some((p) => p.name === input.name))
					throw new ApiError(
						409,
						`a secret provider named "${input.name}" already exists`,
						"conflict",
					);
				const p: SecretProvider = {
					id: `ssp_${Math.random().toString(36).slice(2, 10)}`,
					kind: input.kind,
					name: input.name,
					url: String(input.config.url ?? "https://app.infisical.com"),
					secrets: 0,
					createdAt: iso(),
					updatedAt: iso(),
				};
				providers.push(p);
				return delay(p, 600);
			},
			test: async () => delay(undefined, 600),
			remove: async (id) => {
				const p = providers.find((x) => x.id === id);
				if (!p)
					throw new ApiError(404, "Secret provider not found", "not_found");
				const n = rows.filter((r) => r.external?.providerId === id).length;
				if (n)
					throw new ApiError(
						409,
						`${n} secret(s) read from ${p.name}; delete them or point them at another provider first`,
						"conflict",
					);
				providers.splice(providers.indexOf(p), 1);
				return delay(undefined);
			},
		},
	};

	return {
		api,
		available,
		serviceSecret,
		/** The value a reference resolves to, for the pending diff and seeds. */
		valueOf: (id: string) => {
			const row = rows.find((r) => r.id === id);
			return row?.versions.at(-1)?.value;
		},
		byKey: (scope: SecretScope, scopeId: string, key: string) =>
			rows.find(
				(r) => r.scope === scope && r.scopeId === scopeId && r.key === key,
			),
		setRefs: (fn: () => SecretRef[]) => {
			refs = fn;
		},
	};
}
export type SecretsStore = ReturnType<typeof secretsStore>;

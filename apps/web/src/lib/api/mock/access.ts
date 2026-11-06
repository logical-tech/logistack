import type { ResourceProfiles } from "@logistack/contracts";
import type { AccessAdapter } from "../access-adapter";
import type {
	ApiKey,
	AuditEntry,
	AuditFilters,
	Invitation,
	Member,
	OrganizationProfile,
	PermissionAction,
	Role,
	RoleGrant,
	Scope,
	ServiceAccount,
	SshKey,
	TwoFactorSetting,
} from "../access-types";
import { ApiError } from "../adapter";

const ORG = "org_logical";
const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const ahead = (days: number) => new Date(now + days * 86_400_000).toISOString();
const rid = (prefix: string) =>
	`${prefix}_${Math.random().toString(36).slice(2, 12)}`;

function delay<T>(value: T, ms = 160 + Math.random() * 260): Promise<T> {
	return new Promise((resolve) =>
		setTimeout(() => resolve(structuredClone(value)), ms),
	);
}

const ALL: PermissionAction[] = [
	"read",
	"read:secrets",
	"deploy",
	"write",
	"delete",
	"admin",
	"exec",
];

// Labels for the fixture hierarchy (see fixtures.ts).
const LABELS: Record<string, string> = {
	[ORG]: "Organization",
	fld_clients: "Clients",
	fld_acme: "Acme Retail",
	fld_nordwind: "Nordwind Travel",
	fld_internal: "Internal",
	fld_labs: "Labs",
	prj_storefront: "Storefront",
	prj_backoffice: "Back office",
	prj_booking: "Booking API",
	prj_rossi: "Studio Rossi",
	prj_website: "logical.it",
	env_storefront_production: "Storefront · Production",
	env_storefront_staging: "Storefront · Staging",
	env_booking_production: "Booking API · Production",
};
const labelOf = (s: Scope) =>
	s.kind === "organization" ? "Organization" : (LABELS[s.id] ?? s.id);

const people = [
	["usr_simone", "Simone Maddiona", "simone@logical.it", "owner", true, 400],
	["usr_giulia", "Giulia Ferri", "giulia@logical.it", "admin", true, 320],
	["usr_marco", "Marco Bassi", "marco@logical.it", "viewer", false, 120],
	["usr_ana", "Ana Kovač", "ana@nordwind.travel", "viewer", true, 60],
	["usr_tom", "Tom Lindqvist", "tom@acme-retail.com", "viewer", false, 12],
] as const;

const state = {
	members: people.map(
		([userId, name, email, role, twoFactorEnabled, days]): Member => ({
			id: `mem_${userId.slice(4)}`,
			userId,
			name,
			email,
			role,
			twoFactorEnabled,
			passkey: userId === "usr_ana",
			createdAt: ago(days * 1440),
		}),
	),
	invitations: [
		{
			id: "inv_7f3k2",
			email: "luca@logical.it",
			role: "developer",
			status: "pending",
			expiresAt: ahead(5),
			createdAt: ago(2 * 1440),
			url: "https://ls.logical.it/accept-invitation/inv_7f3k2",
		},
	] as Invitation[],
	grants: [
		["usr_marco", "developer", "folder", "fld_clients", 90],
		["usr_ana", "developer", "project", "prj_booking", 50],
		["usr_tom", "deployer", "project", "prj_storefront", 10],
		["usr_tom", "viewer", "environment", "env_storefront_production", 10],
	].map(
		([userId, role, kind, id, days]): RoleGrant => ({
			id: rid("grt"),
			userId: userId as string,
			role: role as string,
			scope: { kind: kind as Scope["kind"], id: id as string },
			scopeLabel: labelOf({ kind: kind as Scope["kind"], id: id as string }),
			createdAt: ago((days as number) * 1440),
		}),
	),
	customRoles: [
		{ name: "deployer", actions: ["read", "deploy"] as PermissionAction[] },
		{
			name: "secrets-auditor",
			actions: ["read", "read:secrets"] as PermissionAction[],
		},
	],
	serviceAccounts: [
		{
			id: "usr_sa_gha",
			name: "GitHub Actions",
			role: "viewer",
			keyCount: 1,
			createdAt: ago(30 * 1440),
		},
	] as ServiceAccount[],
	apiKeys: [] as ApiKey[],
	sshKeys: [
		{
			id: "ssh_deploy",
			name: "Git deploy key",
			publicKey:
				"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFq2b9mJ0w5k8zPp3nR0tGvXh4sYc1dE7uLwQ2aB6fKj Git-deploy-key@logistack",
			fingerprint: "SHA256:3vPq0p7wKk9hT2XQ8sYQ1mZc6rB4uN0eLd5aJfH2gWs",
			createdAt: ago(40 * 1440),
		},
		{
			id: "ssh_bootstrap",
			name: "Server bootstrap",
			publicKey:
				"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIM8xTq1Lr3vB7nKp2sW9yE4cH6dJ0aG5fU1iO8zQ3mRt Server-bootstrap@logistack",
			fingerprint: "SHA256:Yk2mJ8rL0pQ4tV6xB1nC9dF3gH5sA7wE2zU8iO0lKqM",
			createdAt: ago(12 * 1440),
		},
	] as SshKey[],
	allowPrivateHosts: false,
	twoFactor: {
		mode: "off",
		graceDays: 7,
		trustIdpMfa: false,
		enabledAt: null,
	} as TwoFactorSetting,
	resourceProfiles: {
		profiles: [
			{ name: "Nano", cpu: 0.25, memoryMb: 256 },
			{ name: "Small", cpu: 0.5, memoryMb: 512 },
			{ name: "Medium", cpu: 1, memoryMb: 1024 },
			{ name: "Large", cpu: 2, memoryMb: 4096 },
		],
		defaultProfile: "Small",
	} as ResourceProfiles,
	organization: {
		id: "org_logical",
		name: "Logical",
		slug: "logical",
		logo: null,
	} as OrganizationProfile,
	audit: [] as AuditEntry[],
};

const owner = (id: string) => {
	const m = state.members.find((x) => x.userId === id);
	if (m) return { id, name: m.name, kind: "human" as const };
	const sa = state.serviceAccounts.find((x) => x.id === id);
	return { id, name: sa?.name ?? id, kind: "machine" as const };
};

state.apiKeys = [
	{
		id: "key_ci",
		name: "storefront-ci",
		start: "lsk_Qm4",
		enabled: true,
		expiresAt: ahead(64),
		createdAt: ago(26 * 1440),
		lastUsedAt: ago(14),
		lastIp: "140.82.115.4",
		owner: owner("usr_sa_gha"),
		scopes: [
			{
				role: "developer",
				scope: { kind: "project", id: "prj_storefront" },
				scopeLabel: "Storefront",
			},
		],
	},
	{
		id: "key_claude",
		name: "claude-code",
		start: "lsk_x9T",
		enabled: true,
		expiresAt: ahead(28),
		createdAt: ago(2 * 1440),
		lastUsedAt: ago(3),
		lastIp: "93.44.120.18",
		owner: owner("usr_simone"),
		scopes: [
			{
				role: "developer",
				scope: { kind: "folder", id: "fld_clients" },
				scopeLabel: "Clients",
			},
		],
	},
	{
		id: "key_laptop",
		name: "laptop-cli",
		start: "lsk_7Hd",
		enabled: true,
		expiresAt: null,
		createdAt: ago(80 * 1440),
		lastUsedAt: ago(4 * 1440),
		lastIp: "93.44.120.18",
		owner: owner("usr_simone"),
		scopes: null,
	},
	{
		id: "key_old",
		name: "old-deploy-script",
		start: "lsk_b2K",
		enabled: false,
		expiresAt: ago(-10),
		createdAt: ago(200 * 1440),
		lastUsedAt: ago(60 * 1440),
		lastIp: "51.15.2.200",
		owner: owner("usr_simone"),
		scopes: null,
	},
];

// A plausible trail: mostly successes, a denial, an error.
const auditSeed: [
	number,
	string,
	AuditEntry["actorKind"],
	string,
	string,
	string | null,
	AuditEntry["outcome"],
	AuditEntry["diff"],
][] = [
	[
		2,
		"key_claude",
		"apikey",
		"deployment.create",
		"deployment",
		"dep_9x2",
		"success",
		{ input: null },
	],
	[
		9,
		"usr_simone",
		"user",
		"env_var.update",
		"env_var",
		"var_stripe",
		"success",
		{
			before: { key: "STRIPE_SECRET_KEY", value: "[redacted]" },
			after: { key: "STRIPE_SECRET_KEY", value: "[redacted]" },
		},
	],
	[
		24,
		"usr_tom",
		"user",
		"service.delete",
		"service",
		"svc_storefront_web",
		"denied",
		{ input: null },
	],
	[
		41,
		"usr_giulia",
		"user",
		"grant.create",
		"grant",
		"grt_a1",
		"success",
		{
			input: {
				userId: "usr_tom",
				role: "deployer",
				scope: { kind: "project", id: "prj_storefront" },
			},
		},
	],
	[
		75,
		"usr_sa_gha",
		"machine",
		"deployment.create",
		"deployment",
		"dep_9w8",
		"success",
		{ input: null },
	],
	[
		130,
		"usr_simone",
		"user",
		"service.update",
		"service",
		"svc_booking_api",
		"success",
		{
			before: { replicas: 1, image: "ghcr.io/nordwind/booking:2.3.0" },
			after: { spec: { replicas: 3, image: "ghcr.io/nordwind/booking:2.4.1" } },
		},
	],
	[
		260,
		"usr_giulia",
		"user",
		"member.update",
		"member",
		"mem_marco",
		"success",
		{ before: { role: "developer" }, after: { role: "viewer" } },
	],
	[
		400,
		"key_ci",
		"apikey",
		"domain.create",
		"domain",
		null,
		"error",
		{ input: { hostname: "shop.acme-retail.com", port: 3000 } },
	],
	[
		720,
		"usr_simone",
		"user",
		"api_key.create",
		"api_key",
		"key_claude",
		"success",
		{ input: { name: "claude-code", expiresInDays: 30 } },
	],
	[
		1500,
		"usr_simone",
		"user",
		"ssh_key.create",
		"ssh_key",
		"ssh_bootstrap",
		"success",
		{ input: { name: "Server bootstrap", imported: false } },
	],
];
const actorNames: Record<string, string> = {
	key_claude: "claude-code",
	key_ci: "storefront-ci",
	usr_sa_gha: "GitHub Actions",
	...Object.fromEntries(people.map(([id, name]) => [id, name])),
};
for (let i = 0; i < 3; i++)
	for (const [
		min,
		actorId,
		kind,
		action,
		type,
		resId,
		outcome,
		diff,
	] of auditSeed)
		state.audit.push({
			id: rid("aud"),
			organizationId: ORG,
			actorKind: kind,
			actorId,
			actorName: actorNames[actorId] ?? null,
			action,
			resourceType: type,
			resourceId: resId,
			diff,
			ip: kind === "user" ? "93.44.120.18" : "140.82.115.4",
			userAgent:
				kind === "user"
					? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/141.0"
					: "logistack-mcp (claude-code/2.1)",
			requestId: rid("req"),
			outcome,
			at: ago(min + i * 2880),
		});

const match = (e: AuditEntry, f: AuditFilters) =>
	(!f.action || e.action === f.action) &&
	(!f.actorId || e.actorId === f.actorId) &&
	(!f.resourceType || e.resourceType === f.resourceType) &&
	(!f.resourceId || e.resourceId === f.resourceId) &&
	(!f.outcome || e.outcome === f.outcome) &&
	(!f.from || e.at >= f.from) &&
	(!f.to || e.at <= f.to);

const roles = (): Role[] => {
	const usage = (name: string) =>
		state.members.filter((m) => m.role === name).length +
		state.serviceAccounts.filter((s) => s.role === name).length +
		state.grants.filter((g) => g.role === name).length;
	return [
		{ name: "owner", builtin: true, actions: ALL, usage: usage("owner") },
		{ name: "admin", builtin: true, actions: ALL, usage: usage("admin") },
		{
			name: "developer",
			builtin: true,
			actions: ["read", "deploy", "write"],
			usage: usage("developer"),
		},
		{
			name: "viewer",
			builtin: true,
			actions: ["read"],
			usage: usage("viewer"),
		},
		...state.customRoles.map((r) => ({
			...r,
			builtin: false,
			usage: usage(r.name),
		})),
	];
};

const secret = () =>
	`lsk_${Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) =>
		"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789".charAt(b % 57),
	).join("")}`;

function remove<T extends { id: string }>(list: T[], id: string) {
	const i = list.findIndex((x) => x.id === id);
	if (i < 0) throw new ApiError(404, "not found", "not_found");
	list.splice(i, 1);
}

export const mockAccess: AccessAdapter = {
	me: () =>
		delay({
			kind: "user",
			id: "usr_simone",
			userId: "usr_simone",
			organizationId: ORG,
			roles: ["owner"],
			grants: [{ role: "owner", scope: { kind: "organization", id: ORG } }],
			keyScopes: null,
			twoFactor: null,
		}),
	members: {
		list: () => delay(state.members),
		setRole: async (id, role) => {
			const m = state.members.find((x) => x.id === id);
			if (!m) throw new ApiError(404, "member not found", "not_found");
			m.role = role;
			await delay(null);
		},
		remove: async (id) => {
			const m = state.members.find((x) => x.id === id);
			remove(state.members, id);
			state.grants = state.grants.filter((g) => g.userId !== m?.userId);
			await delay(null);
		},
	},
	invitations: {
		list: () => delay(state.invitations),
		create: async ({ email, role }) => {
			if (state.members.some((m) => m.email === email))
				throw new ApiError(409, "already a member", "conflict");
			const id = rid("inv");
			const inv: Invitation = {
				id,
				email,
				role,
				status: "pending",
				expiresAt: ahead(7),
				createdAt: new Date().toISOString(),
				url: `https://ls.logical.it/accept-invitation/${id}`,
			};
			state.invitations = [
				...state.invitations.filter((i) => i.email !== email),
				inv,
			];
			return delay(inv);
		},
		cancel: async (id) => {
			remove(state.invitations, id);
			await delay(null);
		},
	},
	grants: {
		list: () => delay(state.grants),
		create: async ({ userId, role, scope }) => {
			if (role === "owner")
				throw new ApiError(
					400,
					"ownership is organization-wide",
					"bad_request",
				);
			const g: RoleGrant = {
				id: rid("grt"),
				userId,
				role,
				scope,
				scopeLabel: labelOf(scope),
				createdAt: new Date().toISOString(),
			};
			state.grants.push(g);
			return delay(g);
		},
		remove: async (id) => {
			remove(state.grants, id);
			await delay(null);
		},
	},
	roles: {
		list: () => delay(roles()),
		create: async ({ name, actions }) => {
			if (roles().some((r) => r.name === name))
				throw new ApiError(409, `role '${name}' exists`, "conflict");
			const ordered = ALL.filter((a) => actions.includes(a));
			state.customRoles.push({ name, actions: ordered });
			return delay({ name, builtin: false, actions: ordered, usage: 0 });
		},
		update: async (name, actions) => {
			const r = state.customRoles.find((x) => x.name === name);
			if (!r) throw new ApiError(404, "role not found", "not_found");
			r.actions = ALL.filter((a) => actions.includes(a));
			await delay(null);
		},
		remove: async (name) => {
			const r = roles().find((x) => x.name === name);
			if (r && r.usage > 0)
				throw new ApiError(
					409,
					`role '${name}' is held by ${r.usage} member(s) or grant(s)`,
					"conflict",
				);
			state.customRoles = state.customRoles.filter((x) => x.name !== name);
			await delay(null);
		},
	},
	apiKeys: {
		list: () => delay(state.apiKeys),
		create: async ({ name, ownerId, scopes, expiresInDays }) => {
			const key = secret();
			const row: ApiKey = {
				id: rid("key"),
				name,
				start: key.slice(0, 7),
				enabled: true,
				expiresAt: expiresInDays ? ahead(expiresInDays) : null,
				createdAt: new Date().toISOString(),
				lastUsedAt: null,
				lastIp: null,
				owner: owner(ownerId ?? "usr_simone"),
				scopes:
					scopes?.map((s) => ({ ...s, scopeLabel: labelOf(s.scope) })) ?? null,
			};
			state.apiKeys.unshift(row);
			return delay({ ...row, key }, 700);
		},
		rotate: async (id) => {
			const old = state.apiKeys.find((k) => k.id === id);
			if (!old) throw new ApiError(404, "api key not found", "not_found");
			old.enabled = false;
			const key = secret();
			const row: ApiKey = {
				...old,
				id: rid("key"),
				start: key.slice(0, 7),
				enabled: true,
				createdAt: new Date().toISOString(),
				lastUsedAt: null,
				lastIp: null,
			};
			state.apiKeys.unshift(row);
			return delay({ ...row, key }, 600);
		},
		revoke: async (id) => {
			const k = state.apiKeys.find((x) => x.id === id);
			if (k) k.enabled = false;
			await delay(null);
		},
	},
	serviceAccounts: {
		list: () => delay(state.serviceAccounts),
		create: async ({ name, role }) => {
			const sa: ServiceAccount = {
				id: rid("usr"),
				name,
				role: role ?? "viewer",
				keyCount: 0,
				createdAt: new Date().toISOString(),
			};
			state.serviceAccounts.push(sa);
			return delay(sa);
		},
		remove: async (id) => {
			remove(state.serviceAccounts, id);
			state.apiKeys = state.apiKeys.filter((k) => k.owner.id !== id);
			await delay(null);
		},
	},
	sshKeys: {
		list: () => delay(state.sshKeys),
		create: async ({ name, privateKey }) => {
			if (
				privateKey !== undefined &&
				!privateKey.includes("OPENSSH PRIVATE KEY")
			)
				throw new ApiError(
					400,
					"Paste an OpenSSH private key, the block that starts with BEGIN OPENSSH PRIVATE KEY",
					"bad_request",
				);
			const body = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
				b.toString(16).padStart(2, "0"),
			).join("");
			const k: SshKey = {
				id: rid("ssh"),
				name,
				publicKey: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${btoa(body).slice(0, 43)} ${name.replace(/\s+/g, "-")}@logistack`,
				fingerprint: `SHA256:${btoa(body).slice(0, 43)}`,
				createdAt: new Date().toISOString(),
			};
			state.sshKeys.push(k);
			return delay(k, 500);
		},
		remove: async (id) => {
			remove(state.sshKeys, id);
			await delay(null);
		},
	},
	twoFactor: {
		get: () => delay({ ...state.twoFactor }),
		set: async (policy) => {
			state.twoFactor = {
				...policy,
				enabledAt:
					policy.mode === "off"
						? null
						: (state.twoFactor.enabledAt ?? new Date().toISOString()),
			};
			return mockAccess.twoFactor.get();
		},
	},
	resourceProfiles: {
		get: () => delay(structuredClone(state.resourceProfiles)),
		set: async (next) => {
			state.resourceProfiles = structuredClone(next);
			return mockAccess.resourceProfiles.get();
		},
	},
	organization: {
		get: () => delay({ ...state.organization }),
		update: async (patch) => {
			state.organization = { ...state.organization, ...patch };
			return mockAccess.organization.get();
		},
	},
	instance: {
		get: () =>
			delay({
				organizationName: state.organization.name,
				publicUrl: "https://ls.logical.it",
				letsencryptEmail: "ops@logical.it",
				generatedDomainBase: "sslip",
				localRegistryEnabled: true,
				allowPrivateHosts: state.allowPrivateHosts,
			}),
		setAllowPrivateHosts: async (allow) => {
			state.allowPrivateHosts = allow;
			return mockAccess.instance.get();
		},
	},
	audit: {
		page: (filters, cursor, limit = 50) => {
			const rows = state.audit
				.filter((e) => match(e, filters))
				.sort((a, b) => b.at.localeCompare(a.at));
			const start = cursor ? Number(cursor) : 0;
			const items = rows.slice(start, start + limit);
			return delay({
				items,
				nextCursor: start + limit < rows.length ? String(start + limit) : null,
			});
		},
		facets: () =>
			delay({
				actions: [...new Set(state.audit.map((e) => e.action))].sort(),
				resourceTypes: [
					...new Set(state.audit.map((e) => e.resourceType)),
				].sort(),
				actors: [
					...new Map(
						state.audit.map((e) => [
							e.actorId,
							{ id: e.actorId, kind: e.actorKind, name: e.actorName },
						]),
					).values(),
				],
			}),
		exportUrl: async (filters, format) => {
			const rows = state.audit.filter((e) => match(e, filters));
			const body =
				format === "json"
					? JSON.stringify(rows, null, 2)
					: [
							"at,actorKind,actorId,actorName,action,resourceType,resourceId,outcome",
							...rows.map((r) =>
								[
									r.at,
									r.actorKind,
									r.actorId,
									r.actorName,
									r.action,
									r.resourceType,
									r.resourceId,
									r.outcome,
								]
									.map((v) => `"${String(v ?? "").replaceAll('"', '""')}"`)
									.join(","),
							),
						].join("\r\n");
			return URL.createObjectURL(
				new Blob([body], {
					type: format === "json" ? "application/json" : "text/csv",
				}),
			);
		},
	},
};

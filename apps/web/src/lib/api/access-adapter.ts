import type { ClientResponse } from "hono/client";
import type {
	ApiKey,
	AuditFacets,
	AuditFilters,
	AuditPage,
	CreateApiKeyInput,
	CreatedApiKey,
	CreateRoleInput,
	CreateServiceAccountInput,
	CreateSshKeyInput,
	GrantInput,
	InstanceSettings,
	Invitation,
	InviteInput,
	Me,
	Member,
	OrganizationProfile,
	OrganizationUpdateInput,
	PermissionAction,
	Role,
	RoleGrant,
	ServiceAccount,
	SshKey,
	TwoFactorPolicyInput,
	TwoFactorSetting,
} from "./access-types";
import { ApiError } from "./adapter";
import { client } from "./client";

/** Members, roles, grants, keys, SSH keys, instance settings and the audit log. */
export type AccessAdapter = {
	me(): Promise<Me>;
	members: {
		list(): Promise<Member[]>;
		setRole(id: string, role: string): Promise<void>;
		remove(id: string): Promise<void>;
	};
	invitations: {
		list(): Promise<Invitation[]>;
		create(input: InviteInput): Promise<Invitation>;
		cancel(id: string): Promise<void>;
	};
	grants: {
		list(): Promise<RoleGrant[]>;
		create(input: GrantInput): Promise<RoleGrant>;
		remove(id: string): Promise<void>;
	};
	roles: {
		list(): Promise<Role[]>;
		create(input: CreateRoleInput): Promise<Role>;
		update(name: string, actions: PermissionAction[]): Promise<void>;
		remove(name: string): Promise<void>;
	};
	apiKeys: {
		list(): Promise<ApiKey[]>;
		create(input: CreateApiKeyInput): Promise<CreatedApiKey>;
		rotate(id: string): Promise<CreatedApiKey>;
		revoke(id: string): Promise<void>;
	};
	serviceAccounts: {
		list(): Promise<ServiceAccount[]>;
		create(input: CreateServiceAccountInput): Promise<ServiceAccount>;
		remove(id: string): Promise<void>;
	};
	sshKeys: {
		list(): Promise<SshKey[]>;
		create(input: CreateSshKeyInput): Promise<SshKey>;
		remove(id: string): Promise<void>;
	};
	organization: {
		get(): Promise<OrganizationProfile>;
		update(input: OrganizationUpdateInput): Promise<OrganizationProfile>;
	};
	twoFactor: {
		get(): Promise<TwoFactorSetting>;
		set(policy: TwoFactorPolicyInput): Promise<TwoFactorSetting>;
	};
	instance: {
		get(): Promise<InstanceSettings>;
		setAllowPrivateHosts(allow: boolean): Promise<InstanceSettings>;
	};
	audit: {
		page(
			filters: AuditFilters,
			cursor?: string,
			limit?: number,
		): Promise<AuditPage>;
		facets(): Promise<AuditFacets>;
		/** A URL that downloads the filtered log; the mock builds a blob. */
		exportUrl(filters: AuditFilters, format: "csv" | "json"): Promise<string>;
	};
};

const api = client.api;

async function ok<T>(
	pending: Promise<ClientResponse<T, number, string>>,
): Promise<T> {
	const res = await pending;
	if (res.ok)
		return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
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

// The typed client narrows each response by status; these calls only read the success body.
// biome-ignore lint/suspicious/noExplicitAny: see above
const call = <T>(p: Promise<any>) => ok<T>(p);

const query = (f: AuditFilters) =>
	Object.fromEntries(
		Object.entries(f).filter(([, v]) => v !== undefined && v !== ""),
	) as Record<string, string>;

export const httpAccess: AccessAdapter = {
	me: () => call(api.me.$get()),
	members: {
		list: () => call(api.members.$get()),
		setRole: (id, role) =>
			call(api.members[":id"].$patch({ param: { id }, json: { role } })),
		remove: (id) => call(api.members[":id"].$delete({ param: { id } })),
	},
	organization: {
		get: () => call(api.organization.$get()),
		update: (json) => call(api.organization.$patch({ json })),
	},
	twoFactor: {
		get: () => call(api.organization["two-factor"].$get()),
		set: (json) => call(api.organization["two-factor"].$put({ json })),
	},
	invitations: {
		list: () => call(api.invitations.$get()),
		create: (json) => call(api.invitations.$post({ json })),
		cancel: (id) => call(api.invitations[":id"].$delete({ param: { id } })),
	},
	grants: {
		list: () => call(api.grants.$get({ query: {} })),
		create: (json) => call(api.grants.$post({ json })),
		remove: (id) => call(api.grants[":id"].$delete({ param: { id } })),
	},
	roles: {
		list: () => call(api.roles.$get()),
		create: (json) => call(api.roles.$post({ json })),
		update: (name, actions) =>
			call(api.roles[":name"].$patch({ param: { name }, json: { actions } })),
		remove: (name) => call(api.roles[":name"].$delete({ param: { name } })),
	},
	apiKeys: {
		list: () => call(api["api-keys"].$get()),
		create: (json) => call(api["api-keys"].$post({ json })),
		rotate: (id) =>
			call(api["api-keys"][":id"].rotate.$post({ param: { id } })),
		revoke: (id) => call(api["api-keys"][":id"].$delete({ param: { id } })),
	},
	serviceAccounts: {
		list: () => call(api["service-accounts"].$get()),
		create: (json) => call(api["service-accounts"].$post({ json })),
		remove: (id) =>
			call(api["service-accounts"][":id"].$delete({ param: { id } })),
	},
	sshKeys: {
		list: () => call(api["ssh-keys"].$get()),
		create: (json) => call(api["ssh-keys"].$post({ json })),
		remove: (id) => call(api["ssh-keys"][":id"].$delete({ param: { id } })),
	},
	instance: {
		get: () => call(api.instance.settings.$get()),
		setAllowPrivateHosts: (allowPrivateHosts) =>
			call(api.instance.settings.$patch({ json: { allowPrivateHosts } })),
	},
	audit: {
		page: (filters, cursor, limit = 50) =>
			call(
				api["audit-log"].$get({
					query: {
						...query(filters),
						...(cursor && { cursor }),
						limit: String(limit),
					} as never,
				}),
			),
		facets: () => call(api["audit-log"].facets.$get()),
		exportUrl: async (filters, format) =>
			`/api/audit-log/export?${new URLSearchParams({ ...query(filters), format })}`,
	},
};

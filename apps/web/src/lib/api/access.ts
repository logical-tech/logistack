import {
	queryOptions,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { api } from ".";
import type { AuditFilters, PermissionAction } from "./access-types";

const a = api.access;

export const meQuery = queryOptions({
	queryKey: ["me"],
	queryFn: () => a.me(),
	staleTime: 30_000,
});
export const membersQuery = queryOptions({
	queryKey: ["access", "members"],
	queryFn: () => a.members.list(),
});
export const invitationsQuery = queryOptions({
	queryKey: ["access", "invitations"],
	queryFn: () => a.invitations.list(),
});
export const grantsQuery = queryOptions({
	queryKey: ["access", "grants"],
	queryFn: () => a.grants.list(),
});
export const rolesQuery = queryOptions({
	queryKey: ["access", "roles"],
	queryFn: () => a.roles.list(),
});
export const apiKeysQuery = queryOptions({
	queryKey: ["access", "api-keys"],
	queryFn: () => a.apiKeys.list(),
});
export const serviceAccountsQuery = queryOptions({
	queryKey: ["access", "service-accounts"],
	queryFn: () => a.serviceAccounts.list(),
});
export const sshKeysQuery = queryOptions({
	queryKey: ["access", "ssh-keys"],
	queryFn: () => a.sshKeys.list(),
});
export const organizationQuery = queryOptions({
	queryKey: ["access", "organization"],
	queryFn: () => a.organization.get(),
});
export const resourceProfilesQuery = queryOptions({
	queryKey: ["access", "resource-profiles"],
	queryFn: () => a.resourceProfiles.get(),
});
export const twoFactorSettingQuery = queryOptions({
	queryKey: ["access", "two-factor"],
	queryFn: () => a.twoFactor.get(),
});
export const instanceSettingsQuery = queryOptions({
	queryKey: ["access", "instance"],
	queryFn: () => a.instance.get(),
});
export const auditFacetsQuery = queryOptions({
	queryKey: ["audit", "facets"],
	queryFn: () => a.audit.facets(),
	staleTime: 60_000,
});

export const useMe = () => useQuery(meQuery);
export const useMembers = () => useQuery(membersQuery);
export const useInvitations = () => useQuery(invitationsQuery);
export const useGrants = () => useQuery(grantsQuery);
export const useRoles = () => useQuery(rolesQuery);
export const useApiKeys = () => useQuery(apiKeysQuery);
export const useServiceAccounts = () => useQuery(serviceAccountsQuery);
export const useSshKeys = () => useQuery(sshKeysQuery);
export const useInstanceSettings = () => useQuery(instanceSettingsQuery);
export const useOrganization = () => useQuery(organizationQuery);
export const useTwoFactorSetting = () => useQuery(twoFactorSettingQuery);
export const useResourceProfiles = () => useQuery(resourceProfilesQuery);

/** A mutation that refreshes every access view (members, roles, grants, keys) on success. */
function useAccessMutation<I, O>(fn: (input: I) => Promise<O>) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: fn,
		onSuccess: () =>
			Promise.all([
				qc.invalidateQueries({ queryKey: ["access"] }),
				qc.invalidateQueries({ queryKey: ["audit"] }),
			]),
	});
}

export const useSetMemberRole = () =>
	useAccessMutation((v: { id: string; role: string }) =>
		a.members.setRole(v.id, v.role),
	);
export const useRemoveMember = () => useAccessMutation(a.members.remove);
export const useInvite = () => useAccessMutation(a.invitations.create);
export const useCancelInvitation = () =>
	useAccessMutation(a.invitations.cancel);
export const useCreateGrant = () => useAccessMutation(a.grants.create);
export const useRemoveGrant = () => useAccessMutation(a.grants.remove);
export const useCreateRole = () => useAccessMutation(a.roles.create);
export const useUpdateRole = () =>
	useAccessMutation((v: { name: string; actions: PermissionAction[] }) =>
		a.roles.update(v.name, v.actions),
	);
export const useRemoveRole = () => useAccessMutation(a.roles.remove);
export const useCreateApiKey = () => useAccessMutation(a.apiKeys.create);
export const useRotateApiKey = () => useAccessMutation(a.apiKeys.rotate);
export const useRevokeApiKey = () => useAccessMutation(a.apiKeys.revoke);
export const useCreateServiceAccount = () =>
	useAccessMutation(a.serviceAccounts.create);
export const useRemoveServiceAccount = () =>
	useAccessMutation(a.serviceAccounts.remove);
export const useCreateSshKey = () => useAccessMutation(a.sshKeys.create);
export const useRemoveSshKey = () => useAccessMutation(a.sshKeys.remove);
/** Saving the requirement also changes what `/me` reports about the signed-in person. */
export function useSetTwoFactorPolicy() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: a.twoFactor.set,
		onSuccess: () =>
			Promise.all([
				qc.invalidateQueries({ queryKey: ["access"] }),
				qc.invalidateQueries({ queryKey: ["audit"] }),
				qc.invalidateQueries({ queryKey: meQuery.queryKey }),
			]),
	});
}

/** The org switcher lists organizations through better-auth, so its list refreshes too. */
export function useUpdateOrganization() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: a.organization.update,
		onSuccess: () =>
			Promise.all([
				qc.invalidateQueries({ queryKey: ["access"] }),
				qc.invalidateQueries({ queryKey: ["audit"] }),
				qc.invalidateQueries({ queryKey: ["organizations"] }),
			]),
	});
}

export const useSetResourceProfiles = () =>
	useAccessMutation(a.resourceProfiles.set);

export const useSetAllowPrivateHosts = () =>
	useAccessMutation(a.instance.setAllowPrivateHosts);

export const auditPage = (
	filters: AuditFilters,
	cursor?: string,
	limit?: number,
) => a.audit.page(filters, cursor, limit);
export const auditExportUrl = a.audit.exportUrl;

/** What each action lets a role do, in the UI's words. */
export const ACTION_LABELS: Record<
	PermissionAction,
	{ label: string; description: string }
> = {
	read: {
		label: "Read",
		description: "See projects, services, deployments, logs and settings.",
	},
	"read:secrets": {
		label: "Read secrets",
		description: "Reveal secret environment variables and credentials.",
	},
	deploy: {
		label: "Deploy",
		description: "Start deployments, restart and roll back services.",
	},
	write: {
		label: "Write",
		description: "Create and change projects, services, domains and variables.",
	},
	delete: {
		label: "Delete",
		description: "Remove projects, environments, services and domains.",
	},
	admin: {
		label: "Administer",
		description: "Manage members, roles, keys and integrations on the scope.",
	},
	exec: {
		label: "Terminal",
		description:
			"Open a shell inside running containers. Every session is audited.",
	},
	ai: {
		label: "AI",
		description:
			"Call models through the AI gateway, within the budget an admin assigns.",
	},
	plugins: {
		label: "Plugins",
		description:
			"Install, configure and remove plugins, within the instance policy.",
	},
};

export const PERMISSION_ACTIONS = Object.keys(
	ACTION_LABELS,
) as PermissionAction[];

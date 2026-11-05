/*
 * Wire shapes for members, roles, grants, API keys, service accounts, SSH keys,
 * instance settings and the audit log, inferred from the server's routes.
 */
import type { InferRequestType, InferResponseType } from "hono/client";
import type { client } from "./client";

type Api = typeof client.api;
type Ok<F> = InferResponseType<F, 200>;
type Created<F> = InferResponseType<F, 201>;
type Body<F> = InferRequestType<F> extends { json: infer J } ? J : never;

export type Me = Ok<Api["me"]["$get"]>;
export type Member = Ok<Api["members"]["$get"]>[number];
export type Invitation = Ok<Api["invitations"]["$get"]>[number];
export type RoleGrant = Ok<Api["grants"]["$get"]>[number];
export type Role = Ok<Api["roles"]["$get"]>[number];
export type ApiKey = Ok<Api["api-keys"]["$get"]>[number];
export type CreatedApiKey = Created<Api["api-keys"]["$post"]>;
export type ServiceAccount = Ok<Api["service-accounts"]["$get"]>[number];
export type SshKey = Ok<Api["ssh-keys"]["$get"]>[number];
export type InstanceSettings = Ok<Api["instance"]["settings"]["$get"]>;
export type OrganizationProfile = Ok<Api["organization"]["$get"]>;
export type OrganizationUpdateInput = Body<Api["organization"]["$patch"]>;
export type TwoFactorSetting = Ok<Api["organization"]["two-factor"]["$get"]>;
export type TwoFactorPolicyInput = Body<
	Api["organization"]["two-factor"]["$put"]
>;
export type AuditPage = Ok<Api["audit-log"]["$get"]>;
export type AuditEntry = AuditPage["items"][number];
export type AuditFacets = Ok<Api["audit-log"]["facets"]["$get"]>;

export type InviteInput = Body<Api["invitations"]["$post"]>;
export type GrantInput = Body<Api["grants"]["$post"]>;
export type CreateRoleInput = Body<Api["roles"]["$post"]>;
export type CreateApiKeyInput = Body<Api["api-keys"]["$post"]>;
export type CreateServiceAccountInput = Body<Api["service-accounts"]["$post"]>;
export type CreateSshKeyInput = Body<Api["ssh-keys"]["$post"]>;

export type ScopeKind = GrantInput["scope"]["kind"];
export type Scope = GrantInput["scope"];
export type KeyScope = { role: string; scope: Scope };
export type PermissionAction = CreateRoleInput["actions"][number];

export type AuditFilters = {
	action?: string;
	actorId?: string;
	resourceType?: string;
	resourceId?: string;
	outcome?: AuditEntry["outcome"];
	from?: string;
	to?: string;
};

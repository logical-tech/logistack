import {
	auditActorKinds,
	auditOutcomes,
	backupRunKinds,
	backupTargets,
	certModes,
	deploymentStatuses,
	deploymentTriggers,
	desiredStates,
	dnsProviderKinds,
	domainStatuses,
	environmentKinds,
	envVarScopes,
	generatedDomainBases,
	gitProviderKinds,
	mountKinds,
	nodeRoles,
	nodeStatuses,
	notificationChannelKinds,
	observedStates,
	registryKinds,
	runStatuses,
	scheduleConcurrencies,
	serviceKinds,
	stackSources,
	storageKeyAccess,
} from "@logistack/contracts";
import { pgEnum } from "drizzle-orm/pg-core";

export const environmentKind = pgEnum("environment_kind", environmentKinds);
export const serviceKind = pgEnum("service_kind", serviceKinds);
export const stackSource = pgEnum("stack_source", stackSources);
export const desiredState = pgEnum("desired_state", desiredStates);
export const observedState = pgEnum("observed_state", observedStates);
export const nodeRole = pgEnum("node_role", nodeRoles);
export const nodeStatus = pgEnum("node_status", nodeStatuses);
export const deploymentStatus = pgEnum("deployment_status", deploymentStatuses);
export const deploymentTrigger = pgEnum(
	"deployment_trigger",
	deploymentTriggers,
);
export const envVarScope = pgEnum("env_var_scope", envVarScopes);
export const mountKind = pgEnum("mount_kind", mountKinds);
export const certMode = pgEnum("cert_mode", certModes);
export const domainStatus = pgEnum("domain_status", domainStatuses);
export const dnsProviderKind = pgEnum("dns_provider_kind", dnsProviderKinds);
export const gitProviderKind = pgEnum("git_provider_kind", gitProviderKinds);
export const registryKind = pgEnum("registry_kind", registryKinds);
export const backupTarget = pgEnum("backup_target", backupTargets);
export const runStatus = pgEnum("run_status", runStatuses);
export const backupRunKind = pgEnum("backup_run_kind", backupRunKinds);
export const scheduleConcurrency = pgEnum(
	"schedule_concurrency",
	scheduleConcurrencies,
);
export const notificationChannelKind = pgEnum(
	"notification_channel_kind",
	notificationChannelKinds,
);
export const auditActorKind = pgEnum("audit_actor_kind", auditActorKinds);
export const auditOutcome = pgEnum("audit_outcome", auditOutcomes);
export const generatedDomainBase = pgEnum(
	"generated_domain_base",
	generatedDomainBases,
);

export const storageKeyAccessEnum = pgEnum(
	"storage_key_access",
	storageKeyAccess,
);

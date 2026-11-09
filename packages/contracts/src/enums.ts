import { z } from "zod";

// Each tuple is the single source for both the zod enum and the Postgres enum in packages/db.

export const environmentKinds = [
	"production",
	"staging",
	"preview",
	"custom",
] as const;
export const EnvironmentKind = z.enum(environmentKinds);
export type EnvironmentKind = z.infer<typeof EnvironmentKind>;

/** A fixed palette so every color reads in both themes; null on a row falls back to the kind's. */
export const environmentColors = [
	"gray",
	"blue",
	"green",
	"amber",
	"red",
	"violet",
] as const;
export const EnvironmentColor = z.enum(environmentColors);
export type EnvironmentColor = z.infer<typeof EnvironmentColor>;

export const serviceKinds = [
	"application",
	"database",
	"compose",
	"storage",
	"game",
] as const;
export const ServiceKind = z.enum(serviceKinds);
/** Where a stack's services came from: a catalog template, a pasted compose file, or a compose file in git. */
export const stackSources = ["template", "compose", "git"] as const;
export const StackSource = z.enum(stackSources);
export type StackSource = z.infer<typeof StackSource>;
export type ServiceKind = z.infer<typeof ServiceKind>;

export const desiredStates = ["running", "stopped"] as const;
export const DesiredState = z.enum(desiredStates);
export type DesiredState = z.infer<typeof DesiredState>;

export const observedStates = [
	"running",
	"starting",
	"unhealthy",
	"stopped",
	"failed",
	"unknown",
] as const;
export const ObservedState = z.enum(observedStates);
export type ObservedState = z.infer<typeof ObservedState>;

export const nodeRoles = ["manager", "worker"] as const;
export const NodeRole = z.enum(nodeRoles);
export type NodeRole = z.infer<typeof NodeRole>;

export const nodeStatuses = ["pending", "ready", "down", "draining"] as const;
export const NodeStatus = z.enum(nodeStatuses);
export type NodeStatus = z.infer<typeof NodeStatus>;

export const deploymentStatuses = [
	"awaiting_checks",
	"queued",
	"cloning",
	"building",
	"pushing",
	"releasing",
	"deploying",
	"healthy",
	"failed",
	"cancelled",
	"superseded",
	"skipped",
] as const;
export const DeploymentStatus = z.enum(deploymentStatuses);
export type DeploymentStatus = z.infer<typeof DeploymentStatus>;

export const deploymentTriggers = [
	"manual",
	"git_push",
	"webhook",
	"rollback",
	"schedule",
	"api",
] as const;
export const DeploymentTrigger = z.enum(deploymentTriggers);
export type DeploymentTrigger = z.infer<typeof DeploymentTrigger>;

/** Ordered from least to most specific: later scopes override earlier ones. */
export const envVarScopes = [
	"organization",
	"project",
	"environment",
	"service",
] as const;
export const EnvVarScope = z.enum(envVarScopes);

/** Where a managed secret is defined, least specific first. Services below a scope may reference it. */
export const secretScopes = [
	"organization",
	"folder",
	"project",
	"environment",
	"service",
] as const;
export const SecretScope = z.enum(secretScopes);

/** Where an external secret lives: HashiCorp Vault (KV v2), Infisical, 1Password Connect. */
export const secretProviderKinds = [
	"vault",
	"infisical",
	"onepassword",
	/** Contributed by a plugin install (`plugin_install_id`, `plugin_provider`). */
	"plugin",
] as const;
export const SecretProviderKind = z.enum(secretProviderKinds);
export type SecretProviderKind = z.infer<typeof SecretProviderKind>;
export type SecretScope = z.infer<typeof SecretScope>;
export type EnvVarScope = z.infer<typeof EnvVarScope>;

export const mountKinds = ["volume", "config", "secret"] as const;
export const MountKind = z.enum(mountKinds);
export type MountKind = z.infer<typeof MountKind>;

export const certModes = ["auto", "custom", "none"] as const;
export const CertMode = z.enum(certModes);
export type CertMode = z.infer<typeof CertMode>;

export const domainStatuses = ["pending", "active", "error"] as const;
export const DomainStatus = z.enum(domainStatuses);
export type DomainStatus = z.infer<typeof DomainStatus>;

export const dnsProviderKinds = [
	"cloudflare",
	"route53",
	"hetzner",
	"digitalocean",
	"ovh",
	"porkbun",
	/** Contributed by a plugin install (`plugin_install_id`, `plugin_provider`). */
	"plugin",
] as const;
export const DnsProviderKind = z.enum(dnsProviderKinds);
export type DnsProviderKind = z.infer<typeof DnsProviderKind>;

export const gitProviderKinds = [
	"github",
	"gitlab",
	"gitea",
	"bitbucket",
	"generic",
] as const;
export const GitProviderKind = z.enum(gitProviderKinds);
export type GitProviderKind = z.infer<typeof GitProviderKind>;

export const registryKinds = [
	"local",
	"ghcr",
	"dockerhub",
	"gitlab",
	"generic",
] as const;
export const RegistryKind = z.enum(registryKinds);
export type RegistryKind = z.infer<typeof RegistryKind>;

export const databaseEngines = [
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
	"libsql",
] as const;
export const DatabaseEngine = z.enum(databaseEngines);
export type DatabaseEngine = z.infer<typeof DatabaseEngine>;
/** Engines whose dumps the API cannot restore or verify; their volume backups restore instead. */
export const dumpOnlyEngines: readonly DatabaseEngine[] = ["redis", "libsql"];

export const backupTargets = ["database", "volume"] as const;
export const BackupTarget = z.enum(backupTargets);
export type BackupTarget = z.infer<typeof BackupTarget>;

export const runStatuses = [
	"running",
	"succeeded",
	"failed",
	/** A `forbid` schedule ticked while its previous run was still going. */
	"skipped",
	/** Superseded by a `replace` schedule's next run. */
	"cancelled",
] as const;
export const RunStatus = z.enum(runStatuses);
export type RunStatus = z.infer<typeof RunStatus>;

export const backupRunKinds = ["backup", "verify", "restore"] as const;
export const BackupRunKind = z.enum(backupRunKinds);
export type BackupRunKind = z.infer<typeof BackupRunKind>;

export const scheduleConcurrencies = ["forbid", "allow", "replace"] as const;
export const ScheduleConcurrency = z.enum(scheduleConcurrencies);
export type ScheduleConcurrency = z.infer<typeof ScheduleConcurrency>;

export const notificationChannelKinds = [
	"email",
	"slack",
	"discord",
	"telegram",
	"teams",
	"mattermost",
	"ntfy",
	"gotify",
	"pushover",
	"webhook",
	/** Contributed by a plugin install (`plugin_install_id`, `plugin_provider`). */
	"plugin",
] as const;
export const NotificationChannelKind = z.enum(notificationChannelKinds);
export type NotificationChannelKind = z.infer<typeof NotificationChannelKind>;

export const auditActorKinds = ["user", "apikey", "machine", "system"] as const;
export const AuditActorKind = z.enum(auditActorKinds);
export type AuditActorKind = z.infer<typeof AuditActorKind>;

export const auditOutcomes = ["success", "denied", "error"] as const;
export const AuditOutcome = z.enum(auditOutcomes);
export type AuditOutcome = z.infer<typeof AuditOutcome>;

export const generatedDomainBases = ["sslip", "nip", "custom"] as const;
export const GeneratedDomainBase = z.enum(generatedDomainBases);
export type GeneratedDomainBase = z.infer<typeof GeneratedDomainBase>;

export const userKinds = ["human", "machine"] as const;
export const UserKind = z.enum(userKinds);
export type UserKind = z.infer<typeof UserKind>;

export const permissionActions = [
	"read",
	"read:secrets",
	"deploy",
	"write",
	"delete",
	"admin",
	/** Open a shell in a running container. Not in `developer`: grant it explicitly. */
	"exec",
	/** Use the AI gateway within the budget an admin assigned. Not in `developer`: grant it explicitly. */
	"ai",
	/** Install, configure, disable and uninstall plugins, within the instance policy. Not in `developer`. */
	"plugins",
	/** Work: see lists, tasks, comments, attachments and the project's simplified health. */
	"read:work",
	/** Work: comment, react, tick checklist items assigned to you. Implies `read:work`. */
	"comment:work",
	/** Work: create, edit, move and assign tasks. Implies `comment:work`. */
	"work",
	/** Work: lists, statuses, fields, tags, shared views, templates, project Work settings, imports. */
	"work:admin",
] as const;
export const PermissionAction = z.enum(permissionActions);
export type PermissionAction = z.infer<typeof PermissionAction>;

export const migrationSources = ["dokploy", "coolify"] as const;
export const MigrationSource = z.enum(migrationSources);
export type MigrationSource = z.infer<typeof MigrationSource>;

export const migrationStatuses = [
	"planned",
	"importing",
	"imported",
	/** Dokploy archived and removed (MIG-7). */
	"decommissioned",
] as const;
export const MigrationStatus = z.enum(migrationStatuses);
export type MigrationStatus = z.infer<typeof MigrationStatus>;

export const migrationItemStatuses = [
	"planned",
	"imported",
	"cut_over",
	"failed",
	"rolled_back",
	"skipped",
] as const;
export const MigrationItemStatus = z.enum(migrationItemStatuses);
export type MigrationItemStatus = z.infer<typeof MigrationItemStatus>;

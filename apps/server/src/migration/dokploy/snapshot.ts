/**
 * The part of a Dokploy database the migration reads, parsed at the boundary. Column names are
 * Dokploy's own (camelCase, quoted in SQL). Tested against Dokploy v0.30.
 */
import { z } from "zod";

const text = z.string().nullable();
const int = z.number().int().nullable();
const bool = z.boolean().nullable();
/** Swarm JSON columns (`placementSwarm`, `healthCheckSwarm`...): kept loose, read field by field. */
const json = z.unknown();

export const DokployProject = z.object({
	projectId: z.string(),
	name: z.string(),
	env: text,
});

export const DokployEnvironment = z.object({
	environmentId: z.string(),
	projectId: z.string(),
	name: z.string(),
	env: text,
});

const swarm = {
	healthCheckSwarm: json,
	placementSwarm: json,
	modeSwarm: json,
	labelsSwarm: json,
	networkSwarm: json,
	updateConfigSwarm: json,
	restartPolicySwarm: json,
};

const runtime = {
	name: z.string(),
	appName: z.string(),
	environmentId: z.string(),
	serverId: text,
	env: text,
	command: text,
	memoryLimit: text,
	cpuLimit: text,
	replicas: int,
	applicationStatus: text,
	...swarm,
};

export const DokployApplication = z.object({
	applicationId: z.string(),
	...runtime,
	sourceType: z.string(),
	buildType: z.string(),
	dockerImage: text,
	username: text,
	registryUrl: text,
	registryId: text,
	repository: text,
	owner: text,
	branch: text,
	buildPath: text,
	githubId: text,
	gitlabPathNamespace: text,
	gitlabBranch: text,
	gitlabBuildPath: text,
	gitlabId: text,
	giteaOwner: text,
	giteaRepository: text,
	giteaBranch: text,
	giteaBuildPath: text,
	giteaId: text,
	bitbucketOwner: text,
	bitbucketRepository: text,
	bitbucketBranch: text,
	bitbucketBuildPath: text,
	bitbucketId: text,
	customGitUrl: text,
	customGitBranch: text,
	customGitBuildPath: text,
	customGitSSHKeyId: text,
	dockerfile: text,
	dockerContextPath: text,
	dockerBuildStage: text,
	buildArgs: text,
	publishDirectory: text,
	isPreviewDeploymentsActive: bool,
	autoDeploy: bool,
});
export type DokployApplication = z.infer<typeof DokployApplication>;

export const databaseEngines = [
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
] as const;
export type DokployEngine = (typeof databaseEngines)[number];

export const DokployDatabase = z.object({
	engine: z.enum(databaseEngines),
	/** `postgresId`, `mysqlId`... under one name. */
	id: z.string(),
	...runtime,
	dockerImage: z.string(),
	databaseName: text,
	databaseUser: text,
	databasePassword: text,
	rootPassword: text,
	externalPort: int,
});
export type DokployDatabase = z.infer<typeof DokployDatabase>;

export const DokployCompose = z.object({
	composeId: z.string(),
	name: z.string(),
	appName: z.string(),
	environmentId: z.string(),
	serverId: text,
	sourceType: z.string(),
	composeType: z.string(),
	composeFile: text,
	composePath: text,
	env: text,
	composeStatus: text,
});
export type DokployCompose = z.infer<typeof DokployCompose>;

export const DokployDomain = z.object({
	domainId: z.string(),
	host: z.string(),
	https: z.boolean(),
	port: int,
	path: text,
	internalPath: text,
	stripPath: bool,
	serviceName: text,
	domainType: text,
	certificateType: z.string(),
	applicationId: text,
	composeId: text,
});
export type DokployDomain = z.infer<typeof DokployDomain>;

export const DokployMount = z.object({
	mountId: z.string(),
	type: z.enum(["bind", "volume", "file"]),
	hostPath: text,
	volumeName: text,
	filePath: text,
	content: text,
	mountPath: z.string(),
	/** The owning row: `applicationId`, `postgresId`... whichever is set. */
	ownerId: z.string(),
});
export type DokployMount = z.infer<typeof DokployMount>;

export const DokployPort = z.object({
	applicationId: z.string(),
	publishedPort: z.number().int(),
	targetPort: z.number().int(),
	protocol: z.string(),
	publishMode: z.string(),
});

export const DokployRedirect = z.object({
	applicationId: z.string(),
	regex: z.string(),
	replacement: z.string(),
	permanent: z.boolean(),
});

export const DokploySecurity = z.object({
	applicationId: z.string(),
	username: z.string(),
	password: z.string(),
});

export const DokployRegistry = z.object({
	registryId: z.string(),
	registryName: z.string(),
	imagePrefix: text,
	username: z.string(),
	password: z.string(),
	registryUrl: z.string(),
});
export type DokployRegistry = z.infer<typeof DokployRegistry>;

export const DokployDestination = z.object({
	destinationId: z.string(),
	name: z.string(),
	provider: text,
	accessKey: z.string(),
	secretAccessKey: z.string(),
	bucket: z.string(),
	region: z.string(),
	endpoint: z.string(),
	additionalFlags: z.array(z.string()).nullable(),
});
export type DokployDestination = z.infer<typeof DokployDestination>;

export const DokployBackup = z.object({
	backupId: z.string(),
	schedule: z.string(),
	enabled: bool,
	database: z.string(),
	prefix: z.string(),
	destinationId: z.string(),
	keepLatestCount: int,
	backupType: z.string(),
	/** The backed-up database row: `postgresId`, `mysqlId`... or `composeId`, whichever is set. */
	ownerId: text,
});
export type DokployBackup = z.infer<typeof DokployBackup>;

export const notificationTypes = [
	"slack",
	"telegram",
	"discord",
	"email",
	"resend",
	"gotify",
	"ntfy",
	"mattermost",
	"pushover",
	"custom",
	"lark",
	"teams",
] as const;
export type DokployNotificationType = (typeof notificationTypes)[number];

/** The event switches of a notification, by Dokploy's column name. */
const notificationEvents = {
	appDeploy: z.boolean(),
	appBuildError: z.boolean(),
	databaseBackup: z.boolean(),
	volumeBackup: z.boolean(),
	dokployRestart: z.boolean(),
	dokployBackup: z.boolean(),
	dockerCleanup: z.boolean(),
	serverThreshold: z.boolean(),
};
export const notificationEventColumns = Object.keys(notificationEvents);

export const DokployNotification = z.object({
	notificationId: z.string(),
	name: z.string(),
	notificationType: z.enum(notificationTypes),
	...notificationEvents,
	/** The id of its row in the per-type table (`slackId`, `emailId`...). */
	targetId: text,
});
export type DokployNotification = z.infer<typeof DokployNotification>;

/** A row of one per-type table (`slack`, `email`...), its columns under one shape. */
export const DokployNotificationTarget = z.object({
	type: z.enum(notificationTypes),
	targetId: z.string(),
	webhookUrl: text,
	channel: text,
	username: text,
	botToken: text,
	chatId: text,
	messageThreadId: text,
	smtpServer: text,
	smtpPort: int,
	password: text,
	fromAddress: text,
	toAddress: z.array(z.string()).nullable(),
	apiKey: text,
	serverUrl: text,
	appToken: text,
	topic: text,
	accessToken: text,
	endpoint: text,
	userKey: text,
	apiToken: text,
});
export type DokployNotificationTarget = z.infer<
	typeof DokployNotificationTarget
>;

export const DokploySshKey = z.object({
	sshKeyId: z.string(),
	name: z.string(),
	privateKey: z.string(),
});

export const gitProviderTypes = [
	"github",
	"gitlab",
	"gitea",
	"bitbucket",
] as const;

/** A `github`/`gitlab`/`gitea`/`bitbucket` row; its name is on the `git_provider` row. */
export const DokployGitProvider = z.object({
	type: z.enum(gitProviderTypes),
	/** `githubId`, `gitlabId`...: what applications reference. */
	id: z.string(),
	gitProviderId: z.string(),
	githubAppId: int,
	githubInstallationId: text,
	githubPrivateKey: text,
	githubWebhookSecret: text,
	url: text,
});
export type DokployGitProvider = z.infer<typeof DokployGitProvider>;

export const DokploySnapshot = z.object({
	projects: z.array(DokployProject),
	environments: z.array(DokployEnvironment),
	applications: z.array(DokployApplication),
	databases: z.array(DokployDatabase),
	composes: z.array(DokployCompose),
	domains: z.array(DokployDomain),
	mounts: z.array(DokployMount),
	ports: z.array(DokployPort),
	redirects: z.array(DokployRedirect),
	security: z.array(DokploySecurity),
	registries: z.array(DokployRegistry),
	destinations: z.array(DokployDestination),
	backups: z.array(DokployBackup),
	notifications: z.array(DokployNotification),
	notificationTargets: z.array(DokployNotificationTarget),
	sshKeys: z.array(DokploySshKey),
	gitProviders: z.array(DokployGitProvider),
	gitProviderNames: z.array(
		z.object({ gitProviderId: z.string(), name: z.string() }),
	),
	/** Git-sourced compose files read from disk, by `composeId`; raw ones live in `composeFile`. */
	composeFiles: z.record(z.string(), z.string()).default({}),
});
export type DokploySnapshot = z.infer<typeof DokploySnapshot>;

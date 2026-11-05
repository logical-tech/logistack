/** Dokploy snapshot rows for tests: every column set, overridable. */
import type {
	DokployApplication,
	DokployCompose,
	DokployDatabase,
	DokploySnapshot,
} from "../../src/migration/dokploy/snapshot.ts";

const runtime = {
	environmentId: "e1",
	serverId: null,
	env: null,
	command: null,
	memoryLimit: null,
	cpuLimit: null,
	replicas: 1,
	applicationStatus: "done",
	healthCheckSwarm: null,
	placementSwarm: null,
	modeSwarm: null,
	labelsSwarm: null,
	networkSwarm: null,
	updateConfigSwarm: null,
	restartPolicySwarm: null,
};

export const app = (
	o: Partial<DokployApplication> & { applicationId: string },
): DokployApplication => ({
	name: o.applicationId,
	appName: `${o.applicationId}-abc123`,
	...runtime,
	sourceType: "docker",
	buildType: "nixpacks",
	dockerImage: "nginx:1.27",
	username: null,
	registryUrl: null,
	registryId: null,
	repository: null,
	owner: null,
	branch: null,
	buildPath: null,
	githubId: null,
	gitlabPathNamespace: null,
	gitlabBranch: null,
	gitlabBuildPath: null,
	gitlabId: null,
	giteaOwner: null,
	giteaRepository: null,
	giteaBranch: null,
	giteaBuildPath: null,
	giteaId: null,
	bitbucketOwner: null,
	bitbucketRepository: null,
	bitbucketBranch: null,
	bitbucketBuildPath: null,
	bitbucketId: null,
	customGitUrl: null,
	customGitBranch: null,
	customGitBuildPath: null,
	customGitSSHKeyId: null,
	dockerfile: null,
	dockerContextPath: null,
	dockerBuildStage: null,
	buildArgs: null,
	publishDirectory: null,
	isPreviewDeploymentsActive: false,
	autoDeploy: true,
	...o,
});

export const db = (
	o: Partial<DokployDatabase> & Pick<DokployDatabase, "id" | "engine">,
): DokployDatabase => ({
	name: o.id,
	appName: `${o.id}-def456`,
	...runtime,
	dockerImage: `${o.engine}:16`,
	databaseName: null,
	databaseUser: null,
	databasePassword: null,
	rootPassword: null,
	externalPort: null,
	...o,
});

export const compose = (
	o: Partial<DokployCompose> & { composeId: string },
): DokployCompose => ({
	name: o.composeId,
	appName: `${o.composeId}-ghi789`,
	environmentId: "e1",
	serverId: null,
	sourceType: "raw",
	composeType: "docker-compose",
	composeFile: null,
	composePath: "./docker-compose.yml",
	env: null,
	composeStatus: "done",
	...o,
});

export const snapshot = (o: Partial<DokploySnapshot>): DokploySnapshot => ({
	projects: [{ projectId: "p1", name: "Shop", env: "API_HOST=api.shop.test" }],
	environments: [
		{
			environmentId: "e1",
			projectId: "p1",
			name: "production",
			env: "TIER=prod",
		},
	],
	applications: [],
	databases: [],
	composes: [],
	domains: [],
	mounts: [],
	ports: [],
	redirects: [],
	security: [],
	registries: [],
	destinations: [],
	backups: [],
	notifications: [],
	notificationTargets: [],
	sshKeys: [],
	gitProviders: [],
	gitProviderNames: [],
	composeFiles: {},
	...o,
});

/** A GitHub App provider `gh1` that imports. */
export const github: Partial<DokploySnapshot> = {
	gitProviders: [
		{
			type: "github",
			id: "gh1",
			gitProviderId: "gp1",
			githubAppId: 123,
			githubInstallationId: "456",
			githubPrivateKey:
				"-----BEGIN RSA PRIVATE KEY-----\nfake-gh-key\n-----END RSA PRIVATE KEY-----",
			githubWebhookSecret: "fake-gh-hook",
			url: "https://github.com",
		},
	],
	gitProviderNames: [{ gitProviderId: "gp1", name: "Acme GitHub" }],
};

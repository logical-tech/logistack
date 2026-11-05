import { describe, expect, test } from "bun:test";
import {
	buildInventory,
	type InventoryItem,
	serviceEnv,
} from "../src/migration/dokploy/inventory.ts";
import type {
	DokployApplication,
	DokployCompose,
	DokployDatabase,
	DokploySnapshot,
} from "../src/migration/dokploy/snapshot.ts";

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

const app = (
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

const db = (
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

const compose = (
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

const snapshot = (o: Partial<DokploySnapshot>): DokploySnapshot => ({
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
	composeFiles: {},
	...o,
});

const only = (s: DokploySnapshot): InventoryItem => {
	const [item, ...rest] = buildInventory(s).items;
	if (!item || rest.length) throw new Error("expected one item");
	return item;
};

describe("Dokploy env", () => {
	test("shared references resolve; the result is what the container saw", () => {
		const notes: string[] = [];
		const env = serviceEnv(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: Dokploy's own reference syntax
			"API_URL=https://${{project.API_HOST}}/v1\nTIER=${{environment.TIER}}\nPLAIN=1\nVAULTED=${{vault.x}}\nMISSING=${{project.NOPE}}",
			{ project: "API_HOST=api.shop.test", environment: "TIER=prod" },
			notes,
		);
		expect(env).toEqual([
			{ key: "API_URL", value: "https://api.shop.test/v1", isSecret: true },
			{ key: "TIER", value: "prod", isSecret: true },
			{ key: "PLAIN", value: "1", isSecret: false },
			// biome-ignore lint/suspicious/noTemplateCurlyInString: Dokploy's own reference syntax
			{ key: "MISSING", value: "${{project.NOPE}}", isSecret: false },
		]);
		expect(notes).toEqual([
			"env VAULTED reads a Dokploy vault, skipped",
			"env MISSING references undefined project.NOPE",
		]);
	});
});

describe("Dokploy applications", () => {
	test("an image app with ports, domain, volume, file, bind, basic auth: full", () => {
		const item = only(
			snapshot({
				applications: [
					app({
						applicationId: "web",
						// biome-ignore lint/suspicious/noTemplateCurlyInString: Dokploy's own reference syntax
						env: "SECRET_KEY=fake-app-secret\nHOST=${{project.API_HOST}}",
						command: "nginx -g daemon  off;",
						memoryLimit: "268435456",
						cpuLimit: "500000000",
						replicas: 2,
						placementSwarm: { Constraints: ["node.role==manager"] },
						healthCheckSwarm: {
							Test: ["CMD-SHELL", "curl -f http://localhost/"],
						},
					}),
				],
				ports: [
					{
						applicationId: "web",
						publishedPort: 8080,
						targetPort: 80,
						protocol: "tcp",
						publishMode: "host",
					},
				],
				domains: [
					{
						domainId: "d1",
						host: "shop.example.com",
						https: true,
						port: 80,
						path: "/",
						internalPath: "/",
						stripPath: false,
						serviceName: null,
						domainType: "application",
						certificateType: "letsencrypt",
						applicationId: "web",
						composeId: null,
					},
				],
				mounts: [
					{
						mountId: "m1",
						type: "volume",
						hostPath: null,
						volumeName: "web-uploads",
						filePath: null,
						content: null,
						mountPath: "/uploads/",
						ownerId: "web",
					},
					{
						mountId: "m2",
						type: "file",
						hostPath: null,
						volumeName: null,
						filePath: "nginx.conf",
						content: "events {}",
						mountPath: "/etc/nginx",
						ownerId: "web",
					},
					{
						mountId: "m3",
						type: "bind",
						hostPath: "/srv/static",
						volumeName: null,
						filePath: null,
						content: null,
						mountPath: "/srv",
						ownerId: "web",
					},
				],
				security: [
					{ applicationId: "web", username: "admin", password: "fake-basic" },
				],
			}),
		);
		expect(item).toMatchObject({
			kind: "application",
			project: "Shop",
			environment: "production",
			status: "full",
			notes: [],
		});
		const [svc] = item.services;
		expect(svc).toEqual({
			name: "web",
			slug: "web-abc123",
			dependsOn: [],
			importedFrom: "dokploy:web-abc123",
			spec: {
				kind: "application",
				source: { type: "image", image: "nginx:1.27" },
				build: { type: "image" },
				ports: [{ target: 80, published: 8080, protocol: "tcp", mode: "host" }],
				replicas: 2,
				resources: { cpu: 0.5, memoryMb: 256 },
				placement: ["node.role==manager"],
				healthcheck: {
					type: "command",
					command: ["sh", "-c", "curl -f http://localhost/"],
				},
				command: ["nginx", "-g", "daemon", "off;"],
				mounts: [{ kind: "bind", hostPath: "/srv/static", target: "/srv" }],
			},
			mounts: [
				{ kind: "volume", name: "web-uploads", target: "/uploads" },
				{
					kind: "config",
					target: "/etc/nginx/nginx.conf",
					content: "events {}",
				},
			],
			adoptedVolumes: [
				{ target: "/uploads", volume: "web-uploads", source: "dokploy" },
			],
			env: [
				{ key: "SECRET_KEY", value: "fake-app-secret", isSecret: true },
				{ key: "HOST", value: "api.shop.test", isSecret: true },
			],
			domains: [
				{
					hostname: "shop.example.com",
					port: 80,
					pathPrefix: null,
					https: true,
					cert: "auto",
				},
			],
			basicAuth: [{ username: "admin", password: "fake-basic" }],
			running: true,
		});
	});

	test("a GitHub Dockerfile app keeps its provider; Nixpacks becomes Railpack", () => {
		const s = snapshot({
			applications: [
				app({
					applicationId: "api",
					sourceType: "github",
					buildType: "dockerfile",
					owner: "acme",
					repository: "shop",
					branch: "main",
					buildPath: "/apps/api",
					githubId: "gh1",
					dockerfile: "apps/api/Dockerfile",
					dockerBuildStage: "runtime",
					buildArgs: "NODE_ENV=production",
					applicationStatus: "idle",
				}),
				app({
					applicationId: "site",
					sourceType: "git",
					customGitUrl: "https://git.example.com/acme/site.git",
					customGitBranch: "main",
					customGitBuildPath: "/",
				}),
			],
		});
		const [api, site] = buildInventory(s).items;
		expect(api?.status).toBe("full");
		expect(api?.services[0]).toMatchObject({
			spec: {
				source: {
					type: "git",
					repository: "acme/shop",
					branch: "main",
					path: "apps/api",
				},
				build: {
					type: "dockerfile",
					dockerfilePath: "apps/api/Dockerfile",
					context: ".",
					target: "runtime",
					buildArgs: { NODE_ENV: "production" },
				},
			},
			gitProvider: { type: "github", dokployId: "gh1" },
			running: false,
		});
		expect(site).toMatchObject({
			status: "partial",
			notes: ["built with Railpack instead of nixpacks"],
		});
		expect(site?.services[0]?.spec).toMatchObject({
			source: {
				repository: "https://git.example.com/acme/site.git",
				path: "/",
			},
			build: { type: "railpack" },
		});
		expect(site?.services[0]?.gitProvider).toBeUndefined();
	});

	test("what does not carry over is named, and a drop or remote app is unsupported", () => {
		const s = snapshot({
			applications: [
				app({
					applicationId: "legacy",
					username: "bot",
					registryUrl: "registry.example.com",
					isPreviewDeploymentsActive: true,
					modeSwarm: { Global: {} },
					labelsSwarm: { a: "b" },
				}),
				app({ applicationId: "zip", sourceType: "drop" }),
				app({ applicationId: "far", serverId: "srv1" }),
			],
			redirects: [
				{
					applicationId: "legacy",
					regex: "^/old",
					replacement: "/new",
					permanent: true,
				},
			],
			domains: [
				{
					domainId: "d1",
					host: "legacy.example.com",
					https: true,
					port: 3000,
					path: "/app",
					internalPath: "/internal",
					stripPath: true,
					serviceName: null,
					domainType: "application",
					certificateType: "custom",
					applicationId: "legacy",
					composeId: null,
				},
			],
		});
		const [legacy, zip, far] = buildInventory(s).items;
		expect(legacy?.status).toBe("partial");
		expect(legacy?.notes).toEqual([
			"private registry credentials must be added in LogiStack",
			"preview deployments are not carried over",
			"global mode becomes one replica",
			"custom Swarm labels not carried over",
			"domain legacy.example.com/app: Dokploy stripped the path prefix, LogiStack forwards it",
			"domain legacy.example.com: internal path /internal is not supported",
			"domain legacy.example.com: custom certificate resolver becomes Let's Encrypt",
			"1 redirect rule(s) are not carried over",
		]);
		expect(legacy?.services[0]?.domains[0]?.pathPrefix).toBe("/app");
		expect(zip).toMatchObject({ status: "unsupported", services: [] });
		expect(far).toMatchObject({
			status: "unsupported",
			notes: ["runs on a remote Dokploy server"],
		});
	});
});

describe("Dokploy databases", () => {
	const dataMount = (
		ownerId: string,
		volumeName: string,
		mountPath: string,
	) => ({
		mountId: `m-${ownerId}`,
		type: "volume" as const,
		hostPath: null,
		volumeName,
		filePath: null,
		content: null,
		mountPath,
		ownerId,
	});

	test("an official image adopts its data volume and keeps Dokploy's credentials", () => {
		const item = only(
			snapshot({
				databases: [
					db({
						id: "pg",
						engine: "postgres",
						dockerImage: "postgres:16-alpine",
						databaseUser: "shop",
						databasePassword: "fake-pg-secret",
						databaseName: "shop",
						env: "POSTGRES_PASSWORD=ignored\nTZ=Europe/Rome",
					}),
				],
				mounts: [dataMount("pg", "pg-def456-data", "/var/lib/postgresql/data")],
			}),
		);
		expect(item.status).toBe("full");
		expect(item.services[0]).toEqual({
			name: "pg",
			slug: "pg-def456",
			dependsOn: [],
			importedFrom: "dokploy:pg-def456",
			spec: {
				kind: "database",
				engine: "postgres",
				version: "16-alpine",
				credentialsRef: "dokploy",
				resources: {},
			},
			mounts: [],
			adoptedVolumes: [
				{
					target: "/var/lib/postgresql/data",
					volume: "pg-def456-data",
					source: "dokploy",
				},
			],
			env: [
				{ key: "POSTGRES_USER", value: "shop", isSecret: false },
				{ key: "POSTGRES_PASSWORD", value: "fake-pg-secret", isSecret: true },
				{ key: "POSTGRES_DB", value: "shop", isSecret: false },
				{ key: "TZ", value: "Europe/Rome", isSecret: false },
			],
			domains: [],
			basicAuth: [],
			running: true,
		});
	});

	test("a custom image, Postgres 18 or a missing data volume is unsupported", () => {
		const s = snapshot({
			databases: [
				db({
					id: "vec",
					engine: "postgres",
					dockerImage: "pgvector/pgvector:pg16",
				}),
				db({ id: "new", engine: "postgres", dockerImage: "postgres:18" }),
				db({ id: "nodata", engine: "redis", dockerImage: "redis:7" }),
				db({
					id: "exposed",
					engine: "redis",
					dockerImage: "redis:7",
					databasePassword: "fake-redis-secret",
					externalPort: 6379,
				}),
			],
			mounts: [
				dataMount("new", "new-data", "/var/lib/postgresql/18/docker"),
				dataMount("exposed", "exposed-data", "/data"),
			],
		});
		const [vec, pg18, nodata, exposed] = buildInventory(s).items;
		expect(vec?.notes).toEqual([
			"custom image pgvector/pgvector:pg16; LogiStack runs the official postgres image",
		]);
		expect(pg18?.status).toBe("unsupported");
		expect(nodata?.notes).toEqual([
			"no volume mounted at /data; the data would not carry over",
		]);
		expect(exposed).toMatchObject({
			status: "partial",
			notes: ["external port 6379 is not published"],
		});
		expect(exposed?.services[0]?.env).toEqual([
			{ key: "REDIS_PASSWORD", value: "fake-redis-secret", isSecret: true },
		]);
	});
});

describe("Dokploy compose", () => {
	test("a raw single-service compose maps through the compose mapper", () => {
		const item = only(
			snapshot({
				composes: [
					compose({
						composeId: "wiki",
						env: "DB_PASS=fake-wiki-secret",
						composeFile: `services:
  wiki:
    image: ghcr.io/requarks/wiki:2
    environment:
      DB_PASS: \${DB_PASS}
    volumes:
      - data:/wiki/data
volumes:
  data: {}
`,
					}),
				],
				domains: [
					{
						domainId: "d1",
						host: "wiki.example.com",
						https: true,
						port: 3000,
						path: "/",
						internalPath: "/",
						stripPath: false,
						serviceName: "wiki",
						domainType: "compose",
						certificateType: "letsencrypt",
						applicationId: null,
						composeId: "wiki",
					},
				],
			}),
		);
		expect(item.status).toBe("full");
		expect(item.services[0]).toMatchObject({
			name: "wiki",
			importedFrom: "dokploy:wiki-ghi789/wiki",
			adoptedVolumes: [
				{ target: "/wiki/data", volume: "wiki-ghi789_data", source: "dokploy" },
			],
			env: [{ key: "DB_PASS", value: "fake-wiki-secret", isSecret: true }],
			domains: [
				expect.objectContaining({ hostname: "wiki.example.com", port: 3000 }),
			],
		});
	});

	test("a multi-service compose becomes one service per entry, dependencies first", () => {
		const item = only(
			snapshot({
				composes: [
					compose({
						composeId: "blog",
						sourceType: "github",
						env: "DB_PASSWORD=fake-blog-secret",
					}),
				],
				composeFiles: {
					blog: `services:
  web:
    image: ghost:5
    depends_on: [db]
    environment:
      database__connection__host: db
      database__connection__password: \${DB_PASSWORD}
  db:
    image: mysql:8
    environment:
      MYSQL_ROOT_PASSWORD: \${DB_PASSWORD}
    volumes: [ "mysql:/var/lib/mysql" ]
volumes:
  mysql: {}
`,
				},
				domains: [
					{
						domainId: "d1",
						host: "blog.example.com",
						https: true,
						port: 2368,
						path: "/",
						internalPath: "/",
						stripPath: false,
						serviceName: "web",
						domainType: "compose",
						certificateType: "letsencrypt",
						applicationId: null,
						composeId: "blog",
					},
					{
						domainId: "d2",
						host: "gone.example.com",
						https: true,
						port: 80,
						path: "/",
						internalPath: "/",
						stripPath: false,
						serviceName: "removed",
						domainType: "compose",
						certificateType: "letsencrypt",
						applicationId: null,
						composeId: "blog",
					},
				],
			}),
		);
		expect(item.status).toBe("partial");
		expect(item.notes).toEqual([
			"domain gone.example.com names no service of the file, skipped",
		]);
		expect(item.services.map((s) => [s.slug, s.dependsOn])).toEqual([
			["db", []],
			["web", ["db"]],
		]);
		const [db, web] = item.services;
		expect(db?.adoptedVolumes).toEqual([
			{
				target: "/var/lib/mysql",
				volume: "blog-ghi789_mysql",
				source: "dokploy",
			},
		]);
		expect(web?.domains.map((d) => d.hostname)).toEqual(["blog.example.com"]);
		expect(web?.env).toContainEqual({
			key: "database__connection__password",
			value: "fake-blog-secret",
			isSecret: true,
		});
	});

	test("a git compose without its file on disk, or a bad service name, is unsupported", () => {
		const s = snapshot({
			composes: [
				compose({ composeId: "nofile", sourceType: "github" }),
				compose({
					composeId: "underscore",
					composeFile: "services:\n  my_app: { image: x }\n",
				}),
			],
		});
		const [nofile, underscore] = buildInventory(s).items;
		expect(nofile?.notes).toEqual(["github compose file not found on disk"]);
		expect(underscore).toMatchObject({
			status: "unsupported",
			notes: [
				"service name my_app is not a DNS label, so siblings could not reach it",
			],
		});
	});
});

describe("across items", () => {
	test("a hostname taken twice in one environment refuses the later item", () => {
		const s = snapshot({
			composes: [
				compose({
					composeId: "a",
					composeFile: "services:\n  db: { image: x }\n",
				}),
				compose({
					composeId: "b",
					composeFile: "services:\n  db: { image: y }\n",
				}),
			],
		});
		const [a, b] = buildInventory(s).items;
		expect(a?.status).toBe("full");
		expect(b).toMatchObject({
			status: "unsupported",
			notes: ["hostname db is already used in this environment by a"],
		});
	});

	test("an env value reaching a service of another environment is reported", () => {
		const s = snapshot({
			environments: [
				{ environmentId: "e1", projectId: "p1", name: "production", env: null },
				{ environmentId: "e2", projectId: "p1", name: "staging", env: null },
			],
			databases: [
				db({
					id: "pg",
					engine: "postgres",
					dockerImage: "postgres:16",
					environmentId: "e2",
				}),
			],
			mounts: [
				{
					mountId: "m",
					type: "volume",
					hostPath: null,
					volumeName: "pg-def456-data",
					filePath: null,
					content: null,
					mountPath: "/var/lib/postgresql/data",
					ownerId: "pg",
				},
			],
			applications: [
				app({
					applicationId: "web",
					env: "DATABASE_URL=postgres://u:p@pg-def456:5432/app\nOTHER=xpg-def456",
				}),
			],
		});
		const [, web] = buildInventory(s).items;
		expect(web).toMatchObject({
			status: "partial",
			notes: [
				"env DATABASE_URL reaches pg in another environment; LogiStack environments are isolated",
			],
		});
	});
});

test("the inventory never carries a secret into its notes", () => {
	const s = snapshot({
		applications: [
			app({
				applicationId: "a",
				env: "TOKEN=fake-token-1\nBAD-KEY=fake-token-2",
			}),
		],
		databases: [
			db({
				id: "d",
				engine: "postgres",
				dockerImage: "postgres:15",
				databasePassword: "fake-token-3",
			}),
		],
	});
	const notes = JSON.stringify(buildInventory(s).items.map((i) => i.notes));
	for (const secret of ["fake-token-1", "fake-token-2", "fake-token-3"])
		expect(notes).not.toContain(secret);
});

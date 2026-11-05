/**
 * Reads a Dokploy database into a `DokploySnapshot`. Read-only: SELECTs inside a READ ONLY
 * transaction. Every column is checked against `information_schema` first, so a Dokploy version
 * with another schema is refused with the missing columns named instead of half-read.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
	type DokployEngine,
	DokploySnapshot,
	databaseEngines,
} from "./snapshot.ts";

const runtimeColumns = [
	"name",
	"appName",
	"environmentId",
	"serverId",
	"env",
	"command",
	"memoryLimit",
	"cpuLimit",
	"replicas",
	"applicationStatus",
	"healthCheckSwarm",
	"placementSwarm",
	"modeSwarm",
	"labelsSwarm",
	"networkSwarm",
	"updateConfigSwarm",
	"restartPolicySwarm",
];

/** Per engine: the snapshot field, and the column it comes from (null when the engine has none). */
const databaseColumns: Record<
	DokployEngine,
	Record<
		"databaseName" | "databaseUser" | "databasePassword" | "rootPassword",
		string | null
	>
> = {
	postgres: {
		databaseName: "databaseName",
		databaseUser: "databaseUser",
		databasePassword: "databasePassword",
		rootPassword: null,
	},
	mysql: {
		databaseName: "databaseName",
		databaseUser: "databaseUser",
		databasePassword: "databasePassword",
		rootPassword: "rootPassword",
	},
	mariadb: {
		databaseName: "databaseName",
		databaseUser: "databaseUser",
		databasePassword: "databasePassword",
		rootPassword: "rootPassword",
	},
	mongo: {
		databaseName: null,
		databaseUser: "databaseUser",
		databasePassword: "databasePassword",
		rootPassword: null,
	},
	redis: {
		databaseName: null,
		databaseUser: null,
		databasePassword: "password",
		rootPassword: null,
	},
};

const mountOwners = [
	"applicationId",
	"postgresId",
	"mysqlId",
	"mariadbId",
	"mongoId",
	"redisId",
	"composeId",
];

/** `columns` are the real columns read, for the schema check; `select` is what the SQL says. */
type Query = { table: string; columns: string[]; select: string[] };

const q = (c: string) => `"${c}"`;

/** Every query, built only from the constant column lists above: no outside input reaches SQL. */
function queries(): Record<string, Query | Query[]> {
	const plain = (table: string, columns: string[]): Query => ({
		table,
		columns,
		select: columns.map(q),
	});
	return {
		projects: plain("project", ["projectId", "name", "env"]),
		environments: plain("environment", [
			"environmentId",
			"projectId",
			"name",
			"env",
		]),
		applications: plain("application", [
			"applicationId",
			...runtimeColumns,
			"sourceType",
			"buildType",
			"dockerImage",
			"username",
			"registryUrl",
			"registryId",
			"repository",
			"owner",
			"branch",
			"buildPath",
			"githubId",
			"gitlabPathNamespace",
			"gitlabBranch",
			"gitlabBuildPath",
			"gitlabId",
			"giteaOwner",
			"giteaRepository",
			"giteaBranch",
			"giteaBuildPath",
			"giteaId",
			"bitbucketOwner",
			"bitbucketRepository",
			"bitbucketBranch",
			"bitbucketBuildPath",
			"bitbucketId",
			"customGitUrl",
			"customGitBranch",
			"customGitBuildPath",
			"customGitSSHKeyId",
			"dockerfile",
			"dockerContextPath",
			"dockerBuildStage",
			"buildArgs",
			"publishDirectory",
			"isPreviewDeploymentsActive",
			"autoDeploy",
		]),
		databases: databaseEngines.map((engine) => {
			const cols = databaseColumns[engine];
			return {
				table: engine,
				columns: [
					`${engine}Id`,
					...runtimeColumns,
					"dockerImage",
					"externalPort",
					...Object.values(cols).filter((c): c is string => c !== null),
				],
				select: [
					`'${engine}' as "engine"`,
					`${q(`${engine}Id`)} as "id"`,
					...runtimeColumns.map(q),
					q("dockerImage"),
					q("externalPort"),
					...Object.entries(cols).map(([field, column]) =>
						column ? `${q(column)} as ${q(field)}` : `null as ${q(field)}`,
					),
				],
			};
		}),
		composes: plain("compose", [
			"composeId",
			"name",
			"appName",
			"environmentId",
			"serverId",
			"sourceType",
			"composeType",
			"composeFile",
			"composePath",
			"env",
			"composeStatus",
		]),
		domains: plain("domain", [
			"domainId",
			"host",
			"https",
			"port",
			"path",
			"internalPath",
			"stripPath",
			"serviceName",
			"domainType",
			"certificateType",
			"applicationId",
			"composeId",
		]),
		mounts: (() => {
			const columns = [
				"mountId",
				"type",
				"hostPath",
				"volumeName",
				"filePath",
				"content",
				"mountPath",
			];
			return {
				table: "mount",
				columns: [...columns, ...mountOwners],
				select: [
					...columns.map(q),
					`coalesce(${mountOwners.map(q).join(", ")}) as "ownerId"`,
				],
			};
		})(),
		ports: plain("port", [
			"applicationId",
			"publishedPort",
			"targetPort",
			"protocol",
			"publishMode",
		]),
		redirects: plain("redirect", [
			"applicationId",
			"regex",
			"replacement",
			"permanent",
		]),
		security: plain("security", ["applicationId", "username", "password"]),
	};
}

/** Every column the reader reads. */
export const requiredColumns = () =>
	Object.values(queries())
		.flat()
		.flatMap((query) =>
			query.columns.map((column) => ({ table: query.table, column })),
		);

/** Columns the queries need that the database lacks, as `table.column`. */
export function missingColumns(
	present: { table: string; column: string }[],
): string[] {
	const have = new Set(present.map((p) => `${p.table}.${p.column}`));
	return requiredColumns()
		.map(({ table, column }) => `${table}.${column}`)
		.filter((c) => !have.has(c));
}

/**
 * Git-sourced compose files as Dokploy last checked them out:
 * `<root>/<appName>/code/<composePath>`. A path escaping its folder is skipped.
 */
export function readComposeFiles(
	composes: {
		composeId: string;
		appName: string;
		sourceType: string;
		composePath: string | null;
	}[],
	root: string,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const c of composes) {
		if (c.sourceType === "raw") continue;
		const dir = resolve(root, c.appName, "code");
		const file = resolve(dir, c.composePath || "docker-compose.yml");
		if (!file.startsWith(dir + sep) || !existsSync(file)) continue;
		out[c.composeId] = readFileSync(file, "utf8");
	}
	return out;
}

/** `composeRoot`: Dokploy's compose directory (`/etc/dokploy/compose`), read for git-sourced files. */
export async function readDokploy(
	url: string,
	opts: { composeRoot?: string } = {},
): Promise<DokploySnapshot> {
	const sql = new Bun.SQL(url, { max: 1 });
	try {
		return await sql.begin("read only", async (tx) => {
			const present: { table: string; column: string }[] = await tx`
				select table_name as "table", column_name as "column"
				from information_schema.columns where table_schema = 'public'`;
			const missing = missingColumns(present);
			if (missing.length)
				throw new Error(
					`unsupported Dokploy schema, missing ${missing.join(", ")}`,
				);
			const out: Record<string, unknown[]> = {};
			for (const [key, query] of Object.entries(queries())) {
				out[key] = [];
				for (const one of [query].flat())
					out[key].push(
						...(await tx.unsafe(
							`select ${one.select.join(", ")} from ${q(one.table)}`,
						)),
					);
			}
			const snapshot = DokploySnapshot.parse(out);
			if (opts.composeRoot)
				snapshot.composeFiles = readComposeFiles(
					snapshot.composes,
					opts.composeRoot,
				);
			return snapshot;
		});
	} finally {
		await sql.close();
	}
}

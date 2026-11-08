import type { DatabaseEngine } from "@logistack/contracts";

// Dump and restore of a database from inside its own container, shared by scheduled backups
// (worker) and on-demand dumps (api). Credentials come from the container's env and reach the
// tools through env or a 0600 file, never argv.

/** File extension of each dump format, so a bucket listing tells them apart. */
export const DUMP_EXTENSION: Record<DatabaseEngine, string> = {
	postgres: "dump",
	mysql: "sql",
	mariadb: "sql",
	mongo: "archive",
	redis: "rdb",
	libsql: "sql",
};

// biome-ignore lint/suspicious/noTemplateCurlyInString: expanded by the container shell
const pgUser = '"${POSTGRES_USER:-postgres}"';
// biome-ignore lint/suspicious/noTemplateCurlyInString: expanded by the container shell
const pgDb = '"${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"';

/** A MySQL option file in /tmp, removed whatever the tool exits with. */
const myCnf = (passwordVar: string) =>
	[
		"umask 077",
		'cnf="$(mktemp)"',
		"trap 'rm -f \"$cnf\"' EXIT",
		`printf '[client]\\nuser=root\\npassword="%s"\\n' "$${passwordVar}" > "$cnf"`,
	].join("\n");

const mongoCfg = [
	"umask 077",
	'cfg="$(mktemp)"',
	"trap 'rm -f \"$cfg\"' EXIT",
	`printf 'password: "%s"\\n' "$MONGO_INITDB_ROOT_PASSWORD" > "$cfg"`,
].join("\n");
const mongoAuth =
	'--authenticationDatabase admin --username "$MONGO_INITDB_ROOT_USERNAME" --config "$cfg"';

const mariaPassword = "MARIADB_ROOT_PASSWORD:-$MYSQL_ROOT_PASSWORD";

// sqld has no dump CLI and its image no HTTP client: bash speaks HTTP/1.0 to /dump over /dev/tcp.
// printf is a builtin, so the token never reaches an argv. Header lines end in \r; the blank one is just \r.
const libsqlDump = `exec bash -c 'set -e
exec 3<>/dev/tcp/127.0.0.1/8080
printf "GET /dump HTTP/1.0\\r\\nAuthorization: Bearer %s\\r\\n\\r\\n" "$LIBSQL_AUTH_TOKEN" >&3
IFS= read -r status <&3
[[ $status == *" 200 "* ]] || { echo "dump failed: $status" >&2; exit 1; }
while IFS= read -r line <&3 && (( \${#line} > 1 )); do :; done
exec cat <&3'
`;

/** Writes the whole dump to stdout, nothing else. */
export function dumpScript(engine: DatabaseEngine): string {
	switch (engine) {
		case "postgres":
			return `set -e\nexport PGPASSWORD="$POSTGRES_PASSWORD"\nexec pg_dump -Fc -U ${pgUser} -d ${pgDb}\n`;
		case "mysql":
			return `set -e\n${myCnf("MYSQL_ROOT_PASSWORD")}\nmysqldump --defaults-extra-file="$cnf" --single-transaction --routines --events --triggers --all-databases\n`;
		case "mariadb":
			return `set -e\n${myCnf(`{${mariaPassword}}`)}\nmariadb-dump --defaults-extra-file="$cnf" --single-transaction --routines --events --triggers --all-databases\n`;
		case "mongo":
			return `set -e\n${mongoCfg}\nmongodump --quiet --archive ${mongoAuth}\n`;
		case "redis":
			return `set -e\nexport REDISCLI_AUTH="$REDIS_PASSWORD"\nexec redis-cli --rdb -\n`;
		case "libsql":
			return libsqlDump;
	}
}

/** Reads a dump on stdin into the service's own database, replacing what it holds. */
export function restoreScript(engine: DatabaseEngine): string {
	switch (engine) {
		case "postgres":
			return `set -e\nexport PGPASSWORD="$POSTGRES_PASSWORD"\nexec pg_restore --clean --if-exists -U ${pgUser} -d ${pgDb}`;
		case "mysql":
			return `set -e\n${myCnf("MYSQL_ROOT_PASSWORD")}\nmysql --defaults-extra-file="$cnf"`;
		case "mariadb":
			return `set -e\n${myCnf(`{${mariaPassword}}`)}\nmariadb --defaults-extra-file="$cnf"`;
		case "mongo":
			return `set -e\n${mongoCfg}\nmongorestore --quiet --archive --drop ${mongoAuth}`;
		case "redis":
			throw new Error(
				"Redis restores copy the RDB into the data volume; restore the volume instead",
			);
		case "libsql":
			throw new Error(
				"libSQL dumps are not restored; restore the volume instead",
			);
	}
}

// Major-version upgrades (docs/plans/database-ops.md §3): the whole instance moves, roles included.

/** Engines the upgrade assistant moves by dump and restore. */
export const UPGRADABLE_ENGINES = [
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
] as const satisfies DatabaseEngine[];

/** Writes every database of the instance to stdout. */
export function upgradeDumpScript(engine: DatabaseEngine): string {
	if (engine === "postgres")
		return `set -e\nexport PGPASSWORD="$POSTGRES_PASSWORD"\nexec pg_dumpall -U ${pgUser}\n`;
	return dumpScript(engine);
}

/**
 * Reads `upgradeDumpScript` output into a fresh instance initialised with the same credentials.
 * Postgres replays SQL and goes on past errors: the superuser role it recreates already exists.
 */
export function upgradeRestoreScript(engine: DatabaseEngine): string {
	if (engine === "postgres")
		return `set -e\nexport PGPASSWORD="$POSTGRES_PASSWORD"\nexec psql -q -U ${pgUser} -d postgres >/dev/null`;
	return restoreScript(engine);
}

/**
 * Prints `<database>.<schema>.<table>\t<exact rows>` for every user table (MySQL and MariaDB:
 * `<schema>.<table>`; Mongo: `<database>.<collection>` and its documents), sorted.
 */
export function rowCountScript(engine: DatabaseEngine): string {
	switch (engine) {
		case "postgres":
			return `set -e
export PGPASSWORD="$POSTGRES_PASSWORD"
psql -U ${pgUser} -d postgres -At -c "select datname from pg_database where datallowconn and not datistemplate order by 1" |
while IFS= read -r d; do
  psql -U ${pgUser} -d "$d" -At <<'SQL' | psql -U ${pgUser} -d "$d" -At
select format('select %L || chr(9) || count(*) from %I.%I;', current_database() || '.' || schemaname || '.' || tablename, schemaname, tablename)
from pg_tables where schemaname not in ('pg_catalog', 'information_schema') order by 1;
SQL
done | sort
`;
		case "mysql":
		case "mariadb": {
			const cli = engine === "mysql" ? "mysql" : "mariadb";
			const cnf =
				engine === "mysql" ? "MYSQL_ROOT_PASSWORD" : `{${mariaPassword}}`;
			return `set -e
${myCnf(cnf)}
${cli} --defaults-extra-file="$cnf" -N -B <<'SQL' | ${cli} --defaults-extra-file="$cnf" -N -B | sort
select concat('select ', quote(concat(table_schema, '.', table_name)), ', count(*) from \`', replace(table_schema, '\`', '\`\`'), '\`.\`', replace(table_name, '\`', '\`\`'), '\`;')
from information_schema.tables where table_type = 'BASE TABLE'
and table_schema not in ('mysql', 'information_schema', 'performance_schema', 'sys') order by 1;
SQL
`;
		}
		case "mongo":
			// The password comes from the container's env inside the script, never argv.
			return `set -e
mongosh --nodb --quiet --eval "$(cat <<'JS'
const e = process.env;
const admin = connect("mongodb://" + encodeURIComponent(e.MONGO_INITDB_ROOT_USERNAME) + ":" + encodeURIComponent(e.MONGO_INITDB_ROOT_PASSWORD) + "@127.0.0.1:27017/admin?authSource=admin");
for (const d of admin.adminCommand({ listDatabases: 1 }).databases) {
  if (["admin", "local", "config"].includes(d.name)) continue;
  const db = admin.getSiblingDB(d.name);
  for (const c of db.getCollectionNames()) if (!c.startsWith("system.")) print(d.name + "." + c + "\\t" + db.getCollection(c).countDocuments({}));
}
JS
)" | sort
`;
		case "redis":
		case "libsql":
			throw new Error(`${engine} has no major-version upgrade`);
	}
}

/** Parses `rowCountScript` output. */
export function parseRowCounts(output: string): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const line of output.split("\n")) {
		const tab = line.lastIndexOf("\t");
		if (tab < 0) continue;
		const n = Number(line.slice(tab + 1));
		if (Number.isInteger(n)) counts[line.slice(0, tab)] = n;
	}
	return counts;
}

/** Tables whose counts differ between source and copy, as readable lines; empty when they match. */
export function compareRowCounts(
	source: Record<string, number>,
	copy: Record<string, number>,
): string[] {
	const names = [...new Set([...Object.keys(source), ...Object.keys(copy)])];
	return names
		.sort()
		.filter((n) => source[n] !== copy[n])
		.map(
			(n) =>
				`${n}: ${source[n] ?? "missing"} before, ${copy[n] ?? "missing"} after`,
		);
}

/** The numbers an image tag starts with: `17-alpine` → [17], `11.4.2` → [11, 4, 2]; [] for `latest`. */
export const versionNumbers = (tag: string) =>
	(/^\d+(\.\d+)*/.exec(tag)?.[0] ?? "").split(".").filter(Boolean).map(Number);

/** True when tag `to` names a later release than `from`: 16 → 17, 8.0 → 8.4, never 17 → 17-alpine. */
export function isLaterVersion(from: string, to: string): boolean {
	const a = versionNumbers(from);
	const b = versionNumbers(to);
	if (!a.length || !b.length) return false;
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const x = a[i] ?? 0;
		const y = b[i] ?? 0;
		if (x !== y) return y > x;
	}
	return false;
}

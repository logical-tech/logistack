import type { DatabaseEngine } from "@logistack/contracts";

// Shell run inside containers (script on stdin, or `sh -c` for execs that need stdin for data).
// Credentials come from the container's own env and reach the tools through env or a 0600 file,
// never argv. Pure: unit-tested in units.test.ts.

/** File extension of each dump format, so a bucket listing tells them apart. */
export const DUMP_EXTENSION: Record<DatabaseEngine, string> = {
	postgres: "dump",
	mysql: "sql",
	mariadb: "sql",
	mongo: "archive",
	redis: "rdb",
};
export const VOLUME_EXTENSION = "tar.zst";

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
	}
}

// A throwaway verify container runs without credentials: trust auth, nothing to leak.

export const VERIFY_DATA_DIR: Record<DatabaseEngine, string> = {
	postgres: "/var/lib/postgresql",
	mysql: "/var/lib/mysql",
	mariadb: "/var/lib/mysql",
	mongo: "/data/db",
	redis: "/data",
};

export const VERIFY_ENV: Record<DatabaseEngine, string[]> = {
	postgres: ["POSTGRES_HOST_AUTH_METHOD=trust"],
	mysql: ["MYSQL_ALLOW_EMPTY_PASSWORD=yes"],
	mariadb: ["MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=yes"],
	mongo: [],
	redis: [],
};

/**
 * Exits 0 once the server accepts TCP connections. The images' init phase runs a temporary
 * server on the socket only, so a TCP probe never catches it mid-init.
 */
export function readyScript(engine: DatabaseEngine, timeoutSec = 120): string {
	const probe: Record<DatabaseEngine, string> = {
		postgres: "pg_isready -q -h 127.0.0.1 -U postgres",
		mysql: "mysqladmin ping -h 127.0.0.1 -uroot --silent",
		mariadb: "mariadb-admin ping -h 127.0.0.1 -uroot --silent",
		mongo:
			"mongosh --quiet --host 127.0.0.1 --eval 'db.adminCommand({ping:1}).ok' >/dev/null",
		redis: "redis-cli -h 127.0.0.1 ping | grep -q PONG",
	};
	return `i=0\nuntil ${probe[engine]} 2>/dev/null; do\n  i=$((i+1)); [ $i -ge ${timeoutSec} ] && { echo "not ready after ${timeoutSec}s" >&2; exit 1; }\n  sleep 1\ndone\n`;
}

/** Restore into the verify container: no owners or grants, since its roles are not the original's. */
export function verifyRestoreScript(engine: DatabaseEngine): string {
	switch (engine) {
		case "postgres":
			return "exec pg_restore --no-owner --no-privileges -U postgres -d postgres";
		case "mysql":
			return "exec mysql -uroot";
		case "mariadb":
			return "exec mariadb -uroot";
		case "mongo":
			return "exec mongorestore --quiet --archive";
		case "redis":
			throw new Error("Redis backups cannot be verified by a restore");
	}
}

/** Prints one line: a count of user tables (SQL) or the user databases (Mongo). */
export function sanityScript(engine: DatabaseEngine): string {
	const sqlTables = (cli: string) =>
		`exec ${cli} -uroot -N -e "select count(*) from information_schema.tables where table_schema not in ('mysql','information_schema','performance_schema','sys')"`;
	switch (engine) {
		case "postgres":
			return `exec psql -U postgres -d postgres -tAc "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')"`;
		case "mysql":
			return sqlTables("mysql");
		case "mariadb":
			return sqlTables("mariadb");
		case "mongo":
			return `exec mongosh --quiet --eval "db.adminCommand({ping:1}).ok === 1 && print(db.adminCommand({listDatabases:1}).databases.map(d => d.name).filter(n => !['admin','local','config'].includes(n)).join(','))"`;
		case "redis":
			throw new Error("Redis backups cannot be verified by a restore");
	}
}

/** What the sanity output means: passes only on at least one table (or database). */
export function judgeSanity(
	engine: DatabaseEngine,
	output: string,
): { ok: boolean; detail: string } {
	const line = output.trim().split("\n").at(-1)?.trim() ?? "";
	if (engine === "mongo") {
		const dbs = line ? line.split(",") : [];
		return dbs.length
			? { ok: true, detail: `${dbs.length} database(s): ${dbs.join(", ")}` }
			: { ok: false, detail: "the restored server has no user databases" };
	}
	const n = Number(line);
	if (!Number.isInteger(n))
		return {
			ok: false,
			detail: `unexpected sanity output: ${line.slice(0, 200)}`,
		};
	return n > 0
		? { ok: true, detail: `${n} table${n === 1 ? "" : "s"} restored` }
		: { ok: false, detail: "the restore produced no tables" };
}

// Volumes: the tools image may lack zstd (alpine); it is fetched once per container then.
const ensureZstd =
	"command -v zstd >/dev/null 2>&1 || apk add --no-cache -q zstd >/dev/null";

/** Archives /data (mounted read-only) to stdout. */
export const volumeBackupScript = `set -e -o pipefail\n${ensureZstd}\ntar -C /data -cf - . | zstd -q -T0 -3 -c\n`;

/** Empties /data, then unpacks the archive on stdin into it. */
export const volumeRestoreScript = `set -e -o pipefail\n${ensureZstd}\nfind /data -mindepth 1 -delete\nzstd -q -dc | tar -xf - -C /data`;

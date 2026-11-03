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

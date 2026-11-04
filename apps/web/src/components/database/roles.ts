import type { DbRole } from "@logistack/contracts";
import { type Dialect, quote } from "./ddl";

/** A role's access to one schema, as the explorer offers it. */
export type Access = "none" | "read" | "write" | "all" | "custom";
export const ACCESS_LEVELS = ["none", "read", "write", "all"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const ACCESS_LABEL: Record<Access, string> = {
	none: "No access",
	read: "Read",
	write: "Read & write",
	all: "All privileges",
	custom: "Custom",
};

export type RoleRef = { name: string; host?: string };

/** One string per role: the name, or MySQL's `name@host`. */
export const roleKey = (r: RoleRef) =>
	r.host === undefined ? r.name : `${r.name}@${r.host}`;

const literal = (s: string) =>
	`'${s.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;

/** The role as a statement names it: `"app"`, or `'app'@'%'`. */
export const roleSql = (d: Dialect, r: RoleRef) =>
	d === "postgres"
		? quote(d, r.name)
		: `${literal(r.name)}@${literal(r.host ?? "%")}`;

const WRITE = ["SELECT", "INSERT", "UPDATE", "DELETE"];
const ALL_ONLY: Record<Dialect, string[]> = {
	postgres: ["REFERENCES", "TRIGGER", "TRUNCATE"],
	mysql: ["ALTER", "CREATE", "DROP", "INDEX"],
};

/** The level a set of privileges amounts to; anything off the ladder is `custom`. */
export function accessOf(d: Dialect, privileges: string[]): Access {
	const has = (p: string) => privileges.includes(p);
	if (privileges.length === 0) return "none";
	if ([...WRITE, ...ALL_ONLY[d]].every(has)) return "all";
	if (privileges.length === 1 && has("SELECT")) return "read";
	if (privileges.length === WRITE.length && WRITE.every(has)) return "write";
	return "custom";
}

export const accessIn = (d: Dialect, role: DbRole, schema: string) =>
	accessOf(d, role.grants.find((g) => g.schema === schema)?.privileges ?? []);

/**
 * Statements that move `role` from `from` to `to` on every table of `schema`. Postgres also
 * sets default privileges, so tables the explorer's login creates later follow; tables another
 * role creates keep their owner's defaults.
 */
export function accessSql(
	d: Dialect,
	role: RoleRef,
	schema: string,
	from: Access,
	to: AccessLevel,
): string[] {
	const r = roleSql(d, role);
	const s = quote(d, schema);
	if (d === "mysql") {
		// MySQL refuses to revoke a grant that isn't there.
		const revoke =
			from === "none" ? [] : [`revoke all privileges on ${s}.* from ${r}`];
		const grant = {
			none: [],
			read: [`grant select on ${s}.* to ${r}`],
			write: [`grant select, insert, update, delete on ${s}.* to ${r}`],
			all: [`grant all privileges on ${s}.* to ${r}`],
		}[to];
		return [...revoke, ...grant];
	}
	const revoke =
		from === "none"
			? []
			: [
					`revoke all on all tables in schema ${s} from ${r}`,
					`revoke all on all sequences in schema ${s} from ${r}`,
					`alter default privileges in schema ${s} revoke all on tables from ${r}`,
					`alter default privileges in schema ${s} revoke all on sequences from ${r}`,
					`revoke all on schema ${s} from ${r}`,
				];
	const tables = { read: "select", write: "select, insert, update, delete" };
	if (to === "none") return revoke;
	if (to === "all")
		return [
			...revoke,
			`grant all on schema ${s} to ${r}`,
			`grant all on all tables in schema ${s} to ${r}`,
			`grant all on all sequences in schema ${s} to ${r}`,
			`alter default privileges in schema ${s} grant all on tables to ${r}`,
			`alter default privileges in schema ${s} grant all on sequences to ${r}`,
		];
	return [
		...revoke,
		`grant usage on schema ${s} to ${r}`,
		`grant ${tables[to]} on all tables in schema ${s} to ${r}`,
		`alter default privileges in schema ${s} grant ${tables[to]} on tables to ${r}`,
		...(to === "write"
			? [
					`grant usage, select on all sequences in schema ${s} to ${r}`,
					`alter default privileges in schema ${s} grant usage, select on sequences to ${r}`,
				]
			: []),
	];
}

/** Postgres role attributes the explorer edits. */
export type RoleAttributes = Pick<
	DbRole,
	"login" | "superuser" | "createDb" | "createRole"
>;
const ATTRIBUTE: Record<keyof RoleAttributes, string> = {
	login: "login",
	superuser: "superuser",
	createDb: "createdb",
	createRole: "createrole",
};

/** One ALTER ROLE for the attributes that changed, or none. */
export function attributesSql(
	role: RoleRef,
	from: RoleAttributes,
	to: RoleAttributes,
): string[] {
	const words = (Object.keys(ATTRIBUTE) as (keyof RoleAttributes)[])
		.filter((k) => Boolean(from[k]) !== Boolean(to[k]))
		.map((k) => `${to[k] ? "" : "no"}${ATTRIBUTE[k]}`);
	return words.length
		? [`alter role ${roleSql("postgres", role)} with ${words.join(" ")}`]
		: [];
}

/** Postgres: GRANT and REVOKE of group memberships. */
export function membershipSql(
	role: RoleRef,
	from: string[],
	to: string[],
): string[] {
	const r = roleSql("postgres", role);
	return [
		...to
			.filter((g) => !from.includes(g))
			.map((g) => `grant ${quote("postgres", g)} to ${r}`),
		...from
			.filter((g) => !to.includes(g))
			.map((g) => `revoke ${quote("postgres", g)} from ${r}`),
	];
}

/**
 * Postgres hands what the role owns in this database to the explorer's login first, so no
 * data goes with it; objects it owns in other databases still block the drop.
 */
export const dropRoleSql = (d: Dialect, role: RoleRef): string[] =>
	d === "postgres"
		? [
				`reassign owned by ${roleSql(d, role)} to current_user`,
				`drop owned by ${roleSql(d, role)}`,
				`drop role ${roleSql(d, role)}`,
			]
		: [`drop user ${roleSql(d, role)}`];

export const script = (statements: string[]) =>
	statements.map((s) => `${s};`).join("\n");

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** 24 characters from an unambiguous alphabet, ~139 bits. */
export function generatePassword(length = 24): string {
	const bytes = crypto.getRandomValues(new Uint32Array(length));
	return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

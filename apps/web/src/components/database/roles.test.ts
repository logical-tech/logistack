import { describe, expect, test } from "bun:test";
import {
	accessOf,
	accessSql,
	attributesSql,
	dropRoleSql,
	generatePassword,
	membershipSql,
	roleSql,
} from "./roles";

describe("accessOf", () => {
	test("ladders Postgres table privileges", () => {
		expect(accessOf("postgres", [])).toBe("none");
		expect(accessOf("postgres", ["SELECT"])).toBe("read");
		expect(accessOf("postgres", ["DELETE", "INSERT", "SELECT", "UPDATE"])).toBe(
			"write",
		);
		expect(
			accessOf("postgres", [
				"DELETE",
				"INSERT",
				"MAINTAIN",
				"REFERENCES",
				"SELECT",
				"TRIGGER",
				"TRUNCATE",
				"UPDATE",
			]),
		).toBe("all");
		expect(accessOf("postgres", ["INSERT"])).toBe("custom");
		expect(accessOf("postgres", ["SELECT", "TRUNCATE"])).toBe("custom");
	});
	test("needs MySQL's DDL privileges for all", () => {
		expect(accessOf("mysql", ["DELETE", "INSERT", "SELECT", "UPDATE"])).toBe(
			"write",
		);
		expect(
			accessOf("mysql", [
				"ALTER",
				"CREATE",
				"DELETE",
				"DROP",
				"EVENT",
				"INDEX",
				"INSERT",
				"SELECT",
				"UPDATE",
			]),
		).toBe("all");
	});
});

describe("roleSql", () => {
	test("quotes names so any name stays one name", () => {
		expect(roleSql("postgres", { name: 'a"b' })).toBe('"a""b"');
		expect(roleSql("mysql", { name: "o'k\\", host: "10.0.%" })).toBe(
			"'o''k\\\\'@'10.0.%'",
		);
		expect(roleSql("mysql", { name: "app" })).toBe("'app'@'%'");
	});
});

describe("accessSql", () => {
	test("Postgres revokes, then grants the level with default privileges", () => {
		const sql = accessSql(
			"postgres",
			{ name: "app" },
			"public",
			"read",
			"write",
		);
		expect(sql[0]).toBe(
			'revoke all on all tables in schema "public" from "app"',
		);
		expect(sql).toContain(
			'grant select, insert, update, delete on all tables in schema "public" to "app"',
		);
		expect(sql).toContain(
			'alter default privileges in schema "public" grant usage, select on sequences to "app"',
		);
		expect(
			accessSql("postgres", { name: "app" }, "public", "write", "none"),
		).toHaveLength(5);
		expect(
			accessSql("postgres", { name: "app" }, "public", "none", "read")[0],
		).toBe('grant usage on schema "public" to "app"');
	});
	test("MySQL only revokes a grant that exists", () => {
		const r = { name: "app", host: "%" };
		expect(accessSql("mysql", r, "shop", "none", "read")).toEqual([
			"grant select on `shop`.* to 'app'@'%'",
		]);
		expect(accessSql("mysql", r, "shop", "read", "all")).toEqual([
			"revoke all privileges on `shop`.* from 'app'@'%'",
			"grant all privileges on `shop`.* to 'app'@'%'",
		]);
		expect(accessSql("mysql", r, "shop", "none", "none")).toEqual([]);
	});
});

test("attributesSql alters only what changed", () => {
	const off = {
		login: true,
		superuser: false,
		createDb: false,
		createRole: false,
	};
	expect(attributesSql({ name: "app" }, off, off)).toEqual([]);
	expect(
		attributesSql({ name: "app" }, off, {
			...off,
			login: false,
			createDb: true,
		}),
	).toEqual(['alter role "app" with nologin createdb']);
});

test("membershipSql grants new groups and revokes dropped ones", () => {
	expect(membershipSql({ name: "app" }, ["a", "b"], ["b", "c"])).toEqual([
		'grant "c" to "app"',
		'revoke "a" from "app"',
	]);
});

test("dropRoleSql hands owned objects over before dropping a Postgres role", () => {
	expect(dropRoleSql("postgres", { name: "app" })).toEqual([
		'reassign owned by "app" to current_user',
		'drop owned by "app"',
		'drop role "app"',
	]);
	expect(dropRoleSql("mysql", { name: "app", host: "%" })).toEqual([
		"drop user 'app'@'%'",
	]);
});

test("generatePassword draws from the unambiguous alphabet", () => {
	const p = generatePassword();
	expect(p).toHaveLength(24);
	expect(p).toMatch(/^[A-HJ-NP-Za-km-z2-9]+$/);
	expect(generatePassword()).not.toBe(p);
});

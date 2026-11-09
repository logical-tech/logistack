import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

const env = {
	DATABASE_URL: "postgres://u:p@localhost:5433/db",
	REDIS_URL: "redis://localhost:6380",
	LOGISTACK_MASTER_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
	BETTER_AUTH_SECRET: "dev-only-change-me-0123456789abcdef0123456789abcdef",
	BETTER_AUTH_URL: "http://localhost:3000",
	WEB_ORIGIN: "http://localhost:5173",
};
const realKey = Buffer.alloc(32, 7).toString("base64");

test("the .env.example secrets load outside production", () => {
	expect(() => loadConfig({ ...env, NODE_ENV: "test" })).not.toThrow();
});

test("production refuses the .env.example master key and auth secret", () => {
	expect(() => loadConfig({ ...env, NODE_ENV: "production" })).toThrow(
		/LOGISTACK_MASTER_KEY/,
	);
	expect(() =>
		loadConfig({
			...env,
			LOGISTACK_MASTER_KEY: realKey,
			NODE_ENV: "production",
		}),
	).toThrow(/BETTER_AUTH_SECRET/);
	expect(() =>
		loadConfig({
			...env,
			LOGISTACK_MASTER_KEY: realKey,
			BETTER_AUTH_SECRET: "x".repeat(40),
			NODE_ENV: "production",
		}),
	).not.toThrow();
});

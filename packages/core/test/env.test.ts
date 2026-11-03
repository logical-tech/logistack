import { expect, test } from "bun:test";
import { resolveEnv, type ScopedEnvVar } from "../src/env.ts";

const v = (
	scope: ScopedEnvVar["scope"],
	key: string,
	value: string,
	extra: Partial<ScopedEnvVar> = {},
): ScopedEnvVar => ({
	scope,
	key,
	value,
	isSecret: false,
	isBuildTime: false,
	...extra,
});

test("more specific scope overrides, regardless of input order", () => {
	const resolved = resolveEnv([
		v("service", "LOG_LEVEL", "debug"),
		v("organization", "LOG_LEVEL", "info"),
		v("environment", "LOG_LEVEL", "warn"),
		v("project", "LOG_LEVEL", "error"),
	]);
	expect(resolved).toEqual({
		LOG_LEVEL: {
			scope: "service",
			value: "debug",
			isSecret: false,
			isBuildTime: false,
		},
	});
});

test("keys from every scope are merged", () => {
	const resolved = resolveEnv([
		v("organization", "SENTRY_DSN", "dsn"),
		v("project", "APP_NAME", "web"),
		v("environment", "NODE_ENV", "production"),
		v("service", "PORT", "3000"),
	]);
	expect(
		Object.fromEntries(
			Object.entries(resolved).map(([k, r]) => [k, `${r.scope}:${r.value}`]),
		),
	).toEqual({
		SENTRY_DSN: "organization:dsn",
		APP_NAME: "project:web",
		NODE_ENV: "environment:production",
		PORT: "service:3000",
	});
});

test("an override carries its own flags and an empty value still overrides", () => {
	const resolved = resolveEnv([
		v("project", "TOKEN", "abc", { isSecret: true, isBuildTime: true }),
		v("environment", "TOKEN", ""),
	]);
	expect(resolved.TOKEN).toEqual({
		scope: "environment",
		value: "",
		isSecret: false,
		isBuildTime: false,
	});
});

test("empty input resolves to nothing", () => {
	expect(resolveEnv([])).toEqual({});
});

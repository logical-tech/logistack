import { expect, test } from "bun:test";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, loadCredentials, saveCredentials } from "../src/config.ts";

test("login is saved owner-only, and the environment overrides it", async () => {
	const env = { XDG_CONFIG_HOME: await mkdtemp(join(tmpdir(), "ls-cli-")) };
	expect(await loadCredentials(env)).toBeNull();
	await saveCredentials(
		{ url: "https://ls.example.com", apiKey: "lss_a" },
		env,
	);
	expect((await stat(configPath(env))).mode & 0o777).toBe(0o600);
	expect(await loadCredentials(env)).toEqual({
		url: "https://ls.example.com",
		apiKey: "lss_a",
	});
	expect(
		await loadCredentials({
			...env,
			LOGISTACK_URL: "https://ci.example.com",
			LOGISTACK_API_KEY: "lss_ci",
		}),
	).toEqual({ url: "https://ci.example.com", apiKey: "lss_ci" });
});

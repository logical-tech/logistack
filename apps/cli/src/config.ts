import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

export const Credentials = z.object({
	url: z.url(),
	apiKey: z.string().min(1),
});
export type Credentials = z.infer<typeof Credentials>;

export const configPath = (env = process.env) =>
	join(
		env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
		"logistack",
		"config.json",
	);

/**
 * `LOGISTACK_URL` and `LOGISTACK_API_KEY` (for CI) win over the file `login` writes. The key is
 * never read from argv: it would land in shell history and in `ps`.
 */
export async function loadCredentials(
	env = process.env,
): Promise<Credentials | null> {
	let file: Partial<Credentials> = {};
	try {
		file = JSON.parse(await readFile(configPath(env), "utf8"));
	} catch {}
	const parsed = Credentials.safeParse({
		url: env.LOGISTACK_URL ?? file.url,
		apiKey: env.LOGISTACK_API_KEY ?? file.apiKey,
	});
	return parsed.success ? parsed.data : null;
}

export async function saveCredentials(c: Credentials, env = process.env) {
	const path = configPath(env);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
	// writeFile keeps the mode of a file that already exists.
	await chmod(path, 0o600);
	return path;
}

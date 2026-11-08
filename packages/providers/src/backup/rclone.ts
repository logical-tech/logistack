import { z } from "zod";
import { ProviderError } from "../http.ts";
import {
	type BackupDestination,
	type BackupObject,
	lazyStream,
	probeRoundTrip,
} from "./destination.ts";

// Destinations rclone reaches. The remote is defined only through RCLONE_CONFIG_<REMOTE>_*
// variables in the child's environment: no config file, and no secret ever in argv.

const REMOTE = "DEST";
const text = z.string().trim();
/** A folder under the remote's root; no `..`, no leading slash on cloud stores. */
const folder = text
	.max(500)
	.refine((p) => !p.split("/").includes(".."), "no .. segments")
	.default("");
const container = text.regex(
	/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/,
	"3 to 63 lowercase letters, digits and dashes",
);

export const rcloneKinds = [
	"sftp",
	"webdav",
	"azureblob",
	"drive",
	"b2",
] as const;
export type RcloneKind = (typeof rcloneKinds)[number];

/** Settings stored in the clear (the `config` column) per kind. */
export const rcloneSettings = {
	sftp: z.object({
		host: text.min(1).max(253),
		port: z.number().int().min(1).max(65535).default(22),
		user: text.min(1).max(128),
		path: folder,
	}),
	webdav: z.object({
		url: z.url({ protocol: /^https?$/ }),
		vendor: z
			.enum(["other", "nextcloud", "owncloud", "sharepoint", "fastmail"])
			.default("other"),
		user: text.max(256).default(""),
		path: folder,
	}),
	azureblob: z.object({
		account: text.regex(
			/^[a-z0-9]{3,24}$/,
			"3 to 24 lowercase letters and digits",
		),
		container,
		path: folder,
	}),
	drive: z.object({
		/** Optional: the id of the folder that acts as the root. */
		rootFolderId: text.max(200).default(""),
		path: folder,
	}),
	b2: z.object({
		account: text.min(1).max(200),
		bucket: text.regex(
			/^[A-Za-z0-9-]{6,50}$/,
			"6 to 50 letters, digits and dashes",
		),
		path: folder,
	}),
} satisfies Record<RcloneKind, z.ZodType>;

/** Settings stored encrypted (the `secret_encrypted` column) per kind. */
export const rcloneSecrets = {
	sftp: z
		.object({
			password: z.string().max(1024).optional(),
			/** PEM, unencrypted. */
			privateKey: z.string().max(16_384).optional(),
		})
		.refine((s) => s.password || s.privateKey, "a password or a private key"),
	webdav: z.object({ password: z.string().max(1024).optional() }),
	azureblob: z.object({ key: z.string().min(1).max(512) }),
	drive: z
		.object({
			/** The JSON `rclone authorize "drive"` prints. */
			token: z.string().max(8192).optional(),
			/** A service account's JSON key, for a Shared Drive or a folder shared with it. */
			serviceAccount: z.string().max(16_384).optional(),
		})
		.refine(
			(s) => s.token || s.serviceAccount,
			"an OAuth token or a service account key",
		),
	b2: z.object({ key: z.string().min(1).max(512) }),
} satisfies Record<RcloneKind, z.ZodType>;

export type RcloneConfig = {
	[K in RcloneKind]: {
		kind: K;
		settings: z.infer<(typeof rcloneSettings)[K]>;
		secrets: z.infer<(typeof rcloneSecrets)[K]>;
	};
}[RcloneKind];

const trimSlashes = (p: string) => p.replace(/^\/+|\/+$/g, "");

/** Where the remote's root is, as `REMOTE:path` takes it. */
export function rcloneRoot(c: RcloneConfig): string {
	const s = c.settings;
	switch (c.kind) {
		case "azureblob":
			return [c.settings.container, trimSlashes(s.path)]
				.filter(Boolean)
				.join("/");
		case "b2":
			return [c.settings.bucket, trimSlashes(s.path)].filter(Boolean).join("/");
		case "sftp":
			// A leading slash is absolute on the server; without one it is under the user's home.
			return s.path.replace(/\/+$/, "");
		default:
			return trimSlashes(s.path);
	}
}

/** The child's environment; `obscure` turns a password into what rclone's `pass` options take. */
export async function rcloneEnv(
	c: RcloneConfig,
	obscure: (secret: string) => Promise<string>,
): Promise<Record<string, string>> {
	const v: Record<string, string> = { TYPE: c.kind };
	switch (c.kind) {
		case "sftp":
			v.HOST = c.settings.host;
			v.PORT = String(c.settings.port);
			v.USER = c.settings.user;
			if (c.secrets.password) v.PASS = await obscure(c.secrets.password);
			if (c.secrets.privateKey) v.KEY_PEM = c.secrets.privateKey.trim();
			// rclone would otherwise run md5sum/sha1sum over ssh, which chrooted servers refuse.
			v.SHELL_TYPE = "none";
			break;
		case "webdav":
			v.URL = c.settings.url;
			v.VENDOR = c.settings.vendor;
			if (c.settings.user) v.USER = c.settings.user;
			if (c.secrets.password) v.PASS = await obscure(c.secrets.password);
			break;
		case "azureblob":
			v.ACCOUNT = c.settings.account;
			v.KEY = c.secrets.key;
			break;
		case "drive":
			v.SCOPE = "drive";
			if (c.settings.rootFolderId) v.ROOT_FOLDER_ID = c.settings.rootFolderId;
			if (c.secrets.token) v.TOKEN = c.secrets.token;
			if (c.secrets.serviceAccount)
				v.SERVICE_ACCOUNT_CREDENTIALS = c.secrets.serviceAccount;
			break;
		case "b2":
			v.ACCOUNT = c.settings.account;
			v.KEY = c.secrets.key;
			// Retention means deleted: without it B2 only hides the file and keeps billing for it.
			v.HARD_DELETE = "true";
			break;
	}
	return Object.fromEntries(
		Object.entries(v).map(([k, val]) => [`RCLONE_CONFIG_${REMOTE}_${k}`, val]),
	);
}

const FLAGS = [
	"--config",
	"",
	"--log-level",
	"ERROR",
	"--retries",
	"1",
	"--low-level-retries",
	"3",
	"--contimeout",
	"30s",
	"--timeout",
	"5m",
];
const STDERR_TAIL = 2000;
/** rclone's exit code for "directory not found". */
const DIR_NOT_FOUND = 3;

type Spawned = ReturnType<
	typeof Bun.spawn<"pipe" | ReadableStream, "pipe", "pipe">
>;

/** An rclone remote as a BackupDestination. `binary` defaults to `rclone` on PATH. */
export function rcloneDestination(
	config: RcloneConfig,
	opts: { binary?: string } = {},
): BackupDestination {
	const bin = opts.binary ?? "rclone";
	const root = rcloneRoot(config);
	const at = (key: string) =>
		`${REMOTE}:${[root, key].filter(Boolean).join("/")}`;
	// Only PATH and HOME from the parent: the worker's own secrets never reach the child.
	const base = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/tmp" };
	const env = rcloneEnv(config, async (secret) => {
		const p = Bun.spawn([bin, ...FLAGS, "obscure", "-"], {
			stdin: new Blob([secret]),
			stdout: "pipe",
			stderr: "pipe",
			env: base,
		});
		const [out, err, code] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
			p.exited,
		]);
		if (code !== 0)
			throw new ProviderError(
				"rclone",
				"obscure",
				err.trim().slice(-STDERR_TAIL),
			);
		return out.trim();
	});
	env.catch(() => {});

	async function spawn(
		args: string[],
		stdin: ReadableStream<Uint8Array> | "ignore" = "ignore",
	): Promise<Spawned> {
		return Bun.spawn([bin, ...FLAGS, ...args], {
			stdin,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...base, ...(await env) },
		}) as Spawned;
	}

	const fail = (op: string, code: number | null, stderr: string) =>
		new ProviderError(
			"rclone",
			op,
			`exit ${code}: ${stderr.trim().slice(-STDERR_TAIL) || "no output on stderr"}`,
		);

	/** Runs to completion; stdout as text. */
	async function run(op: string, args: string[], ok = [0]) {
		const p = await spawn(args);
		const [out, err, code] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
			p.exited,
		]);
		if (!ok.includes(code)) throw fail(op, code, err);
		return { out, code };
	}

	const dest: BackupDestination = {
		probe: () => probeRoundTrip(dest),
		async upload(key, body) {
			// rcat streams stdin to the remote; the pipe holds the source back while the remote is slow.
			const p = await spawn(["rcat", at(key)], body);
			const [err, code] = await Promise.all([
				new Response(p.stderr).text(),
				p.exited,
				new Response(p.stdout).text(),
			]);
			if (code !== 0) throw fail("upload", code, err);
		},
		download: (key) =>
			lazyStream(async () => {
				const p = await spawn(["cat", at(key)]);
				const err = new Response(p.stderr).text();
				const out = p.stdout.getReader();
				return new ReadableStream<Uint8Array>(
					{
						async pull(c) {
							const { value, done } = await out.read();
							if (!done) return c.enqueue(value);
							const code = await p.exited;
							if (code !== 0) c.error(fail("download", code, await err));
							else c.close();
						},
						cancel() {
							p.kill();
						},
					},
					{ highWaterMark: 0 },
				);
			}),
		async list(prefix = "") {
			const { out, code } = await run(
				"list",
				["lsjson", "-R", "--files-only", "--no-mimetype", at(prefix)],
				[0, DIR_NOT_FOUND],
			);
			if (code === DIR_NOT_FOUND) return [];
			const dir = prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix;
			return (
				JSON.parse(out) as { Path: string; Size: number; ModTime: string }[]
			).map(
				(o): BackupObject => ({
					key: `${dir}${o.Path}`,
					size: o.Size,
					lastModified: new Date(o.ModTime),
				}),
			);
		},
		async delete(key) {
			await run("delete", ["deletefile", at(key)]);
		},
	};
	return dest;
}

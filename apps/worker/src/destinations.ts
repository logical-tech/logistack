import {
	type BackupDestination,
	type BackupObject,
	lazyStream,
	ProviderError,
	type RcloneConfig,
	type RcloneKind,
	rcloneKinds,
	rcloneSecrets,
	rcloneSettings,
} from "@logistack/providers";
import { z } from "zod";
import {
	feed,
	type NodeRunner,
	STDIN_WINDOW_BYTES,
	tail,
} from "./node-runner.ts";

// Backup destination kinds beyond S3, importable by the api for its probe. S3 keeps its own
// columns; the others keep clear settings in `config` and their secrets encrypted as one JSON.

export const destinationKinds = ["s3", ...rcloneKinds, "local"] as const;
export type DestinationKind = (typeof destinationKinds)[number];

/** `local`: a folder that already exists on one node. */
export const localSettings = z.object({
	path: z
		.string()
		.trim()
		.regex(/^\/[^\0]*$/, "an absolute path")
		.max(500)
		.refine((p) => !p.split("/").includes(".."), "no .. segments")
		.refine((p) => p.replace(/\/+$/, "") !== "", "not the root folder"),
});

/** Keys the worker writes: `backups/<policy>/<stamp>-<run>.<ext>` and the probe. */
const SAFE_KEY = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,500}$/;
function checkKey(key: string) {
	if (!SAFE_KEY.test(key))
		throw new ProviderError(
			"local",
			"key",
			`refusing key ${JSON.stringify(key)}`,
		);
	return key;
}

const MOUNT = "/dest";
const JOB_TIMEOUT_S = 6 * 3600;
const ACK_WINDOW_BYTES = 8 * 1024 * 1024;

// Fixed scripts; the key arrives in $KEY, never spliced into the text.
const LIST_SCRIPT = `set -e
cd ${MOUNT}
[ -d "./$PREFIX" ] || exit 0
find "./$PREFIX" -type f ! -name '*.part' -exec stat -c '%s %Y %n' {} +
`;
const READ_SCRIPT = `exec cat -- "${MOUNT}/$KEY"\n`;
const DELETE_SCRIPT = `rm -f -- "${MOUNT}/$KEY"\n`;
const WRITE_SCRIPT = `set -e
f="${MOUNT}/$KEY"
mkdir -p "$(dirname "$f")"
cat > "$f.part"
mv -f "$f.part" "$f"
`;
const PROBE_SCRIPT = `set -e
f="${MOUNT}/.logistack-probe-$PROBE"
printf %s "$PROBE" > "$f"
test "$(cat "$f")" = "$PROBE"
rm -f "$f"
`;

export type LocalEnv = {
	nodes: NodeRunner;
	/** Swarm node id. */
	swarmNodeId: string;
	/** Absolute host path, already present on the node. */
	path: string;
	image: string;
	/** A fresh container name for a one-shot job (`ls-...`). */
	jobName(): string;
	labels: Record<string, string>;
	/**
	 * Runs `fn` with a running Swarm service on the node that mounts the folder at /dest, then
	 * removes it. Only uploads need one; without it (the api's probe) uploads refuse.
	 */
	helper?: <T>(
		o: { swarmNodeId: string; source: string; target: string },
		fn: (swarmServiceId: string) => Promise<T>,
	) => Promise<T>;
};

/** A folder on one node, reached through its agent; bytes never land on the control plane. */
export function localDestination(o: LocalEnv): BackupDestination {
	const source = o.path.replace(/\/+$/, "");
	const job = (script: string, env: string[], window = false) =>
		o.nodes.runJob(o.swarmNodeId, {
			kind: "container",
			image: o.image,
			containerName: o.jobName(),
			labels: o.labels,
			mounts: [{ type: "bind", source, target: MOUNT }],
			script,
			env,
			timeoutSec: window ? JOB_TIMEOUT_S : 300,
			...(window
				? {
						outputLimitBytes: Number.MAX_SAFE_INTEGER,
						ackWindowBytes: ACK_WINDOW_BYTES,
					}
				: {}),
		});
	async function run(op: string, script: string, env: string[]) {
		const j = job(script, env);
		let out = "";
		let err = "";
		const dec = new TextDecoder();
		for await (const c of j)
			if (c.stream === "stdout") out += dec.decode(c.data, { stream: true });
			else err = tail(err + dec.decode(c.data, { stream: true }));
		const r = await j.result;
		if (r.exitCode !== 0)
			throw new ProviderError(
				"local",
				op,
				`exit ${r.exitCode}: ${err.trim() || "no output on stderr"}`,
			);
		return out;
	}

	const dest: BackupDestination = {
		probe: async () => {
			await run("probe", PROBE_SCRIPT, [`PROBE=${crypto.randomUUID()}`]);
		},
		async upload(key, body) {
			if (!o.helper)
				throw new ProviderError("local", "upload", "uploads run in the worker");
			const at = { swarmNodeId: o.swarmNodeId, source, target: MOUNT };
			await o.helper(at, async (serviceId) => {
				const exec = o.nodes.exec(
					o.swarmNodeId,
					{
						target: { kind: "service", serviceId },
						cmd: ["sh", "-c", WRITE_SCRIPT],
						env: [`KEY=${checkKey(key)}`],
						stdin: true,
					},
					{
						timeoutMs: JOB_TIMEOUT_S * 1000,
						stdinWindowBytes: STDIN_WINDOW_BYTES,
					},
				);
				await feed(exec, body);
			});
		},
		download: (key) =>
			lazyStream(async () => {
				const j = job(READ_SCRIPT, [`KEY=${checkKey(key)}`], true);
				let err = "";
				const dec = new TextDecoder();
				return (async function* () {
					for await (const c of j)
						if (c.stream === "stdout") yield c.data;
						else err = tail(err + dec.decode(c.data, { stream: true }));
					const r = await j.result;
					if (r.exitCode !== 0)
						throw new ProviderError(
							"local",
							"download",
							`exit ${r.exitCode}: ${err.trim() || "no output on stderr"}`,
						);
				})();
			}),
		async list(prefix = "") {
			if (prefix) checkKey(prefix);
			const out = await run("list", LIST_SCRIPT, [`PREFIX=${prefix}`]);
			return out
				.split("\n")
				.filter(Boolean)
				.map((line): BackupObject => {
					const [size, mtime, ...name] = line.split(" ");
					return {
						key: name.join(" ").replace(/^\.\//, ""),
						size: Number(size),
						lastModified: new Date(Number(mtime) * 1000),
					};
				});
		},
		async delete(key) {
			await run("delete", DELETE_SCRIPT, [`KEY=${checkKey(key)}`]);
		},
	};
	return dest;
}

/** Parses a stored or submitted rclone destination. */
export function rcloneConfig(
	kind: RcloneKind,
	settings: unknown,
	secrets: unknown,
): RcloneConfig {
	return {
		kind,
		settings: rcloneSettings[kind].parse(settings),
		secrets: rcloneSecrets[kind].parse(secrets),
	} as RcloneConfig;
}

/** The host an rclone kind dials, for the SSRF guard; cloud kinds dial fixed public APIs. */
export function rcloneHost(
	c: RcloneConfig,
): { host: string; plain: boolean } | undefined {
	if (c.kind === "sftp") return { host: c.settings.host, plain: false };
	if (c.kind === "webdav") {
		const u = new URL(c.settings.url);
		return { host: u.hostname, plain: u.protocol === "http:" };
	}
	return undefined;
}

export const isRcloneKind = (k: string): k is RcloneKind =>
	(rcloneKinds as readonly string[]).includes(k);

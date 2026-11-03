import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlockedHostError, type HostPolicy, resolvePublic } from "../ssrf.ts";

/** Splits `ssh://[user@]host[:port]/path` or scp-style `user@host:path` around its host. */
export function sshHost(
	url: string,
): { host: string; withHost: (h: string) => string } | null {
	if (url.startsWith("ssh://")) {
		const u = URL.parse(url);
		if (!u?.hostname) return null;
		return {
			host: u.hostname,
			withHost: (h) => {
				const pinned = new URL(url);
				pinned.hostname = h;
				return pinned.href;
			},
		};
	}
	const m = /^([\w.-]+@)?([\w.-]+):(.+)$/.exec(url);
	if (!m?.[2]) return null;
	return {
		host: m[2],
		withHost: (h) => `${m[1] ?? ""}${h}:${m[3]}`,
	};
}

/**
 * `git ls-remote` over SSH with a deploy key written to a private temp dir. The host must
 * resolve to a public address (unless the policy allows private hosts) and the connection is
 * pinned to it, with HostKeyAlias keeping known_hosts on the name. Git runs GIT_SSH_COMMAND
 * through sh, so it holds only values produced here: temp paths and a checked hostname.
 */
export async function lsRemoteSsh(o: {
	url: string;
	/** Without one, any reachable head passes. */
	branch?: string;
	privateKey: string;
	knownHosts?: string;
	policy: HostPolicy;
}): Promise<{ ok: boolean; message: string; detail?: string }> {
	const parsed = sshHost(o.url);
	if (!parsed)
		return {
			ok: false,
			message: "Use an SSH URL",
			detail: "Like git@git.example.com:team/app.git",
		};
	let address: string;
	try {
		address = await resolvePublic(parsed.host, o.policy);
	} catch (e) {
		if (e instanceof BlockedHostError)
			return { ok: false, message: "Host not allowed", detail: e.message };
		throw e;
	}
	const pinned = parsed.withHost(
		isIP(address) === 6 ? `[${address}]` : address,
	);
	const dir = await mkdtemp(join(tmpdir(), "ls-ssh-"));
	try {
		const key = join(dir, "id");
		const hosts = join(dir, "known_hosts");
		await writeFile(key, o.privateKey, { mode: 0o600 });
		await chmod(key, 0o600);
		await writeFile(hosts, o.knownHosts ?? "");
		const proc = Bun.spawn(
			[
				"git",
				"ls-remote",
				"--exit-code",
				"--heads",
				"--",
				pinned,
				...(o.branch ? [o.branch] : []),
			],
			{
				env: {
					PATH: process.env.PATH ?? "/usr/bin:/bin",
					GIT_TERMINAL_PROMPT: "0",
					GIT_ALLOW_PROTOCOL: "ssh",
					GIT_SSH_COMMAND: `ssh -i '${key}' -o IdentitiesOnly=yes -o BatchMode=yes -o HostKeyAlias='${parsed.host}' -o UserKnownHostsFile='${hosts}' -o StrictHostKeyChecking=${o.knownHosts ? "yes" : "accept-new"}`,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const timer = setTimeout(() => proc.kill(), 20_000);
		const [code, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stderr).text(),
		]);
		clearTimeout(timer);
		if (code === 0)
			return {
				ok: true,
				message: o.branch
					? `Reached ${o.branch} over SSH`
					: "Reached the repository over SSH",
			};
		if (code === 2)
			return {
				ok: false,
				message: o.branch ? `Branch ${o.branch} not found` : "No branches yet",
				detail: "The repository answered, but has no matching branch.",
			};
		return {
			ok: false,
			message: "SSH access failed",
			detail:
				stderr.trim().split("\n").at(-1) ||
				"Add the public key as a deploy key on the repository.",
		};
	} catch (e) {
		return {
			ok: false,
			message: "Couldn't run git",
			detail: e instanceof Error ? e.message : String(e),
		};
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

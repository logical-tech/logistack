import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SshHost, SshUser } from "@logistack/contracts";

export type SshTarget = { host: string; port: number; user: string };

/**
 * argv for one SSH session. User input (host, user, port) only ever lands in its own argv slot,
 * after `-l`/`-p`/`--`; the remote command is the constant `sh -s` and the script travels on
 * stdin, so nothing the user typed is parsed by a local or remote shell.
 */
export function sshArgv(
	target: SshTarget,
	files: { key: string; knownHosts: string },
	pinned: boolean,
): string[] {
	const host = SshHost.parse(target.host);
	const user = SshUser.parse(target.user);
	if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535)
		throw new Error(`invalid port ${target.port}`);
	return [
		"ssh",
		"-F",
		"/dev/null",
		"-i",
		files.key,
		"-o",
		"IdentitiesOnly=yes",
		"-o",
		"BatchMode=yes",
		"-o",
		`StrictHostKeyChecking=${pinned ? "yes" : "accept-new"}`,
		"-o",
		`UserKnownHostsFile=${files.knownHosts}`,
		"-o",
		"GlobalKnownHostsFile=/dev/null",
		"-o",
		"ConnectTimeout=10",
		"-o",
		"ServerAliveInterval=15",
		"-o",
		"LogLevel=ERROR",
		"-p",
		String(target.port),
		"-l",
		user,
		"--",
		host,
		"sh",
		"-s",
	];
}

export type SshResult = {
	code: number | null;
	stdout: string;
	stderr: string;
	/** known_hosts content after the session: the host key accepted (or verified) by ssh. */
	hostKey: string;
};

/**
 * Runs `script` on the target over SSH. The private key and known_hosts live in a private temp
 * dir removed afterwards. `hostKey` pins the server key seen by an earlier session; without it
 * the first key is accepted and returned for pinning.
 */
export async function runSsh(
	target: SshTarget,
	privateKey: string,
	script: string,
	opts: {
		hostKey?: string | null;
		onLine?: (line: string) => void;
		timeoutMs?: number;
	} = {},
): Promise<SshResult> {
	const dir = await mkdtemp(join(tmpdir(), "ls-ssh-"));
	try {
		const key = join(dir, "id");
		const knownHosts = join(dir, "known_hosts");
		await writeFile(key, `${privateKey.trim()}\n`, { mode: 0o600 });
		await writeFile(knownHosts, opts.hostKey ?? "", { mode: 0o600 });
		const argv = sshArgv(target, { key, knownHosts }, Boolean(opts.hostKey));
		const proc = Bun.spawn(argv, {
			stdin: new TextEncoder().encode(script),
			stdout: "pipe",
			stderr: "pipe",
		});
		const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 120_000);
		const read = async (stream: ReadableStream<Uint8Array>) => {
			let all = "";
			let partial = "";
			const decoder = new TextDecoder();
			for await (const chunk of stream) {
				const text = decoder.decode(chunk, { stream: true });
				all += text;
				const lines = (partial + text).split("\n");
				partial = lines.pop() ?? "";
				for (const l of lines) opts.onLine?.(l);
			}
			if (partial) opts.onLine?.(partial);
			return all;
		};
		const [stdout, stderr, code] = await Promise.all([
			read(proc.stdout),
			read(proc.stderr),
			proc.exited,
		]);
		clearTimeout(timer);
		return {
			code,
			stdout,
			stderr,
			hostKey: await readFile(knownHosts, "utf8"),
		};
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

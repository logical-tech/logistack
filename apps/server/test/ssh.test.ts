import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateEd25519, parsePrivateKey, SshKeyError } from "../src/ssh.ts";

const sshKeygen = Bun.which("ssh-keygen");

function keygen(...args: string[]) {
	const p = Bun.spawnSync([sshKeygen as string, ...args], { stderr: "pipe" });
	if (p.exitCode !== 0) throw new Error(p.stderr.toString());
	return p.stdout.toString().trim();
}

function withKeyFile<T>(pem: string, fn: (path: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "ls-test-server-ssh-"));
	try {
		const path = join(dir, "id");
		writeFileSync(path, pem);
		chmodSync(path, 0o600);
		return fn(path);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("ssh keys", () => {
	test("a generated key round-trips through the parser", () => {
		const k = generateEd25519("deploy@acme");
		expect(k.publicKey).toMatch(
			/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5\S+ deploy@acme$/,
		);
		const parsed = parsePrivateKey(k.privateKey, "deploy@acme");
		expect(parsed).toMatchObject({
			type: "ssh-ed25519",
			publicKey: k.publicKey,
			fingerprint: k.fingerprint,
		});
	});

	test.skipIf(!sshKeygen)(
		"ssh-keygen reads the private key and agrees on public key and fingerprint",
		() => {
			const k = generateEd25519("ci");
			withKeyFile(k.privateKey, (path) => {
				expect(keygen("-y", "-f", path)).toBe(k.publicKey);
				expect(keygen("-l", "-f", path)).toContain(k.fingerprint);
			});
		},
	);

	test.skipIf(!sshKeygen).each(["ed25519", "rsa"])(
		"imports a %s key ssh-keygen made",
		(type) => {
			const dir = mkdtempSync(join(tmpdir(), "ls-test-server-ssh-"));
			try {
				const path = join(dir, "id");
				keygen("-q", "-t", type, "-N", "", "-C", "x", "-f", path);
				const parsed = parsePrivateKey(readFileSync(path, "utf8"), "x");
				expect(parsed.publicKey).toBe(keygen("-y", "-f", path));
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(!sshKeygen)("refuses a key with a passphrase", () => {
		const dir = mkdtempSync(join(tmpdir(), "ls-test-server-ssh-"));
		try {
			const path = join(dir, "id");
			keygen("-q", "-t", "ed25519", "-N", "hunter22", "-f", path);
			expect(() => parsePrivateKey(readFileSync(path, "utf8"), "x")).toThrow(
				"passphrase",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("refuses anything that is not an OpenSSH private key", () => {
		expect(() => parsePrivateKey("ssh-ed25519 AAAA", "x")).toThrow(SshKeyError);
		expect(() =>
			parsePrivateKey(
				"-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
				"x",
			),
		).toThrow(SshKeyError);
	});
});

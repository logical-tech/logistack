import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Generates an Ed25519 signing key for the index.
//   bun scripts/keygen.ts --dev   writes .dev.vars (gitignored) for `wrangler dev`
//   bun scripts/keygen.ts         prints the private key on stdout only, for `wrangler secret put SIGNING_KEY`
// The public key goes to stderr: it is what LogiStack servers trust (PLUGIN_INDEX_KEYS).

const pair = (await crypto.subtle.generateKey("Ed25519", true, [
	"sign",
	"verify",
])) as CryptoKeyPair;
const pkcs8 = Buffer.from(
	await crypto.subtle.exportKey("pkcs8", pair.privateKey),
).toString("base64url");
const pub = Buffer.from(
	await crypto.subtle.exportKey("raw", pair.publicKey),
).toString("base64url");

if (process.argv.includes("--dev")) {
	const file = join(import.meta.dir, "../.dev.vars");
	if (existsSync(file)) throw new Error(`${file} exists; delete it first`);
	writeFileSync(
		file,
		`SIGNING_KEY=${pkcs8}\nDEV_LOGIN_LINKS=1\nPUBLIC_ORIGIN=http://localhost:8787\nBASE_PATH=\n`,
		{
			mode: 0o600,
		},
	);
	console.error(`wrote .dev.vars; dev public key: ${pub}`);
} else {
	console.error(`public key: ${pub}`);
	// No trailing newline: the output is piped straight into `wrangler secret put`.
	process.stdout.write(pkcs8);
}

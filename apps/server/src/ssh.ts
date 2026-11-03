import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";

/** OpenSSH key files without shelling out to ssh-keygen: the `openssh-key-v1` container, unencrypted. */

const MAGIC = Buffer.from("openssh-key-v1\0", "latin1");
const ARMOR_BEGIN = "-----BEGIN OPENSSH PRIVATE KEY-----";
const ARMOR_END = "-----END OPENSSH PRIVATE KEY-----";

export type SshKeyMaterial = {
	/** `ssh-ed25519 AAAA... comment`, what goes in authorized_keys or a deploy key form. */
	publicKey: string;
	/** `SHA256:...`, as `ssh-keygen -l` prints it. */
	fingerprint: string;
	/** PEM-armoured OpenSSH private key. Encrypt before storing. */
	privateKey: string;
};

const u32 = (n: number) => {
	const b = Buffer.alloc(4);
	b.writeUInt32BE(n);
	return b;
};
const str = (v: Buffer | string) => {
	const b = typeof v === "string" ? Buffer.from(v) : v;
	return Buffer.concat([u32(b.length), b]);
};

class Reader {
	private at = 0;
	constructor(private readonly buf: Buffer) {}
	u32() {
		if (this.at + 4 > this.buf.length) throw new SshKeyError("truncated key");
		const n = this.buf.readUInt32BE(this.at);
		this.at += 4;
		return n;
	}
	bytes() {
		const n = this.u32();
		if (this.at + n > this.buf.length) throw new SshKeyError("truncated key");
		const b = this.buf.subarray(this.at, this.at + n);
		this.at += n;
		return b;
	}
	string() {
		return this.bytes().toString("latin1");
	}
}

export class SshKeyError extends Error {}

const fingerprintOf = (blob: Buffer) =>
	`SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;

const publicLine = (type: string, blob: Buffer, comment: string) =>
	`${type} ${blob.toString("base64")}${comment ? ` ${comment}` : ""}`;

const armor = (body: Buffer) =>
	`${ARMOR_BEGIN}\n${
		body
			.toString("base64")
			.match(/.{1,70}/g)
			?.join("\n") ?? ""
	}\n${ARMOR_END}\n`;

/** A fresh ed25519 key pair; `comment` ends up in the public key line. */
export function generateEd25519(comment: string): SshKeyMaterial {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const pub = Buffer.from(
		publicKey.export({ format: "jwk" }).x ?? "",
		"base64url",
	);
	const seed = Buffer.from(
		privateKey.export({ format: "jwk" }).d ?? "",
		"base64url",
	);
	const blob = Buffer.concat([str("ssh-ed25519"), str(pub)]);
	const check = randomBytes(4);
	let secret = Buffer.concat([
		check,
		check,
		str("ssh-ed25519"),
		str(pub),
		str(Buffer.concat([seed, pub])),
		str(comment),
	]);
	const pad = (8 - (secret.length % 8)) % 8;
	secret = Buffer.concat([
		secret,
		Buffer.from(Array.from({ length: pad }, (_, i) => i + 1)),
	]);
	const body = Buffer.concat([
		MAGIC,
		str("none"),
		str("none"),
		str(""),
		u32(1),
		str(blob),
		str(secret),
	]);
	return {
		publicKey: publicLine("ssh-ed25519", blob, comment),
		fingerprint: fingerprintOf(blob),
		privateKey: armor(body),
	};
}

/** Reads an unencrypted OpenSSH private key of any type; throws `SshKeyError` with a message for the user. */
export function parsePrivateKey(
	pem: string,
	comment: string,
): SshKeyMaterial & { type: string } {
	const text = pem.trim();
	if (!text.startsWith(ARMOR_BEGIN) || !text.endsWith(ARMOR_END))
		throw new SshKeyError(
			"Paste an OpenSSH private key, the block that starts with BEGIN OPENSSH PRIVATE KEY",
		);
	const body = Buffer.from(
		text.slice(ARMOR_BEGIN.length, -ARMOR_END.length).replace(/\s+/g, ""),
		"base64",
	);
	if (!body.subarray(0, MAGIC.length).equals(MAGIC))
		throw new SshKeyError("not an OpenSSH private key");
	const r = new Reader(body.subarray(MAGIC.length));
	const cipher = r.string();
	r.string(); // kdf name
	r.bytes(); // kdf options
	if (cipher !== "none")
		throw new SshKeyError(
			"This key has a passphrase. Remove it with ssh-keygen -p -N '' -f <file>, then import it again",
		);
	if (r.u32() !== 1) throw new SshKeyError("expected exactly one key");
	const blob = Buffer.from(r.bytes());
	const secret = new Reader(r.bytes());
	// Two equal check integers open the private section; they differ when it is garbled.
	const [check1, check2] = [secret.u32(), secret.u32()];
	if (check1 !== check2) throw new SshKeyError("the private key is corrupt");
	const type = new Reader(blob).string();
	if (secret.string() !== type)
		throw new SshKeyError("the private key is corrupt");
	return {
		type,
		publicKey: publicLine(type, blob, comment),
		fingerprint: fingerprintOf(blob),
		privateKey: `${text}\n`,
	};
}

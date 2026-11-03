// MinIO admin payload encryption (madmin `EncryptData`), PBKDF2 + AES-256-GCM variant (id 0x02),
// framed as a sio-go stream: salt(32) | id(1) | nonce(8) | fragments of 16 KiB plaintext, each
// sealed with nonce = nonce8 | seq (uint32 LE), seq from 1. The associated data is a flag byte
// (0x00, 0x80 on the final fragment) plus the tag of an empty seal under seq 0. MinIO and RustFS
// both accept it on /minio/admin/v3.

const PBKDF2_ITERATIONS = 8192;
const FRAGMENT = 16 * 1024;
const PBKDF2_AES_GCM = 0x02;

export async function madminEncrypt(
	password: string,
	plaintext: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
	const salt = crypto.getRandomValues(new Uint8Array(32));
	const nonce8 = crypto.getRandomValues(new Uint8Array(8));
	const base = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
		base,
		256,
	);
	const key = await crypto.subtle.importKey("raw", bits, "AES-GCM", false, [
		"encrypt",
	]);
	const seal = async (
		seq: number,
		data: Uint8Array<ArrayBuffer>,
		ad: Uint8Array<ArrayBuffer>,
	) => {
		const iv = new Uint8Array(12);
		iv.set(nonce8);
		new DataView(iv.buffer).setUint32(8, seq, true);
		return new Uint8Array(
			await crypto.subtle.encrypt(
				{ name: "AES-GCM", iv, additionalData: ad },
				key,
				data,
			),
		);
	};
	const ad = new Uint8Array(17);
	ad.set(await seal(0, new Uint8Array(0), new Uint8Array(0)), 1);
	const out: Uint8Array[] = [salt, new Uint8Array([PBKDF2_AES_GCM]), nonce8];
	let seq = 1;
	let offset = 0;
	// The final fragment may be full, so only strictly more than one fragment's worth is sealed early.
	while (plaintext.length - offset > FRAGMENT) {
		out.push(
			await seal(seq++, plaintext.subarray(offset, offset + FRAGMENT), ad),
		);
		offset += FRAGMENT;
	}
	ad[0] = 0x80;
	out.push(await seal(seq, plaintext.subarray(offset), ad));
	const total = new Uint8Array(out.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of out) {
		total.set(p, at);
		at += p.length;
	}
	return total;
}

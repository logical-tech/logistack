import { expect, test } from "bun:test";
import {
	decryptLaravel,
	isLaravelEncrypted,
	laravelKey,
	openCoolify,
	unserializeString,
} from "../src/migration/coolify/decrypt.ts";

// Made by Coolify 4.5.3's own encrypter (`php -r` in coollabsio/coolify:4.5.3) with this key:
// `encrypt("fake-env-secret")`, `Crypt::encryptString("fake-pg-secret")` and
// `encrypt("line1\nline2 \"quoted\" ü")`.
const APP_KEY = "base64:bG9naXN0YWNrLWNvb2xpZnktdGVzdC1rZXktMzJieXQ=";
const SERIALIZED =
	"eyJpdiI6Ik1QSkpZT2pUKzkxVmoyZmY5bU9UYnc9PSIsInZhbHVlIjoiSFQyTDBDcS9JTU5JdUxnOXBhajZiZVdUd0UrTmIzRlh2TmRTbVIyZ3NrUT0iLCJtYWMiOiI3Zjg0ZTA2ODcxOWFkYWZjYmI3MjMyNzBjMTA0MzU0YTllYTY4Zjk1Mzc5Yzc1NTU1NTJkY2FjN2UwYTdiYWM3IiwidGFnIjoiIn0=";
const RAW =
	"eyJpdiI6IjJQT3NYb0VSMnlndWZDNk12a1VWWkE9PSIsInZhbHVlIjoiTGVHeDBaZkl5SHVDWU11SHZnQ0lndz09IiwibWFjIjoiNmEzZmNkNjZiZThlYjA0OThkNGJhZGIzNGI1NzEzYzk1Nzg2Yjc2N2Y0NGFkYmVmMTBkYWQ4YWY2NjQ3MmRkOCIsInRhZyI6IiJ9";
const MULTILINE =
	"eyJpdiI6ImsvVStvVkgwZ1pEeG9mUUc0TzdlQXc9PSIsInZhbHVlIjoiVkVJYjFRVTMrYU9ZUVppb0FvTWVUcVJ2MTR5Yjd3dnNTUVBlOXVqc3FGMD0iLCJtYWMiOiJmNmMxYjFjZjU1OWM5ZGM5MmY0ZjQwOGVkMzA4MGNiZGRiZWIwN2M0OWZiZjY1NTg2NWYzMTU1YTRlMDBkOTIxIiwidGFnIjoiIn0=";

test("Coolify's env values and cast columns decrypt with its APP_KEY", async () => {
	const keys = [await laravelKey(APP_KEY)];
	expect(isLaravelEncrypted(SERIALIZED)).toBe(true);
	expect(await openCoolify(SERIALIZED, keys, { serialized: true })).toBe(
		"fake-env-secret",
	);
	expect(await openCoolify(RAW, keys)).toBe("fake-pg-secret");
	expect(await openCoolify(MULTILINE, keys, { serialized: true })).toBe(
		'line1\nline2 "quoted" ü',
	);
});

test("a wrong key or a tampered payload never yields a value", async () => {
	const wrong = [
		await laravelKey(`base64:${Buffer.alloc(32, 7).toString("base64")}`),
	];
	expect(await openCoolify(RAW, wrong)).toBeUndefined();
	const p = JSON.parse(Buffer.from(RAW, "base64").toString());
	p.value = Buffer.from("tampered-ciphertext!").toString("base64");
	const tampered = Buffer.from(JSON.stringify(p)).toString("base64");
	await expect(
		decryptLaravel(tampered, [await laravelKey(APP_KEY)]),
	).rejects.toThrow("no key opens it");
});

test("plaintext rows from older releases pass through, serialized ones unwrap", async () => {
	const keys = [await laravelKey(APP_KEY)];
	expect(await openCoolify("plain-old-value", keys)).toBe("plain-old-value");
	expect(await openCoolify('s:5:"hello";', keys, { serialized: true })).toBe(
		"hello",
	);
	expect(unserializeString('s:3:"hello";')).toBe('s:3:"hello";');
	expect(await openCoolify(null, keys)).toBeNull();
	await expect(laravelKey("base64:c2hvcnQ=")).rejects.toThrow("32 bytes");
});

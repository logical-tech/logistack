import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { S3Client } from "bun";
import {
	instantiate,
	notificationChannels,
	ProviderError,
	type S3Destination,
	s3Destination,
	sha256Hex,
	signV4,
} from "../src/index.ts";

// Real servers in containers. Names and the label are this suite's own; cleanup touches only them.
const MINIO = "ls-test-providers-minio";
const MAILPIT = "ls-test-providers-mailpit";
// MinIO stopped publishing Docker Hub/Quay images in 2025; Chainguard builds the same server.
const MINIO_IMAGE =
	"cgr.dev/chainguard/minio@sha256:3c60a2a8c4d33409a9bc7a623a7fcbfb4605adc3d89422d2f53b3f673a6e5597";
const MAILPIT_IMAGE = "axllent/mailpit:v1.27";
const creds = {
	accessKeyId: "lstestaccess",
	secretAccessKey: "lstestsecret123",
};

async function docker(...args: string[]): Promise<string> {
	const p = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	if (code !== 0) throw new Error(`docker ${args[0]}: ${err.trim()}`);
	return out.trim();
}

const dockerUp = await docker(
	"version",
	"--format",
	"{{.Server.Version}}",
).then(
	() => true,
	() => false,
);

async function hostPort(name: string, port: number): Promise<number> {
	const out = await docker("port", name, `${port}/tcp`);
	return Number(out.split("\n")[0]?.split(":").at(-1));
}

async function until(ok: () => Promise<boolean>, what: string) {
	for (let i = 0; i < 100; i++) {
		if (await ok().catch(() => false)) return;
		await Bun.sleep(200);
	}
	throw new Error(`${what} never became ready`);
}

const removeOwn = () =>
	Promise.all(
		[MINIO, MAILPIT].map((n) => docker("rm", "-f", n).catch(() => "")),
	);

describe.skipIf(!dockerUp)("against real servers", () => {
	let s3Endpoint = "";
	let mailApi = "";
	let smtpPort = 0;
	const bucket = "ls-test-providers";
	const prefix = `run-${crypto.randomUUID()}`;
	let dest: S3Destination;

	beforeAll(async () => {
		await removeOwn();
		const label = ["--label", "logistack.test=providers"];
		await docker(
			"run",
			"-d",
			"--name",
			MINIO,
			...label,
			"-e",
			`MINIO_ROOT_USER=${creds.accessKeyId}`,
			"-e",
			`MINIO_ROOT_PASSWORD=${creds.secretAccessKey}`,
			"-p",
			"127.0.0.1::9000",
			MINIO_IMAGE,
			"server",
			"/tmp/data",
		);
		await docker(
			"run",
			"-d",
			"--name",
			MAILPIT,
			...label,
			"-p",
			"127.0.0.1::1025",
			"-p",
			"127.0.0.1::8025",
			MAILPIT_IMAGE,
		);
		s3Endpoint = `http://127.0.0.1:${await hostPort(MINIO, 9000)}`;
		mailApi = `http://127.0.0.1:${await hostPort(MAILPIT, 8025)}`;
		smtpPort = await hostPort(MAILPIT, 1025);
		await until(
			async () => (await fetch(`${s3Endpoint}/minio/health/ready`)).ok,
			"minio",
		);
		await until(async () => (await fetch(`${mailApi}/readyz`)).ok, "mailpit");

		// Creating the bucket with our own SigV4 also checks the signer against a real server.
		const url = `${s3Endpoint}/${bucket}`;
		const headers = { "x-amz-content-sha256": await sha256Hex("") };
		const signed = await signV4(
			{ method: "PUT", url, headers },
			{ credentials: creds, region: "us-east-1", service: "s3" },
		);
		const res = await fetch(url, {
			method: "PUT",
			headers: { ...headers, ...signed },
		});
		expect(res.status).toBe(200);

		dest = instantiate(s3Destination, {
			endpoint: s3Endpoint,
			bucket,
			prefix,
			forcePathStyle: true,
			...creds,
		});
	}, 60_000);

	afterAll(async () => {
		if (dest)
			for (const o of await dest.list().catch(() => []))
				await dest.delete(o.key);
		await removeOwn();
	}, 30_000);

	test("s3 test() probe", async () => {
		await dest.probe();
		expect(await dest.list()).toEqual([]);
	});

	test("s3 streams a multipart upload and reads it back", async () => {
		const chunk = new Uint8Array(1024 * 1024).map((_, i) => i % 251);
		const parts = 40; // 40 MiB spans three 16 MiB parts
		let sent = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(c) {
				if (sent++ < parts) c.enqueue(chunk);
				else c.close();
			},
		});
		await dest.upload("db/backup-1.dump", body, {
			contentType: "application/octet-stream",
		});
		const stat = await new S3Client({ endpoint: s3Endpoint, bucket, ...creds })
			.file(`${prefix}/db/backup-1.dump`)
			.stat();
		// A multipart object's ETag ends in -<part count>.
		expect(stat.etag).toMatch(/-3"?$/);
		expect(stat.type).toBe("application/octet-stream");

		let size = 0;
		let firstByteOk = true;
		for await (const piece of dest.download("db/backup-1.dump")) {
			if (size === 0) firstByteOk = piece[0] === 0 && piece[1] === 1;
			size += piece.byteLength;
		}
		expect(size).toBe(parts * chunk.byteLength);
		expect(firstByteOk).toBe(true);

		const listed = await dest.list("db/");
		expect(listed.map((o) => [o.key, o.size])).toEqual([
			["db/backup-1.dump", parts * chunk.byteLength],
		]);
		expect(listed[0]?.lastModified.getTime()).toBeGreaterThan(
			Date.now() - 60_000,
		);

		await dest.delete("db/backup-1.dump");
		expect(await dest.list("db/")).toEqual([]);
	}, 60_000);

	test("s3 bad credentials surface as ProviderError", async () => {
		const bad = instantiate(s3Destination, {
			endpoint: s3Endpoint,
			bucket,
			forcePathStyle: true,
			accessKeyId: creds.accessKeyId,
			secretAccessKey: "wrong-secret-key",
		});
		const err = await bad.probe().then(
			() => new Error("no error"),
			(e: Error) => e,
		);
		expect(err).toBeInstanceOf(ProviderError);
		expect(err.message).not.toContain("wrong-secret-key");
	});

	test("email over SMTP with nodemailer on Bun", async () => {
		const ch = instantiate(
			notificationChannels.email,
			{
				transport: "smtp",
				host: "127.0.0.1",
				port: smtpPort,
				from: "LogiStack <ls@example.com>",
				to: ["ops@example.com"],
			},
			{ hostPolicy: { allowPrivateHosts: true } },
		);
		await ch.test();
		const inbox = (await (
			await fetch(`${mailApi}/api/v1/messages`)
		).json()) as {
			messages: { Subject: string; To: { Address: string }[] }[];
		};
		expect(inbox.messages[0]?.Subject).toBe(
			"[info] LogiStack test notification",
		);
		expect(inbox.messages[0]?.To[0]?.Address).toBe("ops@example.com");
	});
});

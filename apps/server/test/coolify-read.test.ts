/**
 * The reader against Coolify's real schema and data, per pinned release: Coolify's own image
 * (`coollabsio/coolify:<tag>`) migrates a scratch Postgres and seeds it through Coolify's own
 * models (`fixtures/coolify-seed.php`), so every row is written and encrypted the way Coolify
 * writes it. Nothing of Coolify lands in this repository.
 *
 * Opt-in, it pulls ~1 GB per release: `COOLIFY_TAGS=4.0.0,4.5.3,4.6.0 bun test test/coolify-read.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildCoolifyInventory } from "../src/migration/coolify/inventory.ts";
import { missingColumns, readCoolify } from "../src/migration/coolify/read.ts";
import { hasDocker } from "./harness.ts";

const P = "ls-test-coolread";
const TAGS = (process.env.COOLIFY_TAGS ?? "").split(",").filter(Boolean);
const APP_KEY = `base64:${Buffer.from("ls-test-coolread-app-key-32bytes").toString("base64")}`;

const sh = (argv: string[], stdin?: Blob) => {
	const p = Bun.spawnSync(argv, { stderr: "pipe", stdin: stdin ?? "ignore" });
	if (p.exitCode !== 0)
		throw new Error(
			`${argv.slice(0, 4).join(" ")}: ${p.stderr.toString().slice(-800)}`,
		);
	return p.stdout.toString().trim();
};
const quiet = (argv: string[]) =>
	Bun.spawnSync(argv, { stdout: "ignore", stderr: "ignore" });

test("an older schema is refused with the missing columns named", () => {
	expect(missingColumns([{ table: "applications", column: "id" }])).toContain(
		"applications.uuid",
	);
});

describe.skipIf(!hasDocker || !TAGS.length)(
	"reading Coolify's own database",
	() => {
		let host = "";
		const cleanup = () => {
			quiet(["docker", "rm", "-f", "-v", `${P}-pg`]);
			quiet(["docker", "network", "rm", `${P}-net`]);
		};
		beforeAll(async () => {
			cleanup();
			sh([
				"docker",
				"network",
				"create",
				"--label",
				"logistack.test=coolread",
				`${P}-net`,
			]);
			sh([
				"docker",
				"run",
				"-d",
				"--name",
				`${P}-pg`,
				"--network",
				`${P}-net`,
				"--label",
				"logistack.test=coolread",
				"-e",
				"POSTGRES_PASSWORD=test",
				"-p",
				"127.0.0.1::5432",
				"postgres:16-alpine",
			]);
			host = sh(["docker", "port", `${P}-pg`, "5432/tcp"]).split(
				"\n",
			)[0] as string;
			for (let i = 0; ; i++) {
				const sql = new Bun.SQL(`postgres://postgres:test@${host}/postgres`, {
					max: 1,
				});
				try {
					await sql`select 1`;
					break;
				} catch (e) {
					if (i > 100) throw e;
					await Bun.sleep(200);
				} finally {
					await sql.close();
				}
			}
		}, 60_000);
		afterAll(cleanup);

		for (const tag of TAGS)
			test(`Coolify ${tag}: migrated and seeded by Coolify, read and planned by LogiStack`, async () => {
				const db = `coolify_${tag.replaceAll(".", "_")}`;
				const admin = new Bun.SQL(`postgres://postgres:test@${host}/postgres`, {
					max: 1,
				});
				await admin.unsafe(`drop database if exists "${db}"`);
				await admin.unsafe(`create database "${db}"`);
				await admin.close();
				sh(
					[
						"docker",
						"run",
						"--rm",
						"-i",
						"--network",
						`${P}-net`,
						"--label",
						"logistack.test=coolread",
						"-e",
						`APP_KEY=${APP_KEY}`,
						"-e",
						"APP_ENV=production",
						"-e",
						"DB_CONNECTION=pgsql",
						"-e",
						`DB_HOST=${P}-pg`,
						"-e",
						`DB_DATABASE=${db}`,
						"-e",
						"DB_USERNAME=postgres",
						"-e",
						"DB_PASSWORD=test",
						"--entrypoint",
						"sh",
						`coollabsio/coolify:${tag}`,
						"-c",
						"php artisan migrate --force >/dev/null && php",
					],
					Bun.file(join(import.meta.dir, "fixtures", "coolify-seed.php")),
				);
				const s = await readCoolify(`postgres://postgres:test@${host}/${db}`, {
					appKey: APP_KEY,
				});
				expect(s.undecryptable).toEqual([]);
				expect(s.databases[0]).toMatchObject({
					uuid: "pgk8s0wc8gw4o0c4ws0ok",
					password: "fake-coolify-pg-secret",
				});
				expect(s.s3[0]).toMatchObject({
					key: "fake-s3-access",
					secret: "fake-s3-secret",
				});
				expect(s.privateKeys[0]?.private_key).toContain("fake-coolify-ssh-key");
				expect(s.githubApps[0]?.webhook_secret).toBe("fake-gh-webhook-secret");
				expect(
					s.envs.find((e) => e.key === "DATABASE_URL" && !e.is_preview)?.value,
				).toContain("@pgk8s0wc8gw4o0c4ws0ok:5432/shop");
				const inv = buildCoolifyInventory(s);
				expect(inv.items.map((i) => [i.kind, i.name, i.status])).toEqual([
					["postgres", "shop-db", "full"],
					["application", "shop-web", "full"],
					["service", "blog", "full"],
				]);
				expect(inv.org.map((o) => [o.kind, o.status])).toEqual([
					["s3Destination", "full"],
					["gitProvider", "full"],
					["notificationChannel", "partial"],
				]);
				expect(inv.items[1]?.services[0]?.env).toContainEqual({
					key: "REGION",
					value: "eu-west",
					isSecret: true,
				});
			}, 600_000);
	},
);

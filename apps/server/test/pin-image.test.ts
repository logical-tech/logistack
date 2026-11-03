import { expect, test } from "bun:test";
import { pinImage, type RunningImage } from "../scripts/import-dokploy.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;
const factorio: RunningImage = {
	repoDigests: [`factoriotools/factorio@${DIGEST}`],
	env: ["PATH=/usr/bin", "VERSION=2.0.77"],
	labels: { "org.opencontainers.image.version": "2.0.76" },
};
const exists =
	(...tags: string[]) =>
	async (ref: string) =>
		tags.includes(ref);

test("a VERSION env naming an existing tag wins", async () => {
	expect(
		await pinImage(
			"factoriotools/factorio:stable",
			factorio,
			exists("factoriotools/factorio:2.0.77"),
		),
	).toEqual({
		image: "factoriotools/factorio:2.0.77",
		why: "VERSION env of the running image",
	});
});

test("the OCI version label is next, then the repo digest", async () => {
	expect(
		(
			await pinImage(
				"factoriotools/factorio:stable",
				factorio,
				exists("factoriotools/factorio:2.0.76"),
			)
		)?.image,
	).toBe("factoriotools/factorio:2.0.76");
	expect(
		(await pinImage("factoriotools/factorio:stable", factorio, exists()))
			?.image,
	).toBe(`factoriotools/factorio@${DIGEST}`);
});

test("the digest matches the compose repository however Docker Hub is spelled", async () => {
	const img = { repoDigests: [`nginx@${DIGEST}`], env: [], labels: {} };
	expect(
		(await pinImage("docker.io/library/nginx:latest", img, exists()))?.image,
	).toBe(`docker.io/library/nginx@${DIGEST}`);
	expect(
		(
			await pinImage(
				"registry.example.com:5000/team/app:main",
				{
					...img,
					repoDigests: [`registry.example.com:5000/team/app@${DIGEST}`],
				},
				exists(),
			)
		)?.image,
	).toBe(`registry.example.com:5000/team/app@${DIGEST}`);
});

test("nothing to pin: a digest ref, a local build, or a version that is not a tag", async () => {
	expect(await pinImage(`nginx@${DIGEST}`, factorio, exists())).toBeUndefined();
	expect(
		await pinImage(
			"app:dev",
			{ repoDigests: [], env: ["VERSION=1.0"], labels: {} },
			exists(),
		),
	).toBeUndefined();
	const tagExists = async (ref: string) => {
		throw new Error(`asked about ${ref}`);
	};
	expect(
		await pinImage(
			"app:dev",
			{ repoDigests: [], env: ["VERSION=not a tag"], labels: {} },
			tagExists,
		),
	).toBeUndefined();
});

import { describe, expect, test } from "bun:test";
import {
	type BuildConfig,
	BuildConfig as BuildConfigSchema,
} from "@logistack/contracts";
import {
	missingPlatforms,
	platformsOfArchs,
	resolveBuildPlatforms,
} from "../src/build-platforms.ts";

const dockerfile = (
	platforms?: ("linux/amd64" | "linux/arm64")[],
): BuildConfig => ({
	type: "dockerfile",
	dockerfilePath: "Dockerfile",
	context: ".",
	...(platforms ? { platforms } : {}),
});

describe("platformsOfArchs", () => {
	test("maps uname and Go names, sorted and deduplicated; unknown ones are dropped", () => {
		expect(platformsOfArchs(["aarch64", "x86_64", "amd64", "riscv64"])).toEqual(
			["linux/amd64", "linux/arm64"],
		);
		expect(platformsOfArchs([])).toEqual([]);
	});
});

describe("missingPlatforms", () => {
	test("variants count as their platform", () => {
		expect(missingPlatforms(["linux/arm64/v8"])).toEqual(["linux/amd64"]);
		expect(missingPlatforms(["linux/arm64", "linux/amd64"])).toEqual([]);
	});
});

describe("resolveBuildPlatforms", () => {
	const native = "linux/arm64" as const;
	test("automatic: every architecture of the swarm", () => {
		expect(
			resolveBuildPlatforms({
				build: dockerfile(),
				swarm: ["linux/amd64", "linux/arm64"],
				native,
			}),
		).toEqual(["linux/amd64", "linux/arm64"]);
		expect(
			resolveBuildPlatforms({ build: dockerfile(), swarm: [], native }),
		).toEqual([native]);
	});
	test("an explicit choice wins over the swarm", () => {
		expect(
			resolveBuildPlatforms({
				build: dockerfile(["linux/arm64", "linux/amd64"]),
				swarm: ["linux/amd64"],
				native,
			}),
		).toEqual(["linux/amd64", "linux/arm64"]);
	});
	test("railpack on a mixed swarm builds the native platform only", () => {
		expect(
			resolveBuildPlatforms({
				build: { type: "railpack" },
				swarm: ["linux/amd64", "linux/arm64"],
				native,
			}),
		).toEqual([native]);
		expect(
			resolveBuildPlatforms({
				build: { type: "railpack" },
				swarm: ["linux/amd64"],
				native,
			}),
		).toEqual(["linux/amd64"]);
	});
});

describe("BuildConfig platforms", () => {
	test("railpack takes one platform, a Dockerfile both; no duplicates", () => {
		const ok = (b: unknown) => BuildConfigSchema.safeParse(b).success;
		expect(ok({ type: "railpack", platforms: ["linux/arm64"] })).toBe(true);
		expect(
			ok({ type: "railpack", platforms: ["linux/amd64", "linux/arm64"] }),
		).toBe(false);
		expect(ok(dockerfile(["linux/amd64", "linux/arm64"]))).toBe(true);
		expect(ok(dockerfile(["linux/amd64", "linux/amd64"]))).toBe(false);
		expect(ok({ ...dockerfile(), platforms: [] })).toBe(false);
	});
});

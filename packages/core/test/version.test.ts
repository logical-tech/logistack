import { expect, test } from "bun:test";
import {
	compareVersions,
	isReleaseVersion,
	normalizeVersion,
} from "../src/version.ts";

test("compareVersions follows semver precedence", () => {
	const ordered = [
		"dev",
		"0.9.0",
		"0.10.0",
		"1.0.0-alpha",
		"1.0.0-alpha.1",
		"1.0.0-alpha.beta",
		"1.0.0-beta.2",
		"1.0.0-beta.11",
		"1.0.0-rc.1",
		"1.0.0",
		"v1.0.1",
		"1.1.0",
		"2.0.0",
	];
	for (let i = 0; i < ordered.length; i++)
		for (let j = 0; j < ordered.length; j++)
			expect(
				Math.sign(compareVersions(ordered[i] ?? "", ordered[j] ?? "")),
			).toBe(Math.sign(i - j));
	expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
	expect(compareVersions("dev", "unknown")).toBe(0);
});

test("release versions and tags", () => {
	expect(isReleaseVersion("v0.2.0")).toBe(true);
	expect(isReleaseVersion("0.2.0-rc.1")).toBe(true);
	expect(isReleaseVersion("latest")).toBe(false);
	expect(isReleaseVersion("0.2")).toBe(false);
	expect(normalizeVersion("v0.2.0")).toBe("0.2.0");
	expect(normalizeVersion("0.2.0")).toBe("0.2.0");
	expect(normalizeVersion("vnext")).toBe("vnext");
});

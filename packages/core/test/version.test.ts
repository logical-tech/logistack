import { expect, test } from "bun:test";
import {
	breakingChanges,
	compareVersions,
	isReleaseVersion,
	normalizeVersion,
	onChannel,
	releasesBetween,
	versionChannel,
	withoutBreakingChanges,
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

test("versionChannel and onChannel sort builds into stable, beta and nightly", () => {
	expect(versionChannel("0.5.0")).toBe("stable");
	expect(versionChannel("v0.5.1-beta.12")).toBe("beta");
	expect(versionChannel("0.5.1-rc.1")).toBe("beta");
	expect(versionChannel("0.5.1-nightly.40")).toBe("nightly");
	expect(onChannel("0.5.0", "stable")).toBe(true);
	expect(onChannel("0.5.1-beta.12", "stable")).toBe(false);
	expect(onChannel("0.5.1-beta.12", "beta")).toBe(true);
	expect(onChannel("0.5.1-nightly.40", "beta")).toBe(false);
	expect(onChannel("0.5.1-nightly.40", "nightly")).toBe(true);
	expect(onChannel("0.5.0", "nightly")).toBe(true);
	expect(onChannel("nightly", "nightly")).toBe(false);
});

test("breakingChanges returns the section release-notes.sh writes first", () => {
	const notes =
		"## Breaking changes\n\n- **server:** drop /api/v0 (abc1234)\n\n## Features\n\n- **web:** x (def5678)\n";
	expect(breakingChanges(notes)).toBe("- **server:** drop /api/v0 (abc1234)");
	expect(breakingChanges("## Breaking changes\n\n- last section\n")).toBe(
		"- last section",
	);
	expect(breakingChanges("## Features\n\n- **web:** x\n")).toBeNull();
	expect(breakingChanges("## Breaking changes\n\n## Features\n- x")).toBeNull();
	expect(withoutBreakingChanges(notes)).toBe(
		"## Features\n\n- **web:** x (def5678)",
	);
});

test("releasesBetween keeps stable releases on the way and the target itself", () => {
	const v = (...xs: string[]) => xs.map((version) => ({ version }));
	const all = v(
		"0.6.0-nightly.90",
		"0.5.1-beta.3",
		"0.5.0",
		"0.5.0-beta.9",
		"0.4.2",
		"0.4.1",
		"0.4.0",
	);
	expect(releasesBetween(all, "0.4.0", "0.5.0").map((r) => r.version)).toEqual([
		"0.5.0",
		"0.4.2",
		"0.4.1",
	]);
	expect(
		releasesBetween(all, "0.4.1", "0.5.1-beta.3").map((r) => r.version),
	).toEqual(["0.5.1-beta.3", "0.5.0", "0.4.2"]);
	expect(releasesBetween(all, "0.5.0", "0.5.0")).toEqual([]);
});

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskUsage } from "@logistack/contracts";
import { createDockerClient, type SystemDf } from "@logistack/docker";
import { containerLogs, diskUsage, summarizeDf } from "../src/disk.ts";

const df: SystemDf = {
	LayersSize: 1000,
	Images: [
		{
			Id: "a",
			RepoTags: null,
			Created: 0,
			Size: 600,
			SharedSize: 100,
			Containers: 1,
			Labels: null,
		},
		{
			Id: "b",
			RepoTags: null,
			Created: 0,
			Size: 300,
			SharedSize: 100,
			Containers: 0,
			Labels: null,
		},
		{
			Id: "c",
			RepoTags: null,
			Created: 0,
			Size: 50,
			SharedSize: -1,
			Containers: 0,
			Labels: null,
		},
	],
	Containers: [
		{
			Id: "1",
			Names: [],
			Image: "a",
			State: "running",
			SizeRw: 10,
			Labels: null,
		},
		{
			Id: "2",
			Names: [],
			Image: "a",
			State: "exited",
			SizeRw: 20,
			Labels: null,
		},
	],
	Volumes: [
		{
			Name: "small",
			Driver: "local",
			Mountpoint: "",
			Labels: null,
			Scope: "local",
			Options: null,
			UsageData: { Size: 5, RefCount: 1 },
		},
		{
			Name: "big",
			Driver: "local",
			Mountpoint: "",
			Labels: { "logistack.resource": "svc_1" },
			Scope: "local",
			Options: null,
			UsageData: { Size: 500, RefCount: 0 },
		},
		{
			Name: "unmeasured",
			Driver: "local",
			Mountpoint: "",
			Labels: null,
			Scope: "local",
			Options: null,
			UsageData: { Size: -1, RefCount: -1 },
		},
	],
	BuildCache: [
		{
			ID: "x",
			Type: "regular",
			InUse: false,
			Shared: false,
			Size: 70,
			LastUsedAt: null,
		},
		{
			ID: "y",
			Type: "regular",
			InUse: true,
			Shared: false,
			Size: 30,
			LastUsedAt: null,
		},
		{
			ID: "z",
			Type: "regular",
			InUse: false,
			Shared: true,
			Size: 999,
			LastUsedAt: null,
		},
	],
};

describe("disk usage", () => {
	test("summarizes df: unique bytes of unused images, stopped containers, unshared cache", () => {
		const u = summarizeDf(df, {
			at: 1,
			dockerRootDir: "/var/lib/docker",
			filesystem: null,
			logs: null,
		});
		expect(DiskUsage.parse(u)).toEqual(u);
		expect(u.images).toEqual({ count: 3, bytes: 1000, reclaimableBytes: 250 });
		expect(u.containers).toEqual({ count: 2, bytes: 30, reclaimableBytes: 20 });
		expect(u.volumes).toEqual({ count: 3, bytes: 505, reclaimableBytes: 0 });
		expect(u.buildCache).toEqual({
			count: 2,
			bytes: 100,
			reclaimableBytes: 70,
		});
		expect(u.topVolumes.map((v) => [v.name, v.inUse, v.resourceId])).toEqual([
			["big", false, "svc_1"],
			["small", true, undefined],
			["unmeasured", false, undefined],
		]);
	});

	test("counts current and rotated json logs only", () => {
		const dir = mkdtempSync(join(tmpdir(), "ls-disk-"));
		mkdirSync(join(dir, "abc"));
		writeFileSync(join(dir, "abc", "abc-json.log"), "x".repeat(10));
		writeFileSync(join(dir, "abc", "abc-json.log.1"), "x".repeat(5));
		writeFileSync(join(dir, "abc", "config.v2.json"), "x".repeat(99));
		expect(containerLogs(dir)).toEqual({
			count: 2,
			bytes: 15,
			reclaimableBytes: 0,
		});
		expect(containerLogs(join(dir, "missing"))).toBeNull();
	});

	// Read-only against the dev machine's engine: df never changes anything.
	test.skipIf(!process.env.LS_DOCKER_TESTS)(
		"reads the local engine",
		async () => {
			const u = await diskUsage(createDockerClient(), "/");
			expect(DiskUsage.parse(u).dockerRootDir).toBeTruthy();
		},
		60_000,
	);
});

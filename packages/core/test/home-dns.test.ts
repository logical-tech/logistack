import { expect, test } from "bun:test";
import type { HomeDnsStatus } from "@logistack/contracts";
import {
	advanceHomeDns,
	type HomeDnsEvent,
	homeDnsAlert,
} from "../src/home-dns.ts";

const run = (from: HomeDnsStatus, ...events: HomeDnsEvent[]) =>
	events.reduce(advanceHomeDns, from);

test("a first start walks starting, configuring, ready", () => {
	expect(run("starting", "deployed")).toBe("starting");
	expect(run("starting", "deployed", "api_up")).toBe("configuring");
	expect(run("starting", "deployed", "api_up", "configured")).toBe("ready");
	expect(run("starting", "api_up", "configured", "api_up", "configured")).toBe(
		"ready",
	);
});

test("a redeploy of a ready service starts over without passing through error", () => {
	expect(run("ready", "deployed")).toBe("starting");
	expect(run("ready", "deployed", "api_up", "configured")).toBe("ready");
});

test("error is left only by a full success or a stop", () => {
	expect(run("error", "deployed")).toBe("error");
	expect(run("error", "api_up")).toBe("error");
	expect(run("error", "api_up", "configured")).toBe("ready");
	expect(run("error", "stop")).toBe("stopped");
	for (const s of ["starting", "configuring", "ready"] as const)
		expect(run(s, "fail")).toBe("error");
});

test("stopped only restarts on a deploy", () => {
	expect(run("stopped", "api_up", "configured", "fail")).toBe("stopped");
	expect(run("stopped", "deployed")).toBe("starting");
});

test("alerts fire entering error and resolve leaving it", () => {
	expect(homeDnsAlert("ready", "error")).toBe("firing");
	expect(homeDnsAlert("starting", "error")).toBe("firing");
	expect(homeDnsAlert("error", "error")).toBeNull();
	expect(homeDnsAlert("error", "ready")).toBe("resolved");
	expect(homeDnsAlert("error", "stopped")).toBe("resolved");
	expect(homeDnsAlert("starting", "ready")).toBeNull();
});

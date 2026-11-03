import { expect, test } from "bun:test";
import { projectHealth } from "./status";

test("a project reads as its most urgent service", () => {
	expect(projectHealth(["running", "failed", "unhealthy"])).toEqual({
		kind: "status",
		status: "failed",
		running: 1,
		total: 3,
	});
	expect(projectHealth(["running", "starting"])).toMatchObject({
		status: "starting",
	});
	expect(projectHealth(["running", "running"])).toMatchObject({
		status: "running",
		running: 2,
	});
});

test("stopped only wins when nothing else is present", () => {
	expect(projectHealth(["stopped", "running"])).toMatchObject({
		status: "running",
	});
	expect(projectHealth(["stopped", "stopped"])).toMatchObject({
		status: "stopped",
	});
});

test("a project without services is empty, not unknown", () => {
	expect(projectHealth([])).toEqual({ kind: "empty" });
});

import { describe, expect, test } from "bun:test";
import type { ChecksSummary } from "@logistack/providers";
import { checksVerdict, NO_CHECKS_GRACE_MS } from "../src/checks.ts";

const MIN = 60_000;
const timeout = 30 * MIN;
const pending: ChecksSummary = {
	state: "pending",
	failed: [],
	pending: ["build", "e2e"],
};

describe("checksVerdict", () => {
	test("green checks queue the deployment", () => {
		expect(
			checksVerdict(
				{ state: "success", failed: [], pending: [] },
				MIN,
				timeout,
			),
		).toEqual({ event: "checks_passed" });
	});

	test("a failed check skips at once, naming it", () => {
		expect(
			checksVerdict(
				{ state: "failure", failed: ["test"], pending: ["e2e"] },
				MIN,
				timeout,
			),
		).toEqual({ event: "skip", reason: "Checks failed: test" });
	});

	test("pending checks wait until the timeout, then skip", () => {
		expect(checksVerdict(pending, timeout - 1, timeout)).toEqual({
			wait: "Waiting on build, e2e",
		});
		expect(checksVerdict(pending, timeout, timeout)).toEqual({
			event: "skip",
			reason: "Checks still running after 30 min: build, e2e",
		});
	});

	test("no checks at all wait out a grace period, then deploy", () => {
		const none: ChecksSummary = { state: "none", failed: [], pending: [] };
		expect(checksVerdict(none, NO_CHECKS_GRACE_MS - 1, timeout)).toEqual({
			wait: "Waiting for checks to start",
		});
		expect(checksVerdict(none, NO_CHECKS_GRACE_MS, timeout)).toEqual({
			event: "checks_passed",
		});
		expect(checksVerdict(none, MIN, MIN)).toEqual({ event: "checks_passed" });
	});

	test("an unreadable provider keeps waiting, and the timeout reports why", () => {
		const read = { error: "github checkRuns: HTTP 403" };
		expect(checksVerdict(read, MIN, timeout)).toEqual({
			wait: "Could not read checks yet: github checkRuns: HTTP 403",
		});
		expect(checksVerdict(read, timeout, timeout)).toEqual({
			event: "skip",
			reason: "Could not read checks: github checkRuns: HTTP 403",
		});
	});
});

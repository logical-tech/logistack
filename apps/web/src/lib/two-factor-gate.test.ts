import { beforeEach, describe, expect, test } from "bun:test";
import { ENROL_PATH, shouldEnrol } from "./two-factor-gate";

const store = new Map<string, string>();
globalThis.sessionStorage = {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, v),
} as Storage;

const deadline = "2026-12-01T00:00:00.000Z";

describe("shouldEnrol", () => {
	beforeEach(() => store.clear());

	test("nothing required, never", () => {
		expect(shouldEnrol({ twoFactor: null }, "/")).toBe(false);
	});

	test("blocked, every time, except on the enrolment page", () => {
		const me = { twoFactor: { kind: "blocked" as const, deadline } };
		expect(shouldEnrol(me, "/")).toBe(true);
		expect(shouldEnrol(me, "/projects")).toBe(true);
		expect(shouldEnrol(me, ENROL_PATH)).toBe(false);
	});

	test("in the grace period, once per browser session", () => {
		const me = { twoFactor: { kind: "enroll_prompt" as const, deadline } };
		expect(shouldEnrol(me, "/")).toBe(true);
		expect(shouldEnrol(me, "/")).toBe(false);
	});
});

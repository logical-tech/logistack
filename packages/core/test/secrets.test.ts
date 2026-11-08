import { expect, test } from "bun:test";
import {
	interpolateSecrets,
	markShadowed,
	secretChain,
	secretExpressions,
	secretInChain,
	secretMasker,
} from "../src/secrets.ts";

const svc = {
	type: "service",
	organizationId: "org",
	folderIds: ["f1", "f2"],
	projectId: "p",
	environmentId: "e",
	serviceId: "s",
};

test("the chain runs organization, folders outermost first, project, environment, service", () => {
	expect(secretChain(svc)).toEqual([
		["organization", "org"],
		["folder", "f1"],
		["folder", "f2"],
		["project", "p"],
		["environment", "e"],
		["service", "s"],
	]);
});

test("only ancestors are visible", () => {
	expect(secretInChain({ scope: "folder", scopeId: "f2" }, svc)).toBe(true);
	expect(secretInChain({ scope: "project", scopeId: "other" }, svc)).toBe(
		false,
	);
	expect(secretInChain({ scope: "service", scopeId: "s2" }, svc)).toBe(false);
	expect(
		secretInChain(
			{ scope: "environment", scopeId: "e" },
			{
				...svc,
				type: "project",
				environmentId: undefined,
				serviceId: undefined,
			},
		),
	).toBe(false);
});

test("the most specific definition of a key shadows the others", () => {
	const out = markShadowed(
		[
			{ scope: "organization", scopeId: "org", key: "A" },
			{ scope: "folder", scopeId: "f2", key: "A" },
			{ scope: "folder", scopeId: "f1", key: "A" },
			{ scope: "project", scopeId: "p", key: "B" },
		] as const,
		secretChain(svc),
	);
	expect(out.map((s) => s.shadowed)).toEqual([true, false, true, false]);
});

test("the masker hides secret values and their base64 form", () => {
	const mask = secretMasker(["hunter22", "abc"]);
	expect(mask("pw=hunter22 b64=aHVudGVyMjI= short=abc")).toBe(
		"pw=*** b64=*** short=abc",
	);
	expect(secretMasker([])("x")).toBe("x");
});

test("interpolates ${{ secrets.KEY }} and reports unknown keys", () => {
	const lookup = (k: string) => ({ PG: "p@ss", HOST: "db" })[k];
	expect(
		interpolateSecrets(
			"postgres://app:${{ secrets.PG }}@${{secrets.HOST}}/app?x=${{ secrets.NOPE }}&${{ secrets.PG }}",
			lookup,
		),
	).toEqual({
		value: "postgres://app:p@ss@db/app?x=${{ secrets.NOPE }}&p@ss",
		used: ["PG", "HOST"],
		missing: ["NOPE"],
	});
	expect(interpolateSecrets("plain $HOME ${{ inputs.x }}", lookup)).toEqual({
		value: "plain $HOME ${{ inputs.x }}",
		used: [],
		missing: [],
	});
	expect(
		secretExpressions("${{ secrets.A }}${{ secrets.B }}${{ secrets.A }}"),
	).toEqual(["A", "B"]);
});

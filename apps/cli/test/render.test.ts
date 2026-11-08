import { expect, test } from "bun:test";
import { renderChanges } from "../src/render.ts";

test("renders a plan with a summary, and no changes plainly", () => {
	expect(renderChanges([])).toBe("No changes.");
	expect(
		renderChanges([
			{
				op: "create",
				resource: "service",
				environment: "prod",
				name: "web",
				changes: ["new application"],
			},
			{
				op: "update",
				resource: "variable",
				environment: "prod",
				service: "web",
				name: "A",
				changes: ["value changed"],
			},
			{
				op: "delete",
				resource: "domain",
				environment: "prod",
				service: "web",
				name: "old.example.com",
				changes: ["removed"],
			},
		]),
	).toBe(
		[
			"+ service prod/web",
			"    new application",
			"~ variable prod/web/A",
			"    value changed",
			"- domain prod/web/old.example.com",
			"    removed",
			"",
			"1 to create, 1 to change, 1 to delete.",
		].join("\n"),
	);
});

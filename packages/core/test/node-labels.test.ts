import { expect, test } from "bun:test";
import { nodeLabels } from "../src/node-labels.ts";

test("user labels come from desired, installer labels from Swarm", () => {
	expect(
		nodeLabels(
			{ region: "eu", "logistack.ingress": "pending" },
			{ "logistack.ingress": "true", "logistack.data": "true", stale: "x" },
		),
	).toEqual({
		region: "eu",
		"logistack.ingress": "true",
		"logistack.data": "true",
	});
});

test("an installer label Swarm lacks is dropped, never invented", () => {
	expect(nodeLabels({ "logistack.data": "true" }, {})).toEqual({});
});

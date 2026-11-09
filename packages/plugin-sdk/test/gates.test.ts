import { expect, test } from "bun:test";
import { PLUGIN_HEADERS } from "@logistack/contracts";
import { createPlugin, defineManifest, sign } from "../src/index.ts";

test("gates.deploy answers signed POST /v1/gates/deploy and refuses unsigned ones", async () => {
	const app = createPlugin({
		manifest: defineManifest({
			id: "dev.test.gate",
			version: "1.0.0",
			name: "Gate",
			contributes: { gates: { deploy: true } },
		}),
		env: { LOGISTACK_SIGNING_SECRET: "s" },
		gates: {
			deploy: (r) =>
				r.environment.kind === "production"
					? { allow: false, reason: "frozen" }
					: { allow: true },
		},
	});
	const body = JSON.stringify({ environment: { kind: "production" } });
	const ts = Math.floor(Date.now() / 1000);
	const res = await app.request("/v1/gates/deploy", {
		method: "POST",
		body,
		headers: {
			"content-type": "application/json",
			[PLUGIN_HEADERS.timestamp]: String(ts),
			[PLUGIN_HEADERS.signatureV2]: await sign(
				"s",
				ts,
				{ method: "POST", path: "/v1/gates/deploy" },
				body,
			),
		},
	});
	expect(await res.json()).toEqual({ allow: false, reason: "frozen" });
	// A signature for another route does not replay here.
	const replayed = await app.request("/v1/gates/deploy", {
		method: "POST",
		body,
		headers: {
			"content-type": "application/json",
			[PLUGIN_HEADERS.timestamp]: String(ts),
			[PLUGIN_HEADERS.signatureV2]: await sign(
				"s",
				ts,
				{ method: "POST", path: "/v1/events" },
				body,
			),
		},
	});
	expect(replayed.status).toBe(401);
	const unsigned = await app.request("/v1/gates/deploy", {
		method: "POST",
		body,
	});
	expect(unsigned.status).toBe(401);
});

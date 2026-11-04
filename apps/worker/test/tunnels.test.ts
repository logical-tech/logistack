import { expect, test } from "bun:test";
import { compileCloudflared } from "../src/tunnels.ts";

const input = {
	name: "ls-cft-abc",
	image: "cloudflare/cloudflared:2026.10.7",
	token: "secret-token",
	network: "ls-ingress",
	labels: { "logistack.managed": "true" },
};

test("cloudflared keeps its token out of argv and hashes its spec", () => {
	const spec = compileCloudflared(input);
	const c = spec.TaskTemplate.ContainerSpec;
	expect(c?.Args).toEqual(["tunnel", "--no-autoupdate", "run"]);
	expect(c?.Env).toEqual(["TUNNEL_TOKEN=secret-token"]);
	expect(spec.Labels?.["logistack.spec-hash"]).toBe(
		compileCloudflared(input).Labels?.["logistack.spec-hash"],
	);
	expect(spec.Labels?.["logistack.spec-hash"]).not.toBe(
		compileCloudflared({ ...input, token: "rotated" }).Labels?.[
			"logistack.spec-hash"
		],
	);
});

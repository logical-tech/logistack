import { expect, test } from "bun:test";
import {
	compileTailscaleNode,
	compileTailscalePublisher,
	serveConfig,
} from "../src/tailscale.ts";

const labels = { "logistack.managed": "true", "logistack.tailscale": "true" };
const node = {
	name: "ls-tsn-abc",
	image: "tailscale/tailscale:v1.104.4",
	authKey: "tskey-auth-secret",
	labels,
};
const publisher = {
	...node,
	name: "ls-tsp-abc",
	hostname: "grafana",
	network: "ls-env-abc",
	config: { id: "cfg123", name: "ls-tsp-abc-0123456789" },
};

test("tailscaled runs on every node's host network with the key in env only", () => {
	const spec = compileTailscaleNode(node);
	expect(spec).toMatchSnapshot();
	expect(spec.Mode).toEqual({ Global: {} });
	expect(spec.TaskTemplate.ContainerSpec?.Args).toBeUndefined();
	expect(spec.Labels?.["logistack.spec-hash"]).not.toBe(
		compileTailscaleNode({ ...node, authKey: "tskey-auth-rotated" }).Labels?.[
			"logistack.spec-hash"
		],
	);
});

test("a publisher serves its config next to the service", () => {
	expect(compileTailscalePublisher(publisher)).toMatchSnapshot();
});

test("serve config proxies HTTPS with a tailnet cert, or plain HTTP", () => {
	expect(JSON.parse(serveConfig("http://ls-svc-x:3000", true))).toEqual({
		TCP: { "443": { HTTPS: true } },
		Web: {
			"${TS_CERT_DOMAIN}:443": {
				Handlers: { "/": { Proxy: "http://ls-svc-x:3000" } },
			},
		},
	});
	expect(JSON.parse(serveConfig("http://ls-svc-x:3000", false))).toEqual({
		TCP: { "80": { HTTP: true } },
		Web: {
			"${TS_CERT_DOMAIN}:80": {
				Handlers: { "/": { Proxy: "http://ls-svc-x:3000" } },
			},
		},
	});
});

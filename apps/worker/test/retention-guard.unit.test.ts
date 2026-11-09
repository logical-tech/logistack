import { describe, expect, test } from "bun:test";
import { BlockedHostError, pinnedFetch } from "@logistack/providers";
import { registryApi } from "../src/retention.ts";

const creds = { username: "u", password: "p" };

describe("registryApi through the SSRF guard", () => {
	test("a registry on a private address is refused before connecting", async () => {
		const api = registryApi(
			"https://127.0.0.1:5000/v2",
			creds,
			pinnedFetch({ allowPrivateHosts: false }),
		);
		await expect(api("/x/tags/list", {}, "s")).rejects.toBeInstanceOf(
			BlockedHostError,
		);
	});

	test("a token realm on the control network is refused, even with private hosts allowed", async () => {
		const guarded = pinnedFetch({ allowPrivateHosts: true });
		const realms: string[] = [];
		const api = registryApi("https://reg.example/v2", creds, (url, init) => {
			if (url.startsWith("https://reg.example/"))
				return Promise.resolve(
					new Response(null, {
						status: 401,
						headers: {
							"www-authenticate":
								'Bearer realm="https://10.247.0.4:2019/config/"',
						},
					}),
				);
			realms.push(url);
			return guarded(url, init);
		});
		await expect(api("/x/tags/list", {}, "s")).rejects.toThrow(
			"control network",
		);
		expect(realms).toHaveLength(1);
	});
});

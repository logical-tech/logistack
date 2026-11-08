import { z } from "zod";
import { defineProvider, Http, secret } from "../http.ts";
import { memo, type SecretSource, trimUrl } from "./types.ts";

export const infisicalConfig = z.object({
	url: z.url().default("https://app.infisical.com"),
	/** A machine identity with Universal Auth. */
	clientId: z.string().min(1),
	clientSecret: secret(),
	projectId: z.string().min(1),
});

/** Infisical. References read `<environment>[/<folder>...]#<secret name>`. */
export const infisical = defineProvider({
	configSchema: infisicalConfig,
	create(config, deps): SecretSource {
		const http = new Http("infisical", deps);
		const base = trimUrl(config.url);
		const token = memo(async () => {
			const r = await http.json<{ accessToken: string }>(
				"login",
				`${base}/api/v1/auth/universal-auth/login`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						clientId: config.clientId,
						clientSecret: config.clientSecret,
					}),
				},
			);
			return r.accessToken;
		});
		const auth = async () => ({
			authorization: `Bearer ${await token("")}`,
		});
		return {
			async test() {
				await http.request(
					"test",
					`${base}/api/v1/workspace/${encodeURIComponent(config.projectId)}`,
					{ headers: await auth() },
				);
			},
			async read([environment, ...folders], key) {
				const q = new URLSearchParams({
					workspaceId: config.projectId,
					environment: environment ?? "",
					secretPath: `/${folders.join("/")}`,
				});
				const r = await http.json<{ secret: { secretValue: string } }>(
					"read",
					`${base}/api/v3/secrets/raw/${encodeURIComponent(key)}?${q}`,
					{ headers: await auth() },
				);
				return r.secret.secretValue;
			},
		};
	},
});

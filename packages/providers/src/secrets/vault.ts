import { z } from "zod";
import { defineProvider, Http, ProviderError, secret } from "../http.ts";
import { asString, memo, type SecretSource, trimUrl } from "./types.ts";

export const vaultConfig = z.object({
	url: z.url(),
	token: secret(),
	/** Vault Enterprise / HCP namespace. */
	namespace: z.string().optional(),
});

/** HashiCorp Vault, KV version 2. References read `<mount>/<path>#<field>`. */
export const vault = defineProvider({
	configSchema: vaultConfig,
	create(config, deps): SecretSource {
		const http = new Http("vault", deps);
		const base = trimUrl(config.url);
		const headers = {
			"x-vault-token": config.token,
			...(config.namespace ? { "x-vault-namespace": config.namespace } : {}),
		};
		const document = memo(async (path) => {
			const body = await http.json<{
				data?: { data?: Record<string, unknown> };
			}>("read", `${base}/v1/${path}`, { headers });
			return body.data?.data ?? {};
		});
		return {
			async test() {
				await http.request("test", `${base}/v1/auth/token/lookup-self`, {
					headers,
				});
			},
			async read([mount, ...rest], key) {
				const where = [mount, ...rest].join("/");
				const data = await document(
					[mount, "data", ...rest]
						.map((s) => encodeURIComponent(s ?? ""))
						.join("/"),
				);
				if (!(key in data))
					throw new ProviderError(
						"vault",
						"read",
						`no field "${key}" at ${where}`,
					);
				return asString(data[key]);
			},
		};
	},
});

import { z } from "zod";
import { defineProvider, Http, ProviderError, secret } from "../http.ts";
import { memo, type SecretSource, trimUrl } from "./types.ts";

export const onepasswordConfig = z.object({
	/** The 1Password Connect server. */
	url: z.url(),
	token: secret(),
});

type Named = { id: string; name?: string; title?: string };
type Item = { fields?: { id: string; label?: string; value?: string }[] };

/** 1Password through a Connect server. References read `<vault>/<item>#<field>`, by name or id. */
export const onepassword = defineProvider({
	configSchema: onepasswordConfig,
	create(config, deps): SecretSource {
		const http = new Http("1password", deps);
		const base = trimUrl(config.url);
		const headers = { authorization: `Bearer ${config.token}` };
		const get = <T>(op: string, path: string) =>
			http.json<T>(op, `${base}/v1/${path}`, { headers });
		const pick = (list: Named[], want: string, what: string) => {
			const hit = list.find(
				(x) => x.id === want || x.name === want || x.title === want,
			);
			if (!hit)
				throw new ProviderError("1password", "read", `no ${what} "${want}"`);
			return hit.id;
		};
		const vaults = memo(() => get<Named[]>("vaults", "vaults"));
		// shortcut: lists the whole vault to match a title; use a `filter` query if vaults grow past a few thousand items.
		const items = memo((vaultId) =>
			get<Named[]>("items", `vaults/${encodeURIComponent(vaultId)}/items`),
		);
		const item = memo((ids) => get<Item>("item", ids));
		return {
			async test() {
				await vaults("");
			},
			async read([vaultName = "", itemName = ""], key) {
				const vaultId = pick(await vaults(""), vaultName, "vault");
				const itemId = pick(await items(vaultId), itemName, "item");
				const it = await item(
					`vaults/${encodeURIComponent(vaultId)}/items/${encodeURIComponent(itemId)}`,
				);
				const field = it.fields?.find((f) => f.label === key || f.id === key);
				if (field?.value === undefined)
					throw new ProviderError(
						"1password",
						"read",
						`no field "${key}" in ${vaultName}/${itemName}`,
					);
				return field.value;
			},
		};
	},
});

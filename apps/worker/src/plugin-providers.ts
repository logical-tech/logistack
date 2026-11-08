import type { PluginProviderKind } from "@logistack/contracts";
import { decrypt, pluginBaseUrl } from "@logistack/core";
import { type Db, pluginInstall } from "@logistack/db";
import {
	type Fetch,
	guardedFetch,
	type PluginProviderCall,
	ProviderError,
	pluginDisabled,
	pluginProviderCall,
} from "@logistack/providers";
import { eq } from "drizzle-orm";
import { hostPolicy } from "./ssrf.ts";

// Provider rows of kind `plugin` (docs/plans/plugins.md, "Providers") resolve here, for the api
// and the worker alike: the install must belong to the row's organization, be enabled and still
// contribute the provider; otherwise every call fails with a reason instead of silently.

export type PluginProviderRef = {
	organizationId: string;
	pluginInstallId?: string | null;
	pluginProvider?: string | null;
};

export type PluginProviderCtx = {
	db: Db;
	masterKey: CryptoKey;
	/** Test isolation prefix of Docker names (`LS_NAME_PREFIX`). */
	namePrefix?: string;
	/** Tests only: replaces the fetch, also for dev URLs. */
	fetch?: Fetch;
};

export async function openPluginProvider(
	ctx: PluginProviderCtx,
	kind: PluginProviderKind,
	ref: PluginProviderRef,
	config: unknown,
): Promise<PluginProviderCall> {
	if (!ref.pluginInstallId || !ref.pluginProvider)
		throw new ProviderError("plugin", "open", "no plugin provider is set");
	const [row] = await ctx.db
		.select()
		.from(pluginInstall)
		.where(eq(pluginInstall.id, ref.pluginInstallId));
	if (!row || row.organizationId !== ref.organizationId || !row.enabled)
		throw pluginDisabled(row?.manifest.name ?? "open");
	if (
		!row.manifest.contributes[kind].some((p) => p.name === ref.pluginProvider)
	)
		throw new ProviderError(
			"plugin",
			row.manifest.name,
			`this version no longer provides ${ref.pluginProvider}`,
		);
	const target = {
		baseUrl: pluginBaseUrl(row, ctx.namePrefix),
		installId: row.id,
		signingSecret: await decrypt(ctx.masterKey, row.signingSecretEncrypted),
	};
	// A container is on our own network; a dev URL is user input and goes through the SSRF guard.
	let f = ctx.fetch;
	if (!f && row.devUrl) {
		const policy = await hostPolicy(ctx.db);
		f = (url, init) => guardedFetch(url, init ?? {}, policy, undefined, true);
	}
	return pluginProviderCall(target, kind, ref.pluginProvider, config, f);
}

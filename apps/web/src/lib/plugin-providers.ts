import { useQuery } from "@tanstack/react-query";
import { Puzzle } from "lucide-react";
import { useCallback, useMemo } from "react";
import type { ConfigSchema } from "@/components/integrations/config-form";
import {
	type PluginContribution,
	pluginContributionsQuery,
} from "@/lib/api/plugins";

/** Where a provider row of kind `plugin` comes from. */
export type PluginRef = { pluginInstallId: string; pluginProvider: string };

export type PluginProviderKind = keyof PluginContribution["providers"];

/** A plugin's provider as a wizard choice; `key` is the radio value. */
export type PluginChoice = {
	key: string;
	ref: PluginRef;
	title: string;
	pluginName: string;
	schema: ConfigSchema;
};

/**
 * Providers of `kind` that enabled installs contribute, for the existing provider wizards, and
 * `resolve`, which maps a wizard's radio value back to the row kind (`plugin` for these).
 */
export function usePluginChoices<K extends string>(kind: PluginProviderKind) {
	const { data } = useQuery(pluginContributionsQuery);
	const plugins = useMemo(
		(): PluginChoice[] =>
			(data ?? []).flatMap((c) =>
				c.providers[kind].map((p) => ({
					key: `plugin:${c.installId}:${p.name}`,
					ref: { pluginInstallId: c.installId, pluginProvider: p.name },
					title: p.title,
					pluginName: c.pluginName,
					schema: p.configSchema as ConfigSchema,
				})),
			),
		[data, kind],
	);
	const resolve = useCallback(
		(value: string) => {
			const plugin = plugins.find((p) => p.key === value);
			return { kind: (plugin ? "plugin" : value) as K, plugin };
		},
		[plugins],
	);
	/** Radio choices, after the built-in ones; the plugin's name is the badge. */
	const choices = plugins.map((p) => ({
		value: p.key,
		title: p.title,
		description: `Contributed by the ${p.pluginName} plugin.`,
		icon: Puzzle,
		badge: p.pluginName,
	}));
	return { plugins, resolve, choices };
}

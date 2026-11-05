/**
 * The platform install.sh found next to this server, and how to read it into an inventory. Each
 * source reads its own database read-only; everything after the inventory is shared.
 */
import type { MigrationSource } from "@logistack/contracts";
import type { Config } from "../config.ts";
import { buildCoolifyInventory } from "./coolify/inventory.ts";
import { readCoolify } from "./coolify/read.ts";
import { coolifySource } from "./coolify/source.ts";
import { buildInventory } from "./dokploy/inventory.ts";
import { readDokploy } from "./dokploy/read.ts";
import { dokploySource } from "./dokploy/source.ts";
import type { Inventory } from "./types.ts";

export type DetectedSource = {
	source: MigrationSource;
	read: () => Promise<Inventory>;
};

export function detectSource(cfg: Config): DetectedSource | undefined {
	const dokploy = dokploySource(cfg);
	if (dokploy)
		return {
			source: "dokploy",
			read: async () =>
				buildInventory(
					await readDokploy(dokploy.url, {
						composeRoot: dokploy.composeRoot,
						secrets: dokploy.secrets,
					}),
				),
		};
	const coolify = coolifySource(cfg);
	if (coolify)
		return {
			source: "coolify",
			read: async () =>
				buildCoolifyInventory(
					await readCoolify(coolify.url, { appKey: coolify.appKey }),
				),
		};
	return undefined;
}

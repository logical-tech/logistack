import { type Db, instanceSettings } from "@logistack/db";
import type { HostPolicy } from "@logistack/providers";
import { eq } from "drizzle-orm";

export {
	BlockedHostError,
	guardedFetch,
	type HostPolicy,
	isPrivateAddress,
	type Lookup,
	resolvePublic,
} from "@logistack/providers";

export async function hostPolicy(db: Db): Promise<HostPolicy> {
	const [row] = await db
		.select({ allowPrivateHosts: instanceSettings.allowPrivateHosts })
		.from(instanceSettings)
		.where(eq(instanceSettings.id, "singleton"));
	return { allowPrivateHosts: row?.allowPrivateHosts ?? false };
}

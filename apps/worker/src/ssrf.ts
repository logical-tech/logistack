import { type Db, instanceSettings } from "@logistack/db";
import { type HostPolicy, resolvePublic } from "@logistack/providers";
import { eq } from "drizzle-orm";
import type { Ctx } from "./ctx.ts";

export async function hostPolicy(db: Db): Promise<HostPolicy> {
	const [row] = await db
		.select({ allowPrivateHosts: instanceSettings.allowPrivateHosts })
		.from(instanceSettings)
		.where(eq(instanceSettings.id, "singleton"));
	return { allowPrivateHosts: row?.allowPrivateHosts ?? false };
}

/**
 * The address a clone of a user-chosen host connects to: it must resolve, and to public
 * addresses only unless the instance allows private hosts. Callers pin the connection to it.
 */
export async function publicAddress(
	ctx: Ctx,
	hostname: string,
): Promise<string> {
	return resolvePublic(hostname, await hostPolicy(ctx.db));
}

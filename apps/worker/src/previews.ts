import { environment } from "@logistack/db";
import { and, isNotNull, sql } from "drizzle-orm";
import type { Ctx } from "./ctx.ts";
import { enqueueProxySync, enqueueReconcile } from "./queues.ts";

/** Deletes the previews no pull request event touched within their TTL; the orphan sweep removes what they ran. */
export async function expirePreviews(ctx: Ctx, now = new Date()) {
	const gone = await ctx.db
		.delete(environment)
		.where(
			and(
				isNotNull(environment.preview),
				sql`(${environment.preview}->>'expiresAt')::timestamptz < ${now.toISOString()}::timestamptz`,
			),
		)
		.returning({ id: environment.id });
	if (gone.length)
		await Promise.all([
			enqueueReconcile(ctx.queues, "previews expired"),
			enqueueProxySync(ctx.queues, "previews expired"),
		]);
	return gone.map((e) => e.id);
}

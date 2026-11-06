import type { AiTier } from "@logistack/core";
import { aiBudget, aiUsage, type Db } from "@logistack/db";
import { and, eq, gte, sql } from "drizzle-orm";

/** Budgets reset at 00:00 UTC on the 1st. */
export function monthStart(now = new Date()): Date {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export type Spend = Record<AiTier, number>;

/** Micro-dollars spent this month per tier, by one member or (no `userId`) by everyone. */
export async function monthSpend(
	db: Db,
	organizationId: string,
	userId?: string,
): Promise<Map<string, Spend>> {
	const rows = await db
		.select({
			userId: aiUsage.userId,
			tier: aiUsage.tier,
			cost: sql<string>`coalesce(sum(${aiUsage.costMicros}), 0)`,
		})
		.from(aiUsage)
		.where(
			and(
				eq(aiUsage.organizationId, organizationId),
				userId ? eq(aiUsage.userId, userId) : undefined,
				gte(aiUsage.createdAt, monthStart()),
			),
		)
		.groupBy(aiUsage.userId, aiUsage.tier);
	const out = new Map<string, Spend>();
	for (const r of rows) {
		const s = out.get(r.userId) ?? { free: 0, paid: 0 };
		if (r.tier === "free" || r.tier === "paid") s[r.tier] = Number(r.cost);
		out.set(r.userId, s);
	}
	return out;
}

export type Caps = Record<AiTier, number | null>;

/**
 * A member's monthly caps (micro-dollars, null = unlimited). Without a budget row admins are
 * unlimited and everyone else may spend nothing until an admin assigns an amount.
 */
export async function capsFor(
	db: Db,
	organizationId: string,
	userId: string,
	isAdmin: boolean,
): Promise<Caps> {
	const [row] = await db
		.select()
		.from(aiBudget)
		.where(
			and(
				eq(aiBudget.organizationId, organizationId),
				eq(aiBudget.userId, userId),
			),
		);
	if (!row) return isAdmin ? { free: null, paid: null } : { free: 0, paid: 0 };
	return { free: row.freeCapMicros, paid: row.paidCapMicros };
}

/** Tiers the member can still spend on this month. */
export async function openTiers(
	db: Db,
	organizationId: string,
	userId: string,
	isAdmin: boolean,
): Promise<Set<AiTier>> {
	const [caps, spend] = await Promise.all([
		capsFor(db, organizationId, userId, isAdmin),
		monthSpend(db, organizationId, userId),
	]);
	const spent = spend.get(userId) ?? { free: 0, paid: 0 };
	// shortcut: checked before the call, not reserved; parallel calls can overshoot by their own cost. Reserve in Redis if that matters.
	return new Set(
		(["free", "paid"] as const).filter((t) => {
			const cap = caps[t];
			return cap === null || spent[t] < cap;
		}),
	);
}

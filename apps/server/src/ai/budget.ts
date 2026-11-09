import type { AiTier } from "@logistack/core";
import { aiBudget, aiBudgetReservation, aiUsage, type Db } from "@logistack/db";
import { and, eq, gt, gte, lte, sql } from "drizzle-orm";

type Reader = Pick<Db, "select">;

/** Budgets reset at 00:00 UTC on the 1st. */
export function monthStart(now = new Date()): Date {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export type Spend = Record<AiTier, number>;

/** Micro-dollars spent this month per tier, by one member or (no `userId`) by everyone. */
export async function monthSpend(
	db: Reader,
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
	db: Reader,
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
	// A quick filter only: `reserve` is what holds the line when calls race.
	return new Set(
		(["free", "paid"] as const).filter((t) => {
			const cap = caps[t];
			return cap === null || spent[t] < cap;
		}),
	);
}

/** A call outlives this only by crashing; its hold then stops counting. */
const RESERVATION_TTL_MS = 15 * 60_000;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Serializes one member's reserve and settle, so spend + holds is read and changed atomically. */
const lockMember = (tx: Tx, organizationId: string, userId: string) =>
	tx.execute(
		sql`select pg_advisory_xact_lock(hashtext(${organizationId}), hashtext(${userId}))`,
	);

export type Member = {
	organizationId: string;
	userId: string;
	isAdmin: boolean;
};

/**
 * Holds `micros` of the member's `tier` budget for a call about to start. Returns the hold's id, or
 * undefined when this month's spend, the holds of calls still running and this one would pass the cap.
 */
export async function reserve(
	db: Db,
	who: Member,
	tier: AiTier,
	/** Null when the model has no known price. */
	micros: number | null,
): Promise<string | undefined> {
	return db.transaction(async (tx) => {
		await lockMember(tx, who.organizationId, who.userId);
		await tx
			.delete(aiBudgetReservation)
			.where(
				and(
					eq(aiBudgetReservation.organizationId, who.organizationId),
					eq(aiBudgetReservation.userId, who.userId),
					lte(aiBudgetReservation.expiresAt, new Date()),
				),
			);
		const cap = (
			await capsFor(tx, who.organizationId, who.userId, who.isAdmin)
		)[tier];
		if (cap !== null) {
			if (micros === null) return undefined;
			const spent =
				(await monthSpend(tx, who.organizationId, who.userId)).get(
					who.userId,
				)?.[tier] ?? 0;
			const [held] = await tx
				.select({
					micros: sql<string>`coalesce(sum(${aiBudgetReservation.micros}), 0)`,
				})
				.from(aiBudgetReservation)
				.where(
					and(
						eq(aiBudgetReservation.organizationId, who.organizationId),
						eq(aiBudgetReservation.userId, who.userId),
						eq(aiBudgetReservation.tier, tier),
						gt(aiBudgetReservation.expiresAt, new Date()),
					),
				);
			// A call needs some room even when its estimate rounds to zero.
			if (spent + Number(held?.micros ?? 0) + Math.max(micros, 1) > cap)
				return undefined;
		}
		const [row] = await tx
			.insert(aiBudgetReservation)
			.values({
				organizationId: who.organizationId,
				userId: who.userId,
				tier,
				micros: Math.max(micros ?? 1, 1),
				expiresAt: new Date(Date.now() + RESERVATION_TTL_MS),
			})
			.returning({ id: aiBudgetReservation.id });
		return row?.id;
	});
}

/** Replaces a hold with the call's ledger row (or just drops it, without `usage`), under the member's lock. */
export async function settle(
	db: Db,
	reservationId: string,
	who: Pick<Member, "organizationId" | "userId">,
	usage?: typeof aiUsage.$inferInsert,
) {
	await db.transaction(async (tx) => {
		await lockMember(tx, who.organizationId, who.userId);
		if (usage) await tx.insert(aiUsage).values(usage);
		await tx
			.delete(aiBudgetReservation)
			.where(eq(aiBudgetReservation.id, reservationId));
	});
}

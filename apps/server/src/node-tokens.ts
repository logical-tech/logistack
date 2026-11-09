import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type Db, node, nodeToken, organization } from "@logistack/db";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import type {
	AgentAdmission,
	AgentGatewayDeps,
	AgentHello,
	AgentRefusal,
} from "./agent-gateway.ts";
import { type Cluster, NODE_REVOKED_CHANNEL } from "./cluster.ts";

export const NODE_TOKEN_PREFIX = "lsn_";

const sha256 = (v: string) => createHash("sha256").update(v).digest();

const refuse = (
	status: AgentRefusal["status"],
	code: string,
	message: string,
): AgentRefusal => ({ status, code, message });

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function hasToken(db: Db | Tx, nodeRowId: string, revoked: boolean) {
	const [row] = await db
		.select({ id: nodeToken.id })
		.from(nodeToken)
		.where(
			and(
				eq(nodeToken.nodeId, nodeRowId),
				revoked ? isNotNull(nodeToken.revokedAt) : isNull(nodeToken.revokedAt),
			),
		)
		.limit(1);
	return Boolean(row);
}
const isRevoked = (db: Db | Tx, nodeRowId: string) =>
	hasToken(db, nodeRowId, true);
// The agent keeps its token on a per-node volume; enrolling over a live token would let any host
// holding the shared enrollment token take over another node's identity.
const isEnrolled = (db: Db | Tx, nodeRowId: string) =>
	hasToken(db, nodeRowId, false);

const nodeFields = (h: AgentHello) => ({
	hostname: h.hostname,
	agentVersion: h.version,
	status: "ready" as const,
	lastSeenAt: new Date(),
	...(h.role ? { role: h.role } : {}),
	...(h.address ? { address: h.address } : {}),
});

/**
 * Admits agents. The installer's enrollment token creates or links the `node` row (by Swarm node
 * id) on hello and returns a per-node token, stored hashed; a per-node token admits only its node.
 * A node with a revoked token is refused with either kind until its `node` row is deleted; a node
 * that already holds a live token is refused the enrollment token (409) until then too.
 */
export function nodeTokenAuth(
	db: Db,
	enrollmentToken: string | undefined,
): AgentGatewayDeps["authenticate"] {
	const enrollment = enrollmentToken ? sha256(enrollmentToken) : undefined;
	return async (token, swarmNodeId) => {
		const digest = sha256(token);
		if (enrollment && timingSafeEqual(digest, enrollment))
			return enroll(db, swarmNodeId);
		const [row] = await db
			.select({
				id: nodeToken.id,
				organizationId: nodeToken.organizationId,
				revokedAt: nodeToken.revokedAt,
				nodeRowId: node.id,
				swarmNodeId: node.swarmNodeId,
			})
			.from(nodeToken)
			.innerJoin(node, eq(node.id, nodeToken.nodeId))
			.where(eq(nodeToken.tokenHash, digest.toString("hex")));
		if (!row) return refuse(401, "invalid_token", "unknown node token");
		if (row.revokedAt)
			return refuse(401, "token_revoked", "this node token was revoked");
		if (row.swarmNodeId !== swarmNodeId)
			return refuse(403, "node_mismatch", "the token belongs to another node");
		return {
			organizationId: row.organizationId,
			async hello(h) {
				await db
					.update(node)
					.set(nodeFields(h))
					.where(eq(node.id, row.nodeRowId));
				await db
					.update(nodeToken)
					.set({ lastUsedAt: new Date() })
					.where(eq(nodeToken.id, row.id));
				return {};
			},
		};
	};
}

async function enroll(
	db: Db,
	swarmNodeId: string,
): Promise<AgentAdmission | AgentRefusal> {
	const revokedMessage =
		"this node was revoked; delete it to let it enroll again";
	const enrolledMessage =
		"this node is already enrolled; delete it to let it enroll again";
	const [existing] = await db
		.select({ id: node.id, organizationId: node.organizationId })
		.from(node)
		.where(eq(node.swarmNodeId, swarmNodeId));
	if (existing && (await isRevoked(db, existing.id)))
		return refuse(403, "node_revoked", revokedMessage);
	if (existing && (await isEnrolled(db, existing.id)))
		return refuse(409, "node_enrolled", enrolledMessage);
	// shortcut: a new node joins the oldest organization (the one setup created); pick it explicitly once nodes can be shared or moved.
	const [first] = existing
		? [existing]
		: await db
				.select({ organizationId: organization.id })
				.from(organization)
				.orderBy(asc(organization.createdAt))
				.limit(1);
	if (!first)
		return refuse(503, "setup_required", "instance setup is not completed");
	const { organizationId } = first;
	return {
		organizationId,
		hello: (h) =>
			db.transaction(async (tx) => {
				const [row] = await tx
					.insert(node)
					.values({
						organizationId,
						swarmNodeId,
						address: "",
						role: "worker",
						...nodeFields(h),
					})
					.onConflictDoUpdate({ target: node.swarmNodeId, set: nodeFields(h) })
					.returning({ id: node.id, organizationId: node.organizationId });
				if (!row) throw new Error("node upsert returned no row");
				if (await isRevoked(tx, row.id)) throw new Error(revokedMessage);
				// A concurrent enrollment of the same node won the race.
				if (await isEnrolled(tx, row.id)) throw new Error(enrolledMessage);
				const token = NODE_TOKEN_PREFIX + randomBytes(32).toString("base64url");
				await tx.insert(nodeToken).values({
					organizationId: row.organizationId,
					nodeId: row.id,
					tokenHash: sha256(token).toString("hex"),
				});
				return { nodeToken: token };
			}),
	};
}

/**
 * Revokes the node's tokens: its next connection is refused, enrollment token included, and the
 * replica holding its open socket closes it (`NODE_REVOKED_CHANNEL`).
 */
export async function revokeNode(
	db: Db,
	shared: Pick<Cluster, "publish">,
	swarmNodeId: string,
) {
	const [row] = await db
		.select({ id: node.id })
		.from(node)
		.where(eq(node.swarmNodeId, swarmNodeId));
	if (!row) return 0;
	const revoked = await db
		.update(nodeToken)
		.set({ revokedAt: new Date() })
		.where(and(eq(nodeToken.nodeId, row.id), isNull(nodeToken.revokedAt)))
		.returning({ id: nodeToken.id });
	await shared.publish(NODE_REVOKED_CHANNEL, { nodeId: swarmNodeId });
	return revoked.length;
}

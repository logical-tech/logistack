import type { Who } from "./auth.ts";
import { type Env, HttpError, now, str } from "./http.ts";

// The review queue. "Verified" means an admin read the source at a named commit; the CI job in
// ci/review.yml attaches its contract test and scan results for the admin to read first.

export type QueueVersion = {
	id: string;
	plugin_id: string;
	version: string;
	image: string;
	status: string;
	review_notes: string;
	reviewer: string | null;
	reviewed_commit: string | null;
	checks: string | null;
	publisher_id: string;
	publisher: string;
	publisher_email: string;
	publisher_suspended: number | null;
	created_at: number;
};

export type Report = {
	id: string;
	plugin_id: string;
	version: string | null;
	reason: string;
	contact: string | null;
	created_at: number;
};

/** Everything an admin can act on: pending, unverified and verified versions, and open reports. */
export async function queue(env: Env) {
	const db = env.PLUGIN_INDEX;
	const [versions, reports] = await Promise.all([
		db
			.prepare(
				`SELECT v.id, v.plugin_id, v.version, v.image, v.status, v.review_notes, v.reviewer,
				        v.reviewed_commit, v.checks, v.created_at, pub.id AS publisher_id, pub.name AS publisher,
				        pub.email AS publisher_email, pub.suspended_at AS publisher_suspended
				 FROM versions v JOIN plugins p ON p.id = v.plugin_id JOIN publishers pub ON pub.id = p.publisher_id
				 WHERE v.status IN ('pending', 'unverified', 'verified')
				 ORDER BY CASE v.status WHEN 'verified' THEN 1 ELSE 0 END, v.created_at`,
			)
			.all<QueueVersion>(),
		db
			.prepare(
				"SELECT id, plugin_id, version, reason, contact, created_at FROM reports WHERE status = 'open' ORDER BY created_at",
			)
			.all<Report>(),
	]);
	return { versions: versions.results, reports: reports.results };
}

/** Moves a version from one of `from` to `to`; 409 when it is in another state. */
async function move(
	env: Env,
	id: string,
	from: string[],
	to: string,
	set: Record<string, string | null> = {},
) {
	const cols = Object.keys(set);
	const res = await env.PLUGIN_INDEX.prepare(
		`UPDATE versions SET status = ?, updated_at = ?${cols.map((c) => `, ${c} = ?`).join("")}
		 WHERE id = ? AND status IN (${from.map(() => "?").join(", ")})`,
	)
		.bind(to, now(), ...Object.values(set), id, ...from)
		.run();
	if (!res.meta.changes)
		throw new HttpError(409, `the version is not ${from.join(" or ")}`);
}

export async function verify(
	env: Env,
	who: Who,
	id: string,
	body: Record<string, unknown>,
) {
	const commit = str(body.commit, 200);
	if (!commit || commit.length > 200)
		throw new HttpError(
			400,
			"name the source commit you reviewed (a SHA or a commit URL)",
		);
	await move(env, id, ["unverified"], "verified", {
		reviewer: who.publisher.email,
		reviewed_commit: commit,
	});
}

export async function reject(
	env: Env,
	who: Who,
	id: string,
	body: Record<string, unknown>,
) {
	const notes = str(body.notes, 2000);
	if (!notes) throw new HttpError(400, "tell the publisher why");
	await move(env, id, ["pending", "unverified"], "rejected", {
		review_notes: notes,
		reviewer: who.publisher.email,
	});
}

/** Servers keep yanked installs running and warn at their next refresh. */
export async function yank(
	env: Env,
	who: Who,
	id: string,
	body: Record<string, unknown>,
) {
	const notes = str(body.notes, 2000);
	if (!notes) throw new HttpError(400, "say why the version is yanked");
	await move(env, id, ["unverified", "verified"], "yanked", {
		review_notes: notes,
		reviewer: who.publisher.email,
	});
}

/** Results from the CI review job, kept as JSON next to the version. */
export async function attachChecks(
	env: Env,
	id: string,
	body: Record<string, unknown>,
) {
	const json = JSON.stringify(body);
	if (json.length > 16 * 1024)
		throw new HttpError(413, "checks are larger than 16 KiB");
	const res = await env.PLUGIN_INDEX.prepare(
		"UPDATE versions SET checks = ?, updated_at = ? WHERE id = ?",
	)
		.bind(json, now(), id)
		.run();
	if (!res.meta.changes) throw new HttpError(404, "no such version");
}

/** Blocks the publisher and yanks every listed version, so servers learn of it at their next refresh. */
export async function suspend(
	env: Env,
	id: string,
	body: Record<string, unknown>,
) {
	const reason = str(body.reason, 500);
	if (!reason) throw new HttpError(400, "say why the publisher is suspended");
	const db = env.PLUGIN_INDEX;
	const t = now();
	const [res] = await db.batch([
		db
			.prepare(
				"UPDATE publishers SET suspended_at = ?, suspended_reason = ? WHERE id = ? AND suspended_at IS NULL",
			)
			.bind(t, reason, id),
		db
			.prepare(
				`UPDATE versions SET status = 'yanked', review_notes = ?, updated_at = ?
				 WHERE status IN ('pending', 'unverified', 'verified')
				   AND plugin_id IN (SELECT id FROM plugins WHERE publisher_id = ?)`,
			)
			.bind(`publisher suspended: ${reason}`, t, id),
		db.prepare("DELETE FROM sessions WHERE publisher_id = ?").bind(id),
		db.prepare("DELETE FROM api_tokens WHERE publisher_id = ?").bind(id),
	]);
	if (!res?.meta.changes) throw new HttpError(409, "no such active publisher");
}

export async function resolveReport(
	env: Env,
	id: string,
	body: Record<string, unknown>,
) {
	const resolution = str(body.resolution, 1000);
	if (!resolution) throw new HttpError(400, "note what was done");
	const res = await env.PLUGIN_INDEX.prepare(
		"UPDATE reports SET status = 'resolved', resolution = ?, resolved_at = ? WHERE id = ? AND status = 'open'",
	)
		.bind(resolution, now(), id)
		.run();
	if (!res.meta.changes) throw new HttpError(409, "no such open report");
}

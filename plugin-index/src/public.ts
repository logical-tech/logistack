import type {
	PluginIndexEntry,
	PluginIndexVersion,
} from "../../packages/contracts/src/plugin.ts";
import { PluginId } from "../../packages/contracts/src/plugin.ts";
import { type Env, HttpError, newId, now, str } from "./http.ts";

// What LogiStack servers read: the index and one plugin's versions (signed by the router), plus
// the anonymous install ping and abuse reports.

const ACTIVE_WINDOW = 30 * 86_400;

type Row = {
	plugin_id: string;
	publisher: string;
	version: string;
	image: string;
	manifest: string;
	readme: string;
	changelog: string;
	icon_url: string | null;
	status: "unverified" | "verified" | "yanked";
	created_at: number;
};

/** Newest first. Shortcut: prerelease tags compare as plain strings; full semver rules if they matter. */
export function compareVersions(a: string, b: string): number {
	const [ma = "", pa] = a.split(/-(.*)/s);
	const [mb = "", pb] = b.split(/-(.*)/s);
	const na = ma.split(".").map(Number);
	const nb = mb.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const d = (nb[i] ?? 0) - (na[i] ?? 0);
		if (d) return d;
	}
	if (pa === pb) return 0;
	if (pa === undefined) return -1;
	if (pb === undefined) return 1;
	return pb < pa ? -1 : 1;
}

const toVersion = (r: Row, docs: boolean): PluginIndexVersion => ({
	version: r.version,
	image: r.image,
	manifest: JSON.parse(r.manifest),
	verified: r.status === "verified",
	yanked: r.status === "yanked",
	iconUrl: r.icon_url,
	publishedAt: new Date(r.created_at * 1000).toISOString(),
	...(docs ? { readme: r.readme, changelog: r.changelog } : {}),
});

async function listed(env: Env, pluginId?: string) {
	const db = env.PLUGIN_INDEX;
	const where = pluginId ? "AND v.plugin_id = ?" : "";
	const q = db.prepare(
		`SELECT v.plugin_id, pub.name AS publisher, v.version, v.image, v.manifest, v.readme,
		        v.changelog, v.icon_url, v.status, v.created_at
		 FROM versions v JOIN plugins p ON p.id = v.plugin_id JOIN publishers pub ON pub.id = p.publisher_id
		 WHERE v.status IN ('unverified', 'verified', 'yanked') ${where}`,
	);
	const counts = db.prepare(
		`SELECT plugin_id, COUNT(*) AS n FROM install_pings WHERE last_seen > ? ${pluginId ? "AND plugin_id = ?" : ""} GROUP BY plugin_id`,
	);
	const since = now() - ACTIVE_WINDOW;
	const [rows, installs] = await Promise.all([
		(pluginId ? q.bind(pluginId) : q).all<Row>(),
		(pluginId ? counts.bind(since, pluginId) : counts.bind(since)).all<{
			plugin_id: string;
			n: number;
		}>(),
	]);
	const n = new Map(installs.results.map((r) => [r.plugin_id, r.n]));
	const byPlugin = new Map<string, Row[]>();
	for (const r of rows.results)
		byPlugin.set(r.plugin_id, [...(byPlugin.get(r.plugin_id) ?? []), r]);
	for (const vs of byPlugin.values())
		vs.sort((a, b) => compareVersions(a.version, b.version));
	return { byPlugin, installs: (id: string) => n.get(id) ?? 0 };
}

export async function buildIndex(env: Env) {
	const { byPlugin, installs } = await listed(env);
	const plugins: PluginIndexEntry[] = [...byPlugin]
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([id, vs]) => {
			const latest = vs.find((v) => v.status !== "yanked");
			const verified = vs.find((v) => v.status === "verified");
			return {
				id,
				publisher: vs[0]?.publisher ?? "",
				installs: installs(id),
				latest: latest ? toVersion(latest, false) : null,
				latestVerified: verified ? toVersion(verified, false) : null,
				yanked: vs
					.filter((v) => v.status === "yanked")
					.map((v) => ({ version: v.version, image: v.image })),
			};
		});
	return { v: 1, kind: "index", issuedAt: new Date().toISOString(), plugins };
}

export async function buildDetail(env: Env, id: string) {
	const { byPlugin, installs } = await listed(env, id);
	const vs = byPlugin.get(id);
	if (!vs) return null;
	return {
		v: 1,
		kind: "plugin",
		issuedAt: new Date().toISOString(),
		plugin: {
			id,
			publisher: vs[0]?.publisher ?? "",
			installs: installs(id),
			versions: vs.map((v) => toVersion(v, true)),
		},
	};
}

/** Opt-in: `{pluginId, installId}`, the install id being random and meaningless outside the index. */
export async function ping(env: Env, body: Record<string, unknown>) {
	const pluginId = str(body.pluginId, 128);
	const installId = str(body.installId, 64);
	if (
		!PluginId.safeParse(pluginId).success ||
		!/^[A-Za-z0-9_-]{8,64}$/.test(installId)
	)
		throw new HttpError(400, "pluginId and installId are required");
	await env.PLUGIN_INDEX.prepare(
		`INSERT INTO install_pings (plugin_id, install_id, last_seen)
		 SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM plugins WHERE id = ?)
		 ON CONFLICT (plugin_id, install_id) DO UPDATE SET last_seen = excluded.last_seen`,
	)
		.bind(pluginId, installId, now(), pluginId)
		.run();
}

export async function report(env: Env, body: Record<string, unknown>) {
	const pluginId = str(body.pluginId, 128);
	const version = str(body.version, 64) || null;
	const reason = str(body.reason, 2000);
	const contact = str(body.contact, 200) || null;
	if (reason.length < 10 || reason.length > 2000)
		throw new HttpError(400, "describe the problem in 10 to 2000 characters");
	const exists = await env.PLUGIN_INDEX.prepare(
		"SELECT 1 FROM plugins WHERE id = ?",
	)
		.bind(pluginId)
		.first();
	if (!exists) throw new HttpError(404, "no such plugin");
	const id = newId("rep");
	await env.PLUGIN_INDEX.prepare(
		"INSERT INTO reports (id, plugin_id, version, reason, contact, created_at) VALUES (?, ?, ?, ?, ?, ?)",
	)
		.bind(id, pluginId, version, reason, contact, now())
		.run();
	return { id };
}

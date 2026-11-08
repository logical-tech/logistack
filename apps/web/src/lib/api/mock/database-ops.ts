/*
 * Mock public access, forwards and upgrades. Every database starts closed. Public access waits
 * for its certificate for a few seconds, then turns active; forwards are active at once; an
 * upgrade walks its steps over about ten seconds and succeeds, except to a version ending in
 * `-bad`, which fails verification after the switch and rolls back.
 */
import type {
	DatabaseAccessView,
	DatabaseUpgradeView,
} from "@logistack/contracts";
import { ApiError } from "../adapter";
import type { DatabaseOpsApi } from "../database-ops";

const wait = <T>(v: T, ms = 250) =>
	new Promise<T>((r) => setTimeout(() => r(v), ms));

const access = new Map<string, DatabaseAccessView[]>();
const upgrades = new Map<string, DatabaseUpgradeView[]>();
const versions = new Map<string, string>();
const YOUR_IP = "198.51.100.24";
let nextPort = 15000;

const listOf = (id: string) => {
	const now = Date.now();
	const rows = (access.get(id) ?? []).filter(
		(a) => !a.expiresAt || Date.parse(a.expiresAt) > now,
	);
	access.set(id, rows);
	return rows;
};

const uri = (host: string, port: number, tls: false | "verify" | "require") =>
	`postgres://postgres:PASSWORD@${host}:${port}/postgres${tls ? `?sslmode=${tls === "verify" ? "verify-full" : "require"}` : ""}`;

const STEPS = [
	"check",
	"instance",
	"copy",
	"verify",
	"switch",
	"reverify",
	"done",
];

export const mockDatabaseOps: DatabaseOpsApi = {
	access: (id) =>
		wait({
			access: listOf(id),
			yourIp: YOUR_IP,
			exposable: !id.includes("libsql"),
		}),
	setPublic: async (id, input) => {
		const rows = listOf(id).filter((a) => a.kind !== "public");
		const row: DatabaseAccessView = {
			id: `dba_${crypto.randomUUID().slice(0, 8)}`,
			kind: "public",
			hostname: input.hostname,
			port: input.port,
			allowedCidrs: input.allowedCidrs,
			tlsRequired: true,
			expiresAt: null,
			status: "waiting_certificate",
			statusMessage: `waiting for a certificate for ${input.hostname}`,
			createdAt: new Date().toISOString(),
			host: input.hostname,
			uri: uri(input.hostname, input.port, "verify"),
		};
		access.set(id, [row, ...rows]);
		setTimeout(() => {
			row.status = "active";
			row.statusMessage = null;
		}, 6000);
		return wait(row, 500);
	},
	closePublic: async (id) => {
		access.set(
			id,
			listOf(id).filter((a) => a.kind !== "public"),
		);
		await wait(undefined);
	},
	openForward: async (id, input) => {
		const tls = listOf(id).some((a) => a.kind === "public");
		const row: DatabaseAccessView = {
			id: `dba_${crypto.randomUUID().slice(0, 8)}`,
			kind: "forward",
			hostname: null,
			port: nextPort++,
			allowedCidrs: input.allowedCidrs ?? [YOUR_IP],
			tlsRequired: tls,
			expiresAt: new Date(Date.now() + input.minutes * 60_000).toISOString(),
			status: "active",
			statusMessage: null,
			createdAt: new Date().toISOString(),
			host: "203.0.113.7",
			uri: "",
		};
		row.uri = uri("203.0.113.7", row.port, tls ? "require" : false);
		access.set(id, [...listOf(id), row]);
		return wait(row, 400);
	},
	closeForward: async (id, accessId) => {
		access.set(
			id,
			listOf(id).filter((a) => a.id !== accessId),
		);
		await wait(undefined);
	},
	upgrades: (id) => wait(upgrades.get(id) ?? []),
	startUpgrade: async (id, version) => {
		const list = upgrades.get(id) ?? [];
		if (list.some((u) => u.status === "running"))
			throw new ApiError(
				409,
				"an upgrade of this database is running",
				"conflict",
			);
		const from = versions.get(id) ?? "17.6";
		if ((Number.parseInt(version, 10) || 0) <= (Number.parseInt(from, 10) || 0))
			throw new ApiError(
				400,
				`${version} is not later than ${from}`,
				"bad_request",
			);
		const u: DatabaseUpgradeView = {
			id: `dbu_${crypto.randomUUID().slice(0, 8)}`,
			fromVersion: from,
			toVersion: version,
			status: "running",
			step: "check",
			message: null,
			tables: null,
			createdAt: new Date().toISOString(),
			finishedAt: null,
		};
		upgrades.set(id, [u, ...list]);
		const bad = version.endsWith("-bad");
		STEPS.forEach((step, i) => {
			setTimeout(() => {
				if (u.status !== "running") return;
				if (bad && step === "reverify") {
					u.step = "rollback";
					setTimeout(() => {
						u.status = "rolled_back";
						u.message = `the upgraded database does not match: shop.public.orders: 10000 before, 9998 after. Rolled back to ${from}; the old data was never changed.`;
						u.finishedAt = new Date().toISOString();
					}, 1500);
					return;
				}
				u.step = step;
				if (step === "verify") u.tables = 14;
				if (step === "done") {
					u.status = "succeeded";
					u.message = `14 tables verified on ${version}`;
					u.finishedAt = new Date().toISOString();
					versions.set(id, version);
				}
			}, i * 1600);
		});
		return wait(u, 400);
	},
};

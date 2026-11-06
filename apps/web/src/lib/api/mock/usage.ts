import { type ApiAdapter, ApiError } from "../adapter";
import type {
	OrganizationUsage,
	ProjectUsage,
	UsageFigures,
	UsageRange,
} from "../types";
import type { MockDb } from "./fixtures";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const STEP: Record<UsageRange, number> = { "24h": 300, "7d": 3_600 };
const SPAN: Record<UsageRange, number> = { "24h": 86_400, "7d": 604_800 };

const seedOf = (id: string) =>
	[...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 9_973, 7);

/** Deterministic figures per service: databases hold memory and disk, apps burn CPU and network. */
function figures(id: string, kind: string, range: UsageRange): UsageFigures {
	const s = seedOf(id);
	const r = (lo: number, hi: number, k: number) =>
		lo + ((s * (k + 3)) % 97) * ((hi - lo) / 97);
	const db = kind === "database";
	return {
		cpu: r(0.01, db ? 0.4 : 1.2, 1),
		memUsed: r(40, db ? 900 : 420, 2) * MiB,
		rx: r(5, 900, 3) * MiB * (SPAN[range] / 86_400),
		tx: r(5, 1_400, 4) * MiB * (SPAN[range] / 86_400),
		disk: db ? r(0.2, 18, 5) * GiB : s % 3 === 0 ? r(1, 400, 6) * MiB : 0,
	};
}

function add(a: UsageFigures, b: UsageFigures): UsageFigures {
	return {
		cpu: a.cpu + b.cpu,
		memUsed: a.memUsed + b.memUsed,
		rx: a.rx + b.rx,
		tx: a.tx + b.tx,
		disk: (a.disk ?? 0) + (b.disk ?? 0),
	};
}

const zero: UsageFigures = { cpu: 0, memUsed: 0, rx: 0, tx: 0, disk: 0 };

function window(range: UsageRange, totals: UsageFigures, seed: number) {
	const stepMs = STEP[range] * 1000;
	const to = Math.ceil(Date.now() / stepMs) * stepMs;
	const from = to - SPAN[range] * 1000;
	const trend = [];
	for (let t = from; t < to; t += stepMs) {
		const day = 0.75 + 0.35 * Math.sin((t / 86_400_000) * 2 * Math.PI + seed);
		const noise = 0.92 + 0.08 * Math.sin(t / 1_700_000 + seed * 3);
		const k = day * noise;
		trend.push({
			t,
			cpu: totals.cpu * k,
			memUsed: totals.memUsed * (0.9 + 0.1 * noise),
			rx: (totals.rx / SPAN[range]) * k,
			tx: (totals.tx / SPAN[range]) * k,
		});
	}
	return { range, stepSec: STEP[range], from, to, totals, trend };
}

function delay<T>(value: T, ms = 180 + Math.random() * 260): Promise<T> {
	return new Promise((resolve) =>
		setTimeout(() => resolve(structuredClone(value)), ms),
	);
}

function projectUsage(db: MockDb, projectId: string, range: UsageRange) {
	const environments = db.environments
		.filter((e) => e.projectId === projectId)
		.map((e) => {
			const services = db.services
				.filter((s) => s.environmentId === e.id)
				.map((s) => ({
					id: s.id,
					name: s.name,
					...figures(s.id, s.spec.kind, range),
				}))
				.sort((a, b) => a.name.localeCompare(b.name));
			return {
				id: e.id,
				name: e.name,
				...services.reduce<UsageFigures>(add, zero),
				services,
			};
		});
	return {
		environments,
		totals: environments.reduce<UsageFigures>(add, zero),
	};
}

export function usageMock(
	db: MockDb,
): Pick<ApiAdapter["metrics"], "usage" | "projectUsage"> {
	return {
		usage: (range) => {
			const projects = db.projects.map((p) => ({
				id: p.id,
				name: p.name,
				...projectUsage(db, p.id, range).totals,
			}));
			const totals = projects.reduce<UsageFigures>(add, zero);
			const out: OrganizationUsage = {
				...window(range, totals, 1),
				capacity: { cpus: 40, memory: 160 * GiB, disk: 2_400 * GiB },
				projects,
			};
			return delay(out);
		},
		projectUsage: (id, range) => {
			if (!db.projects.some((p) => p.id === id))
				return Promise.reject(new ApiError(404, "project not found"));
			const { environments, totals } = projectUsage(db, id, range);
			const out: ProjectUsage = {
				...window(range, totals, seedOf(id) % 5),
				environments,
			};
			return delay(out);
		},
	};
}

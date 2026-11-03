import {
	backupRunChannel,
	type LiveMessage,
	scheduleRunChannel,
} from "@logistack/contracts";
import { nextRuns } from "@/lib/cron";
import { ApiError } from "../adapter";
import type {
	BackupPolicy,
	BackupRun,
	BackupsApi,
	S3Destination,
	Schedule,
	ScheduleRun,
	ScheduleRunDetail,
	ServiceBackups,
} from "../backups";

function delay<T>(value: T, ms = 200 + Math.random() * 350): Promise<T> {
	return new Promise((resolve) =>
		setTimeout(() => resolve(structuredClone(value)), ms),
	);
}

const rid = (prefix: string) =>
	`${prefix}_${Math.random().toString(36).slice(2, 10)}`;
const MIN = 60_000;
const now = Date.now();
const at = (minutesAgo: number) =>
	new Date(now - minutesAgo * MIN).toISOString();
const DAY = 1440;
const GB = 1024 ** 3;
const MB = 1024 ** 2;
/** A stable fake SHA-256 per seed (a linear congruential stream of hex digits). */
const sha = (seed: number) => {
	let x = (seed * 2654435761) >>> 0;
	return Array.from({ length: 64 }, () => {
		x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
		return (x >>> 28).toString(16);
	}).join("");
};

const destinations: S3Destination[] = [
	{
		id: "s3d_r2",
		name: "Backups · R2",
		endpoint: "https://7c2f9e0a41b84d0f.r2.cloudflarestorage.com",
		region: "auto",
		bucket: "logical-backups",
		prefix: "logistack/prod",
		accessKeyId: "3f6a0c1d9e2b4a7c8d5e1f0a2b3c4d5e",
		forcePathStyle: false,
		usedBy: 3,
		createdAt: at(120 * DAY),
	},
	{
		id: "s3d_hetzner",
		name: "Off-site · Falkenstein",
		endpoint: "https://fsn1.your-objectstorage.com",
		region: "fsn1",
		bucket: "logical-offsite",
		prefix: "volumes",
		accessKeyId: "HZ7K2M4Q9R1T5V8X0B3N",
		forcePathStyle: false,
		usedBy: 1,
		createdAt: at(64 * DAY),
	},
	{
		id: "s3d_b2",
		name: "Archive · B2",
		endpoint: "https://s3.eu-central-003.backblazeb2.com",
		region: "eu-central-003",
		bucket: "logical-archive",
		prefix: "",
		accessKeyId: "003a1b2c3d4e5f60000000007",
		forcePathStyle: false,
		usedBy: 0,
		createdAt: at(21 * DAY),
	},
	{
		id: "s3d_minio",
		name: "Lab MinIO",
		endpoint: "https://minio.lab.logical.it",
		region: "us-east-1",
		bucket: "scratch",
		prefix: "logistack",
		accessKeyId: "logistack-lab",
		forcePathStyle: true,
		usedBy: 0,
		createdAt: at(9 * DAY),
	},
];

const POSTGRES = "svc_storefront_production_postgres";

type Store = {
	services: Record<string, ServiceBackups>;
	schedules: Schedule[];
	scheduleRuns: Record<string, ScheduleRunDetail[]>;
};

function run(
	policyId: string,
	kind: BackupRun["kind"],
	minutesAgo: number,
	seconds: number,
	extra: Partial<BackupRun> = {},
): BackupRun {
	const started = now - minutesAgo * MIN;
	const ok = (extra.status ?? "succeeded") === "succeeded";
	return {
		id: rid("bkr"),
		policyId,
		kind,
		status: "succeeded",
		sizeBytes: null,
		objectKey:
			kind === "backup" && ok
				? `logistack/prod/storefront/postgres/${new Date(started).toISOString().slice(0, 16).replace(/[:T]/g, "-")}.dump.zst`
				: null,
		checksum: kind === "backup" && ok ? sha(minutesAgo) : null,
		startedAt: new Date(started).toISOString(),
		finishedAt: new Date(started + seconds * 1000).toISOString(),
		error: null,
		detail: null,
		sourceRunId: null,
		targetServiceId: null,
		prunedAt: null,
		...extra,
	};
}

/** Minutes since the most recent 03:00 Europe/Rome, so nightly runs land at plausible times. */
const lastNightly = (() => {
	const prev = new Date(nextRuns("0 3 * * *", "Europe/Rome", 1)[0] ?? now);
	return Math.round((now - (prev.getTime() - DAY * MIN)) / MIN);
})();

function storefrontPostgres(): ServiceBackups {
	const db = "bkp_sf_db";
	const vol = "bkp_sf_vol";
	const nightly = (d: number, size: number, secs: number, extra = {}) =>
		run(db, "backup", lastNightly + d * DAY, secs, {
			sizeBytes: size,
			...extra,
		});
	const runs: BackupRun[] = [
		nightly(0, 1.34 * GB, 138),
		run(db, "verify", lastNightly + 2 * DAY - 120, 212, {
			detail:
				"Restored into a scratch postgres:17.6; 48 tables, orders has 1,284,331 rows",
		}),
		nightly(1, 1.33 * GB, 141),
		run(vol, "backup", lastNightly + 2 * DAY - 90, 404, {
			sizeBytes: 4.82 * GB,
			objectKey: "volumes/storefront/postgres-data.tar.zst",
		}),
		nightly(2, 1.33 * GB, 136),
		nightly(3, 0, 31, {
			status: "failed",
			sizeBytes: null,
			error:
				'pg_dump: error: connection to server at "ls-svc-8f3a2c1d" (10.0.4.12), port 5432 failed: server closed the connection unexpectedly',
		}),
		nightly(4, 1.31 * GB, 133),
		run(db, "restore", lastNightly + 4 * DAY - 300, 266, {
			detail: "pg_restore into postgres-restore-oct-30",
			targetServiceId: "svc_storefront_production_postgres_restore",
		}),
		nightly(5, 1.3 * GB, 131),
		nightly(6, 1.3 * GB, 135),
		nightly(31, 1.18 * GB, 119, { prunedAt: at(lastNightly) }),
		nightly(32, 1.18 * GB, 121, { prunedAt: at(lastNightly) }),
	];
	const restoreRun = runs[7];
	const source = runs[9];
	if (restoreRun && source) restoreRun.sourceRunId = source.id;
	const policies: BackupPolicy[] = [
		{
			id: db,
			serviceId: POSTGRES,
			target: "database",
			volumeName: null,
			s3DestinationId: "s3d_r2",
			destinationName: "Backups · R2",
			cron: "0 3 * * *",
			timezone: "Europe/Rome",
			retention: { count: 14, days: 30 },
			verifyCron: "0 5 * * 0",
			pauseService: false,
			enabled: true,
			nextRunAt: nextRuns("0 3 * * *", "Europe/Rome", 1)[0] ?? null,
			nextVerifyAt: nextRuns("0 5 * * 0", "Europe/Rome", 1)[0] ?? null,
			lastRun: runs[0] ?? null,
			createdAt: at(90 * DAY),
		},
		{
			id: vol,
			serviceId: POSTGRES,
			target: "volume",
			volumeName: POSTGRES,
			s3DestinationId: "s3d_hetzner",
			destinationName: "Off-site · Falkenstein",
			cron: "30 4 * * 0",
			timezone: "Europe/Rome",
			retention: { count: 4 },
			verifyCron: null,
			pauseService: true,
			enabled: true,
			nextRunAt: nextRuns("30 4 * * 0", "Europe/Rome", 1)[0] ?? null,
			nextVerifyAt: null,
			lastRun: runs[3] ?? null,
			createdAt: at(60 * DAY),
		},
	];
	return {
		service: {
			id: POSTGRES,
			name: "postgres",
			kind: "database",
			engine: "postgres",
			version: "17.6",
		},
		volumes: [
			{ id: POSTGRES, label: "/var/lib/postgresql/data", kind: "data" },
		],
		policies,
		runs: runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
	};
}

const ENGINES = ["postgres", "mysql", "mariadb", "mongo", "redis"] as const;
const VERSIONS: Record<(typeof ENGINES)[number], string> = {
	postgres: "17.6",
	mysql: "8.4",
	mariadb: "11.8",
	mongo: "8.0",
	redis: "8.2",
};

/** Any other service: no policies yet, so the panel shows its empty state. */
function blank(id: string): ServiceBackups {
	const slug = id.split("_").at(-1) ?? "service";
	const engine = ENGINES.find((e) => slug.startsWith(e));
	return {
		service: {
			id,
			name: slug,
			kind: engine ? "database" : "application",
			engine: engine ?? null,
			version: engine ? VERSIONS[engine] : null,
		},
		volumes: engine
			? [{ id, label: `/data/${engine}`, kind: "data" }]
			: [{ id: `mnt_${slug}_uploads`, label: "/app/uploads", kind: "mount" }],
		policies: [],
		runs: [],
	};
}

function srun(
	scheduleId: string,
	minutesAgo: number,
	ms: number,
	extra: Partial<ScheduleRunDetail> = {},
): ScheduleRunDetail {
	const started = now - minutesAgo * MIN;
	const status = extra.status ?? "succeeded";
	return {
		id: rid("scr"),
		scheduleId,
		status,
		trigger: "cron",
		exitCode: status === "succeeded" ? 0 : status === "failed" ? 1 : null,
		outputBytes: status === "skipped" ? null : 2140,
		error: null,
		startedAt: new Date(started).toISOString(),
		finishedAt: new Date(started + ms).toISOString(),
		durationMs: ms,
		output: null,
		outputLimitBytes: MB,
		...extra,
	};
}

const VACUUM_OUT = `+ psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c 'VACUUM (ANALYZE, VERBOSE) orders'
INFO:  vacuuming "storefront.public.orders"
INFO:  finished vacuuming "storefront.public.orders": index scans: 1
pages: 0 removed, 48211 remain, 48211 scanned (100.00% of total)
tuples: 18402 removed, 1284331 remain, 0 are dead but not yet removable
INFO:  analyzing "public.orders"
INFO:  "orders": scanned 30000 of 48211 pages, containing 799214 live rows and 0 dead rows
VACUUM
+ psql "$DATABASE_URL" -c 'REINDEX TABLE CONCURRENTLY order_items'
REINDEX
done in 1m 42s
`;

const ROTATE_OUT = `+ find /var/log/caddy -name '*.log' -size +200M
/var/log/caddy/access-shop.acme-retail.it.log
/var/log/caddy/access-api.acme-retail.it.log
+ gzip -9 /var/log/caddy/access-shop.acme-retail.it.log
gzip: /var/log/caddy/access-shop.acme-retail.it.log: No space left on device
`;

const REPORT_OUT = `${Array.from(
	{ length: 40 },
	(_, i) =>
		`2026-10-${String((i % 28) + 1).padStart(2, "0")}  SKU-${4100 + i}  ${(13 + ((i * 37) % 90)).toFixed(2)} EUR  ${12 + ((i * 7) % 40)} units`,
).join("\n")}\n... output truncated\n`;

function schedule(
	s: Omit<
		Schedule,
		| "nextRunAt"
		| "lastRun"
		| "createdAt"
		| "updatedAt"
		| "timeoutS"
		| "concurrency"
		| "notifyOnFailure"
		| "enabled"
	> &
		Partial<Schedule>,
): Schedule {
	const enabled = s.enabled ?? true;
	return {
		timeoutS: 3600,
		concurrency: "forbid",
		notifyOnFailure: true,
		enabled,
		nextRunAt: enabled ? (nextRuns(s.cron, s.timezone, 1)[0] ?? null) : null,
		lastRun: null,
		createdAt: at(40 * DAY),
		updatedAt: at(3 * DAY),
		...s,
	};
}

function createStore(): Store {
	const schedules: Schedule[] = [
		schedule({
			id: "sch_vacuum",
			projectId: "prj_storefront",
			name: "Nightly VACUUM ANALYZE",
			cron: "15 2 * * *",
			timezone: "Europe/Rome",
			target: { kind: "service", serviceId: POSTGRES },
			script: `#!/bin/sh\nset -eu\n\n# Reclaim dead rows and refresh planner stats on the hot tables.\npsql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c 'VACUUM (ANALYZE, VERBOSE) orders'\npsql "$DATABASE_URL" -c 'REINDEX TABLE CONCURRENTLY order_items'\necho "done in $(date -u -d @$SECONDS +%-Mm\\ %-Ss)"\n`,
			timeoutS: 1800,
		}),
		schedule({
			id: "sch_carts",
			projectId: "prj_storefront",
			name: "Purge expired carts",
			cron: "*/30 * * * *",
			timezone: "UTC",
			target: { kind: "ephemeral", image: "postgres:17-alpine" },
			script: `#!/bin/sh\nset -eu\npsql "$DATABASE_URL" -c "DELETE FROM carts WHERE updated_at < now() - interval '14 days'"\n`,
			timeoutS: 300,
		}),
		schedule({
			id: "sch_logs",
			projectId: null,
			name: "Rotate proxy access logs",
			cron: "0 0 * * *",
			timezone: "UTC",
			target: { kind: "host", nodeId: "node_fra1" },
			script: `#!/bin/sh\nset -eux\nfor f in $(find /var/log/caddy -name '*.log' -size +200M); do\n  gzip -9 "$f"\ndone\n`,
			timeoutS: 900,
		}),
		schedule({
			id: "sch_report",
			projectId: "prj_backoffice",
			name: "Weekly sales report",
			cron: "0 7 * * 1",
			timezone: "Europe/Rome",
			target: { kind: "ephemeral", image: "python:3.13-slim" },
			script: `#!/bin/sh\nset -eu\npip install --quiet psycopg[binary]\npython - <<'PY'\nimport os, psycopg\nwith psycopg.connect(os.environ["DATABASE_URL"]) as db:\n    for row in db.execute("select day, sku, revenue, units from weekly_sales"):\n        print(*row, sep="  ")\nPY\n`,
			concurrency: "replace",
		}),
		schedule({
			id: "sch_cache",
			projectId: "prj_storefront",
			name: "Warm product cache",
			cron: "*/10 * * * *",
			timezone: "UTC",
			target: { kind: "service", serviceId: "svc_storefront_production_api" },
			script: `#!/bin/sh\ncurl -fsS -X POST http://localhost:8080/internal/cache/warm\n`,
			enabled: false,
			concurrency: "allow",
			notifyOnFailure: false,
		}),
	];
	const nightlyAgo = lastNightly - 45;
	const scheduleRuns: Record<string, ScheduleRunDetail[]> = {
		sch_vacuum: [
			srun("sch_vacuum", nightlyAgo, 102_000, {
				output: VACUUM_OUT,
				outputBytes: VACUUM_OUT.length,
			}),
			srun("sch_vacuum", nightlyAgo + DAY, 98_400, {
				output: VACUUM_OUT,
				outputBytes: VACUUM_OUT.length,
			}),
			srun("sch_vacuum", nightlyAgo + 2 * DAY, 1_800_000, {
				status: "failed",
				exitCode: 124,
				error: "Timed out after 30m; the container was stopped",
				output: `${VACUUM_OUT.split("\n").slice(0, 3).join("\n")}\n`,
				outputBytes: 212,
			}),
			srun("sch_vacuum", nightlyAgo + 3 * DAY, 104_100, {
				output: VACUUM_OUT,
				outputBytes: VACUUM_OUT.length,
			}),
			srun("sch_vacuum", nightlyAgo + 3 * DAY - 600, 0, {
				status: "skipped",
				trigger: "manual",
				durationMs: 0,
				error: "The previous run was still going (concurrency: forbid)",
			}),
			srun("sch_vacuum", nightlyAgo + 4 * DAY, 99_800, {
				output: VACUUM_OUT,
				outputBytes: VACUUM_OUT.length,
			}),
			srun("sch_vacuum", nightlyAgo + 5 * DAY, 101_300, {
				output: VACUUM_OUT,
				outputBytes: VACUUM_OUT.length,
			}),
		],
		sch_carts: Array.from({ length: 10 }, (_, i) =>
			srun("sch_carts", 12 + i * 30, 1800 + ((i * 431) % 900), {
				output: `DELETE ${40 + ((i * 13) % 70)}\n`,
				outputBytes: 10,
			}),
		),
		sch_logs: [
			srun("sch_logs", 600, 2300, {
				status: "failed",
				exitCode: 1,
				output: ROTATE_OUT,
				outputBytes: ROTATE_OUT.length,
			}),
			srun("sch_logs", 600 + DAY, 41_000, {
				output: "+ find /var/log/caddy -name '*.log' -size +200M\n",
				outputBytes: 51,
			}),
		],
		sch_report: [
			srun("sch_report", 2 * DAY + 300, 74_000, {
				output: REPORT_OUT,
				outputBytes: 3.4 * MB,
			}),
			srun("sch_report", 9 * DAY + 300, 71_000, {
				status: "cancelled",
				exitCode: null,
				error: "Replaced by a newer run (concurrency: replace)",
				output: REPORT_OUT.slice(0, 400),
				outputBytes: 400,
			}),
		],
		sch_cache: [],
	};
	for (const s of schedules) {
		const [last] = scheduleRuns[s.id] ?? [];
		if (last) {
			const { output: _o, outputLimitBytes: _l, ...view } = last;
			s.lastRun = view;
		}
	}
	return {
		services: { [POSTGRES]: storefrontPostgres() },
		schedules,
		scheduleRuns,
	};
}

const store = createStore();
const backupRuns = () => Object.values(store.services).flatMap((s) => s.runs);

const serviceOf = (id: string) => (store.services[id] ??= blank(id));

const stripDetail = ({
	output: _o,
	outputLimitBytes: _l,
	...r
}: ScheduleRunDetail): ScheduleRun => r;

function scheduleView(s: Schedule): Schedule {
	return {
		...s,
		nextRunAt: s.enabled ? (nextRuns(s.cron, s.timezone, 1)[0] ?? null) : null,
	};
}

/** Each simulated run ends here: the stored row settles, as the worker would leave it. */
function finishBackup(id: string, ok: boolean) {
	for (const svc of Object.values(store.services)) {
		const r = svc.runs.find((x) => x.id === id);
		if (r?.status !== "running") continue;
		r.status = ok ? "succeeded" : "failed";
		r.finishedAt = new Date().toISOString();
		if (r.kind === "backup") {
			r.sizeBytes = 1.35 * GB;
			r.checksum = sha(Date.now() % 9973);
			r.objectKey = `logistack/prod/${svc.service.name}/${r.startedAt.slice(0, 16)}.dump.zst`;
		}
		if (r.kind === "verify")
			r.detail =
				"Restored into a scratch container; 48 tables, orders has 1,284,509 rows";
		const policy = svc.policies.find((p) => p.id === r.policyId);
		if (policy) policy.lastRun = { ...r };
	}
}

const PHASES: Record<BackupRun["kind"], string[]> = {
	backup: ["Dumping", "Compressing", "Uploading"],
	verify: ["Downloading", "Restoring into a scratch container", "Checking"],
	restore: ["Downloading", "Stopping writers", "Restoring", "Starting"],
};

function simulateBackup(id: string, fn: (m: LiveMessage) => void) {
	const r = backupRuns().find((x) => x.id === id);
	const kind = r?.kind ?? "restore";
	const phases = PHASES[kind];
	const total = 1.34 * GB;
	const steps = 14;
	let i = 0;
	const t = setInterval(() => {
		i += 1;
		const phase =
			phases[
				Math.min(phases.length - 1, Math.floor((i / steps) * phases.length))
			] ?? "";
		const done = i >= steps;
		if (done) {
			finishBackup(id, true);
			clearInterval(t);
		}
		fn({
			kind: "progress",
			channel: backupRunChannel(id),
			phase: done ? "Finished" : phase,
			bytes: Math.min(total, (total * i) / steps),
			total: i < 3 && kind === "backup" ? null : total,
			done,
		});
	}, 450);
	return () => clearInterval(t);
}

function finishSchedule(id: string, output: string) {
	for (const [sid, runs] of Object.entries(store.scheduleRuns)) {
		const r = runs.find((x) => x.id === id);
		if (r?.status !== "running") continue;
		const finished = Date.now();
		r.status = "succeeded";
		r.exitCode = 0;
		r.finishedAt = new Date(finished).toISOString();
		r.durationMs = finished - new Date(r.startedAt).getTime();
		r.output = output;
		r.outputBytes = output.length;
		const s = store.schedules.find((x) => x.id === sid);
		if (s) s.lastRun = stripDetail(r);
	}
}

function simulateOutput(id: string, fn: (m: LiveMessage) => void) {
	const sid = Object.entries(store.scheduleRuns).find(([, runs]) =>
		runs.some((r) => r.id === id),
	)?.[0];
	const sample =
		(sid === "sch_vacuum" ? VACUUM_OUT : undefined) ??
		`+ echo "starting"\nstarting\n+ ./run.sh\nprocessed 128 rows\nprocessed 256 rows\nprocessed 384 rows\ndone\n`;
	const lines = sample.split(/(?<=\n)/);
	let i = 0;
	let sent = "";
	const t = setInterval(() => {
		const line = lines[i];
		i += 1;
		if (line === undefined) {
			finishSchedule(id, sent);
			clearInterval(t);
			return;
		}
		sent += line;
		fn({
			kind: "output",
			channel: scheduleRunChannel(id),
			stream: line.startsWith("+") ? "stderr" : "stdout",
			data: line,
		});
	}, 380);
	return () => clearInterval(t);
}

const notFound = (what: string) =>
	Promise.reject(new ApiError(404, `${what} not found`));

export const mockBackups: BackupsApi = {
	s3: {
		list: () => delay(destinations),
		test: (c) => {
			const host = (() => {
				try {
					return new URL(c.endpoint).hostname;
				} catch {
					return c.endpoint;
				}
			})();
			if (c.secretAccessKey.startsWith("wrong"))
				return delay(
					{
						ok: false,
						message: "The bucket refused the probe",
						detail:
							"SignatureDoesNotMatch: the secret access key does not match this access key",
					},
					1100,
				);
			if (c.bucket === "missing")
				return delay(
					{
						ok: false,
						message: "The bucket refused the probe",
						detail: `NoSuchBucket: ${c.bucket} does not exist on ${host}`,
					},
					900,
				);
			return delay(
				{
					ok: true,
					message: `Wrote, read and deleted a probe object in ${c.bucket}`,
					detail: `Round trip in ${180 + Math.round(Math.random() * 160)} ms via ${host}`,
				},
				1300,
			);
		},
		create: ({ secretAccessKey: _s, ...c }) => {
			const id = rid("s3d");
			destinations.push({
				id,
				name: c.name,
				endpoint: c.endpoint,
				region: c.region ?? "us-east-1",
				bucket: c.bucket,
				prefix: c.prefix ?? "",
				accessKeyId: c.accessKeyId,
				forcePathStyle: c.forcePathStyle ?? false,
				usedBy: 0,
				createdAt: new Date().toISOString(),
			});
			return delay({ id });
		},
		remove: (id) => {
			const d = destinations.find((x) => x.id === id);
			if (!d) return notFound("s3 destination");
			if (d.usedBy)
				return Promise.reject(
					new ApiError(
						409,
						`${d.usedBy} backup ${d.usedBy === 1 ? "policy writes" : "policies write"} here; move or delete ${d.usedBy === 1 ? "it" : "them"} first`,
						"conflict",
						{ usedBy: d.usedBy },
					),
				);
			destinations.splice(destinations.indexOf(d), 1);
			return delay(undefined);
		},
	},
	backups: {
		forService: (id) => delay(serviceOf(id)),
		createPolicy: (serviceId, input) => {
			const svc = serviceOf(serviceId);
			const dest = destinations.find((d) => d.id === input.s3DestinationId);
			if (!dest)
				return Promise.reject(new ApiError(400, "unknown destination"));
			dest.usedBy += 1;
			const timezone = input.timezone ?? "UTC";
			const verifyCron = input.verifyCron ?? null;
			const enabled = input.enabled ?? true;
			const policy: BackupPolicy = {
				id: rid("bkp"),
				serviceId,
				target: input.target,
				volumeName:
					input.target === "volume" ? (input.volumeName ?? null) : null,
				s3DestinationId: dest.id,
				destinationName: dest.name,
				cron: input.cron,
				timezone,
				retention: input.retention ?? { count: 7 },
				verifyCron,
				pauseService:
					input.target === "volume" && (input.pauseService ?? false),
				enabled,
				nextRunAt: enabled
					? (nextRuns(input.cron, timezone, 1)[0] ?? null)
					: null,
				nextVerifyAt:
					enabled && verifyCron
						? (nextRuns(verifyCron, timezone, 1)[0] ?? null)
						: null,
				lastRun: null,
				createdAt: new Date().toISOString(),
			};
			svc.policies.push(policy);
			return delay(policy);
		},
		updatePolicy: (id, patch) => {
			for (const svc of Object.values(store.services)) {
				const p = svc.policies.find((x) => x.id === id);
				if (!p) continue;
				Object.assign(p, patch);
				p.nextRunAt = p.enabled
					? (nextRuns(p.cron, p.timezone, 1)[0] ?? null)
					: null;
				return delay(p);
			}
			return notFound("backup policy");
		},
		removePolicy: (id) => {
			for (const svc of Object.values(store.services)) {
				const p = svc.policies.find((x) => x.id === id);
				if (!p) continue;
				svc.policies = svc.policies.filter((x) => x.id !== id);
				svc.runs = svc.runs.filter((r) => r.policyId !== id);
				const dest = destinations.find((d) => d.id === p.s3DestinationId);
				if (dest) dest.usedBy -= 1;
				return delay(undefined);
			}
			return notFound("backup policy");
		},
		run: (policyId, kind) => {
			const svc = Object.values(store.services).find((s) =>
				s.policies.some((p) => p.id === policyId),
			);
			if (!svc) return notFound("backup policy");
			const r: BackupRun = {
				...run(policyId, kind, 0, 0),
				status: "running",
				finishedAt: null,
				objectKey: null,
				checksum: null,
			};
			svc.runs.unshift(r);
			// Without a live socket the run still settles, so polling sees it finish.
			setTimeout(() => finishBackup(r.id, true), 9000);
			return delay(r);
		},
		getRun: (id) => {
			const r = backupRuns().find((x) => x.id === id);
			return r ? delay(r, 120) : notFound("backup run");
		},
		restore: (id, { target, confirm }) => {
			const svc = Object.values(store.services).find((s) =>
				s.runs.some((r) => r.id === id),
			);
			const source = svc?.runs.find((r) => r.id === id);
			if (!svc || !source) return notFound("backup run");
			const expected = target.kind === "same" ? svc.service.name : target.name;
			if (confirm !== expected)
				return Promise.reject(
					new ApiError(400, `type the service name "${expected}" to confirm`),
				);
			const targetServiceId =
				target.kind === "new" ? rid("svc") : svc.service.id;
			const r: BackupRun = {
				...run(source.policyId, "restore", 0, 0),
				status: "running",
				finishedAt: null,
				sourceRunId: id,
				targetServiceId,
				detail: target.kind === "new" ? `pg_restore into ${target.name}` : null,
			};
			svc.runs.unshift(r);
			setTimeout(() => finishBackup(r.id, true), 9000);
			return delay({ run: r, targetServiceId });
		},
	},
	schedules: {
		list: () => delay(store.schedules.map(scheduleView)),
		get: (id) => {
			const s = store.schedules.find((x) => x.id === id);
			if (!s) return notFound("schedule");
			return delay({
				...scheduleView(s),
				runs: (store.scheduleRuns[id] ?? []).map(stripDetail),
			});
		},
		create: (input) => {
			const s = schedule({
				id: rid("sch"),
				projectId: input.projectId ?? null,
				name: input.name,
				cron: input.cron,
				timezone: input.timezone ?? "UTC",
				script: input.script,
				target: input.target ?? { kind: "ephemeral", image: "alpine:3.22" },
				timeoutS: input.timeoutS ?? 3600,
				concurrency: input.concurrency ?? "forbid",
				notifyOnFailure: input.notifyOnFailure ?? true,
				enabled: input.enabled ?? true,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			});
			store.schedules.push(s);
			store.schedules.sort((a, b) => a.name.localeCompare(b.name));
			store.scheduleRuns[s.id] = [];
			return delay(s);
		},
		update: (id, patch) => {
			const s = store.schedules.find((x) => x.id === id);
			if (!s) return notFound("schedule");
			Object.assign(s, patch, { updatedAt: new Date().toISOString() });
			return delay(scheduleView(s));
		},
		remove: (id) => {
			store.schedules = store.schedules.filter((s) => s.id !== id);
			delete store.scheduleRuns[id];
			return delay(undefined);
		},
		run: (id) => {
			const s = store.schedules.find((x) => x.id === id);
			if (!s) return notFound("schedule");
			const runs = store.scheduleRuns[id] ?? [];
			store.scheduleRuns[id] = runs;
			const busy = runs.some((r) => r.status === "running");
			const r: ScheduleRunDetail = {
				...srun(id, 0, 0),
				trigger: "manual",
				status: busy && s.concurrency === "forbid" ? "skipped" : "running",
				exitCode: null,
				outputBytes: null,
				finishedAt:
					busy && s.concurrency === "forbid" ? new Date().toISOString() : null,
				durationMs: busy && s.concurrency === "forbid" ? 0 : null,
				error:
					busy && s.concurrency === "forbid"
						? "The previous run was still going (concurrency: forbid)"
						: null,
			};
			runs.unshift(r);
			s.lastRun = stripDetail(r);
			if (r.status === "running")
				setTimeout(() => finishSchedule(r.id, "done\n"), 12_000);
			return delay(stripDetail(r));
		},
		getRun: (id) => {
			const r = Object.values(store.scheduleRuns)
				.flat()
				.find((x) => x.id === id);
			return r ? delay(r, 120) : notFound("schedule run");
		},
	},
	live: (channel, fn) => {
		const [kind, id = ""] = channel.split(":");
		if (kind === "backup-run") return simulateBackup(id, fn);
		if (kind === "schedule-run") return simulateOutput(id, fn);
		return () => {};
	},
};

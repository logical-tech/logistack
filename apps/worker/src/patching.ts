import {
	NODE_OPS_CHANNEL,
	type PackageManager,
	type PackageUpdate,
	type PatchRunNode,
	type PatchStep,
} from "@logistack/contracts";
import {
	BOOT_ID_COMMAND,
	currentPatchNode,
	newerKernelInstalled,
	nextPatchStep,
	PATCH_ENV,
	packageManagerFor,
	parseAptSimulate,
	parseBootId,
	parseDnfCheckUpdate,
	parseDnfSecurity,
	parseOsRelease,
	scanCommands,
	upgradeCommands,
} from "@logistack/core";
import {
	type Db,
	node,
	nodePatchStatus,
	patchPolicy,
	patchRun,
} from "@logistack/db";
import { managedLabels } from "@logistack/docker";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Bus } from "./bus.ts";
import { log } from "./bus.ts";
import type { Ctx } from "./ctx.ts";
import { tail } from "./node-runner.ts";

// OS patching of nodes. Every host command is an argv run as root on the host through the node's
// agent (`nsenter` into PID 1 from a privileged, host-PID job container); never a shell string.
// A run's progress lives in `patch_run`, so a worker that dies (even on the leader it rebooted)
// leaves a run another worker, or itself after the boot, picks up at the step it reached.

export type HostResult = {
	code: number | null;
	stdout: string;
	stderr: string;
};

export type PatchHost = {
	run(
		argv: string[],
		o?: { timeoutSec?: number; onLine?: (line: string) => void },
	): Promise<HostResult>;
	/** Asks the host to reboot; returns as soon as it was asked. */
	reboot(): Promise<void>;
};

export type PatchNode = typeof node.$inferSelect;

/** What a run needs from the cluster; the worker's are in `clusterDeps`, a test brings its own. */
export type PatchDeps = {
	host(n: PatchNode): PatchHost;
	setAvailability(n: PatchNode, a: "active" | "drain"): Promise<void>;
	/** Tasks of replicated services still running on the node. */
	tasksLeft(n: PatchNode): Promise<number>;
	/** The agent answers and Swarm counts the node ready. */
	online(n: PatchNode): Promise<boolean>;
	/** Services running fewer tasks than they want, by name. */
	unhealthy(): Promise<string[]>;
	sleep(ms: number): Promise<void>;
	pollMs: number;
	timeouts: {
		drainMs: number;
		rejoinMs: number;
		healthyMs: number;
		upgradeSec: number;
	};
};

export type ScanResult = {
	packageManager: PackageManager;
	os: string | null;
	kernel: string;
	rebootRequired: boolean;
	updates: PackageUpdate[];
};

class HostFailed extends Error {
	override name = "HostFailed";
}

async function must(
	host: PatchHost,
	argv: string[],
	o: { timeoutSec?: number; onLine?: (l: string) => void; ok?: number[] } = {},
): Promise<HostResult> {
	const r = await host.run(argv, o);
	if (r.code === null || !(o.ok ?? [0]).includes(r.code))
		throw new HostFailed(
			`${argv.join(" ")} exited ${r.code}: ${tail((r.stderr || r.stdout).trim(), 600)}`,
		);
	return r;
}

/** Refreshes the package index and reads what an upgrade would change; changes nothing installed. */
export async function scanHost(host: PatchHost): Promise<ScanResult> {
	const os = parseOsRelease(
		(await must(host, ["cat", "/etc/os-release"])).stdout,
	);
	const pm = packageManagerFor(os);
	if (!pm)
		throw new HostFailed(
			`${os.pretty ?? (os.id || "this OS")} has no supported package manager (apt or dnf)`,
		);
	const kernel = (await must(host, ["uname", "-r"])).stdout.trim();
	const cmds = scanCommands(pm);
	await must(host, cmds.refresh, { timeoutSec: 600 });
	// dnf check-update exits 100 when updates are available.
	const list = await must(host, cmds.list, {
		timeoutSec: 600,
		ok: pm === "dnf" ? [0, 100] : [0],
	});
	let updates: PackageUpdate[];
	if (pm === "apt") updates = parseAptSimulate(list.stdout);
	else {
		const sec = cmds.security
			? await host.run(cmds.security, { timeoutSec: 600 })
			: undefined;
		updates = parseDnfCheckUpdate(
			list.stdout,
			sec?.code === 0 ? parseDnfSecurity(sec.stdout) : new Set(),
		);
	}
	const flag =
		pm === "apt"
			? (await host.run(["test", "-e", "/var/run/reboot-required"])).code === 0
			: (await host.run(["needs-restarting", "-r"])).code === 1;
	const boot = await host.run(["ls", "-1", "/boot"]);
	return {
		packageManager: pm,
		os: os.pretty,
		kernel,
		rebootRequired:
			flag || (boot.code === 0 && newerKernelInstalled(kernel, boot.stdout)),
		updates,
	};
}

/** Stores a scan (or its failure) and returns the security updates it found that the last one had not. */
export async function saveScan(
	db: Db,
	nodeId: string,
	result: ScanResult | { error: string },
): Promise<PackageUpdate[]> {
	const [before] = await db
		.select({ updates: nodePatchStatus.updates })
		.from(nodePatchStatus)
		.where(eq(nodePatchStatus.nodeId, nodeId));
	const values =
		"error" in result
			? { nodeId, error: result.error }
			: {
					nodeId,
					...result,
					securityCount: result.updates.filter((u) => u.security).length,
					scannedAt: new Date(),
					error: null,
				};
	await db
		.insert(nodePatchStatus)
		.values(values)
		.onConflictDoUpdate({ target: nodePatchStatus.nodeId, set: values });
	if ("error" in result) return [];
	const seen = new Set(
		(before?.updates ?? [])
			.filter((u) => u.security)
			.map((u) => `${u.name}@${u.to}`),
	);
	return result.updates.filter(
		(u) => u.security && !seen.has(`${u.name}@${u.to}`),
	);
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Scans one node, stores the result, and raises `node.patches_available` for new security updates. */
export async function scanNode(
	ctx: { db: Db; bus: Pick<Bus, "publish"> },
	deps: Pick<PatchDeps, "host">,
	n: PatchNode,
): Promise<void> {
	let result: ScanResult | { error: string };
	try {
		result = await scanHost(deps.host(n));
	} catch (e) {
		result = { error: errMsg(e) };
	}
	const fresh = await saveScan(ctx.db, n.id, result);
	if (fresh.length)
		await ctx.bus.publish(
			"node.patches_available",
			n.organizationId,
			{ type: "node", id: n.id },
			{
				node: n.hostname,
				message: `${fresh.length} new security update${fresh.length === 1 ? "" : "s"}: ${fresh
					.slice(0, 8)
					.map((u) => u.name)
					.join(", ")}${fresh.length > 8 ? ", …" : ""}`,
			},
		);
}

type RunRow = typeof patchRun.$inferSelect;

/** A claimed run left without a heartbeat this long belongs to a dead worker. */
const STALE = "3 minutes";
const HEARTBEAT_MS = 30_000;

/** Atomically takes one queued (or abandoned) run; one run per organization at a time. */
export async function claimRun(db: Db): Promise<RunRow | undefined> {
	const rows = await db.execute<{ id: string }>(sql`
		update patch_run set state = 'running', claimed_at = now(), updated_at = now()
		where id = (
			select r.id from patch_run r
			where (r.state = 'queued' and not exists (
					select 1 from patch_run o where o.organization_id = r.organization_id and o.state = 'running'))
				or (r.state = 'running' and r.claimed_at < now() - ${STALE}::interval)
			order by r.created_at limit 1 for update skip locked
		)
		returning id`);
	const id = rows[0]?.id;
	if (!id) return undefined;
	const [row] = await db.select().from(patchRun).where(eq(patchRun.id, id));
	return row;
}

class Cancelled extends Error {}

/**
 * Drives a claimed run to its end: each node in order, step by step, persisting after every step.
 * A failed node stops the run; the nodes after it are skipped, never left drained.
 */
export async function processRun(
	ctx: { db: Db; bus: Pick<Bus, "publish"> },
	deps: PatchDeps,
	run: RunRow,
): Promise<void> {
	const { db } = ctx;
	const nodes = run.nodes.map((n) => ({ ...n }));
	const save = (extra: Partial<RunRow> = {}) =>
		db
			.update(patchRun)
			.set({ nodes, claimedAt: new Date(), ...extra })
			.where(eq(patchRun.id, run.id));
	const line = async (text: string) => {
		const stamped = `${new Date().toISOString().slice(11, 19)} ${text}`;
		await db
			.update(patchRun)
			.set({
				log: sql`${patchRun.log} || ${JSON.stringify([stamped])}::jsonb`,
			})
			.where(eq(patchRun.id, run.id));
	};
	const cancelled = async () => {
		const [r] = await db
			.select({ c: patchRun.cancelRequested })
			.from(patchRun)
			.where(eq(patchRun.id, run.id));
		return r?.c ?? false;
	};
	const heartbeat = setInterval(
		() =>
			void db
				.update(patchRun)
				.set({ claimedAt: new Date() })
				.where(eq(patchRun.id, run.id))
				.catch(() => {}),
		HEARTBEAT_MS,
	);
	try {
		for (
			let cur = currentPatchNode(nodes);
			cur;
			cur = currentPatchNode(nodes)
		) {
			const [row] = await db.select().from(node).where(eq(node.id, cur.nodeId));
			if (!row || row.desired === "remove") {
				Object.assign(cur, {
					state: "skipped",
					error: row ? "the node is being removed" : "the node is gone",
					finishedAt: new Date(),
				});
				await line(`${cur.hostname}: skipped, ${cur.error}`);
				await save();
				continue;
			}
			if (cur.state === "pending")
				Object.assign(cur, {
					state: "running",
					step: "scan",
					startedAt: new Date(),
					wasDrained: row.desired === "drain",
				});
			await save();
			try {
				await patchNode(db, deps, run, row, cur, save, line, cancelled);
				Object.assign(cur, {
					state: "succeeded",
					error: null,
					finishedAt: new Date(),
				});
				await line(`${cur.hostname}: patched`);
				await save();
			} catch (e) {
				const stop = e instanceof Cancelled;
				const error = stop ? "cancelled" : errMsg(e);
				Object.assign(cur, {
					state: stop ? "skipped" : "failed",
					error,
					finishedAt: new Date(),
				});
				await line(`${cur.hostname}: ${error}`);
				// Never leave a node drained by us, whatever stopped the run.
				if (!cur.wasDrained)
					await deps.setAvailability(row, "active").catch(() => {});
				for (const n of nodes)
					if (n.state === "pending")
						Object.assign(n, {
							state: "skipped",
							error: stop ? "cancelled" : "an earlier node failed",
						});
				if (stop)
					return void (await save({
						state: "cancelled",
						error: "cancelled",
						finishedAt: new Date(),
					}));
				await save();
				break;
			}
		}
		const failed = nodes.find((n) => n.state === "failed");
		await save({
			state: failed ? "failed" : "succeeded",
			error: failed ? `${failed.hostname}: ${failed.error}` : null,
			finishedAt: new Date(),
		});
		const done = nodes.filter((n) => n.state === "succeeded");
		await ctx.bus.publish(
			failed ? "node.patch_failed" : "node.patch_succeeded",
			run.organizationId,
			{ type: "patch_run", id: run.id },
			{
				node: (failed ? [failed] : done).map((n) => n.hostname).join(", "),
				message: failed
					? `${failed.hostname} failed at ${failed.step}: ${failed.error}`
					: `${done.length} node${done.length === 1 ? "" : "s"} patched, ${done.reduce((s, n) => s + n.upgraded, 0)} packages upgraded`,
			},
		);
	} finally {
		clearInterval(heartbeat);
	}
}

/** Waits until `ready()` returns true or `ms` passes; checks for a cancel between polls. */
async function until(
	deps: PatchDeps,
	ms: number,
	ready: () => Promise<boolean>,
	what: string,
	cancelled: () => Promise<boolean>,
) {
	const deadline = Date.now() + ms;
	for (;;) {
		if (await ready().catch(() => false)) return;
		if (await cancelled()) throw new Cancelled("cancelled");
		if (Date.now() > deadline)
			throw new Error(`gave up after ${Math.round(ms / 60_000)} min ${what}`);
		await deps.sleep(deps.pollMs);
	}
}

async function patchNode(
	db: Db,
	deps: PatchDeps,
	run: RunRow,
	row: PatchNode,
	cur: PatchRunNode,
	save: () => Promise<unknown>,
	line: (t: string) => Promise<void>,
	cancelled: () => Promise<boolean>,
): Promise<void> {
	const host = deps.host(row);
	const leader = row.facts.leader ?? false;
	let scan: ScanResult | undefined;
	const rescan = async () => {
		scan = await scanHost(host);
		await saveScan(db, row.id, scan);
		return scan;
	};
	for (let step: PatchStep | null = cur.step ?? "scan"; step; ) {
		if (await cancelled()) throw new Cancelled("cancelled");
		cur.step = step;
		await save();
		switch (step) {
			case "scan": {
				const s = await rescan();
				const n = run.securityOnly
					? s.updates.filter((u) => u.security).length
					: s.updates.length;
				await line(
					`${row.hostname}: ${s.os ?? s.packageManager}, kernel ${s.kernel}, ${n} ${run.securityOnly ? "security " : ""}update${n === 1 ? "" : "s"}${s.rebootRequired ? ", reboot pending" : ""}`,
				);
				break;
			}
			case "drain":
				if (leader)
					await line(
						`${row.hostname}: the leader runs LogiStack and is not drained; its services stay where they are`,
					);
				else if (cur.wasDrained) await line(`${row.hostname}: already drained`);
				else {
					await line(`${row.hostname}: draining`);
					await deps.setAvailability(row, "drain");
					await until(
						deps,
						deps.timeouts.drainMs,
						async () => (await deps.tasksLeft(row)) === 0,
						"waiting for tasks to leave the node",
						cancelled,
					);
					await line(`${row.hostname}: drained`);
				}
				break;
			case "upgrade": {
				const s = scan ?? (await rescan());
				const cmds = upgradeCommands(s.packageManager, {
					securityOnly: run.securityOnly,
					updates: s.updates,
				});
				for (const argv of cmds) {
					await line(`${row.hostname}: ${argv.join(" ")}`);
					await must(host, argv, { timeoutSec: deps.timeouts.upgradeSec });
				}
				const after = await rescan();
				cur.upgraded = Math.max(0, s.updates.length - after.updates.length);
				await line(
					`${row.hostname}: ${cur.upgraded} package${cur.upgraded === 1 ? "" : "s"} upgraded${after.rebootRequired ? ", reboot required" : ""}`,
				);
				break;
			}
			case "reboot":
				cur.bootId = parseBootId((await must(host, BOOT_ID_COMMAND)).stdout);
				cur.rebootAt = new Date();
				// Saved before asking: on the leader this worker may not live to save anything after.
				cur.step = "rejoin";
				await save();
				await line(`${row.hostname}: rebooting`);
				await host.reboot().catch(() => {});
				cur.rebooted = true;
				step = "rejoin";
				continue;
			case "rejoin":
				await until(
					deps,
					deps.timeouts.rejoinMs,
					async () => {
						const r = await host.run(BOOT_ID_COMMAND);
						return (
							r.code === 0 &&
							parseBootId(r.stdout) !== cur.bootId &&
							(await deps.online(row))
						);
					},
					"waiting for the node to come back",
					cancelled,
				);
				cur.rebooted = true;
				await rescan();
				await line(
					`${row.hostname}: back after the reboot, kernel ${scan?.kernel}`,
				);
				break;
			case "healthy":
				await until(
					deps,
					deps.timeouts.healthyMs,
					async () => (await deps.unhealthy()).length === 0,
					"waiting for every service to run its tasks",
					cancelled,
				);
				await line(`${row.hostname}: every service runs its tasks`);
				break;
			case "undrain":
				if (!cur.wasDrained && !leader) {
					await deps.setAvailability(row, "active");
					await line(`${row.hostname}: active again`);
				}
				break;
		}
		step = nextPatchStep(step, {
			reboot: run.reboot,
			rebootRequired: scan?.rebootRequired ?? false,
		});
	}
}

/** The production dependencies: the node's agent for host commands, Swarm for drain and health. */
export function clusterDeps(ctx: Ctx): PatchDeps {
	const presence = async (swarmNodeId: string) =>
		Boolean(await ctx.bus.redis.get(`ls:nodes:${swarmNodeId}`));
	return {
		host: (n) => agentHost(ctx, n),
		async setAvailability(n, a) {
			await ctx.db.update(node).set({ desired: a }).where(eq(node.id, n.id));
			await ctx.bus.redis.publish(NODE_OPS_CHANNEL, "patch");
		},
		async tasksLeft(n) {
			const services = await ctx.docker.services.list();
			const global = new Set(
				services
					.filter((s) => s.Spec.Mode && "Global" in s.Spec.Mode)
					.map((s) => s.ID),
			);
			const tasks = await ctx.docker.tasks.list({
				node: [n.swarmNodeId],
				"desired-state": ["running"],
			});
			return tasks.filter(
				(t) => !global.has(t.ServiceID) && t.Status.State === "running",
			).length;
		},
		async online(n) {
			if (!(await presence(n.swarmNodeId))) return false;
			const dn = await ctx.docker.nodes.inspect(n.swarmNodeId);
			return dn.Status.State === "ready";
		},
		unhealthy: () =>
			unhealthyServices(ctx.docker, { label: ["logistack.managed=true"] }),
		sleep: Bun.sleep,
		pollMs: 5_000,
		timeouts: {
			drainMs: 10 * 60_000,
			rejoinMs: 20 * 60_000,
			healthyMs: 10 * 60_000,
			upgradeSec: 3_600,
		},
	};
}

/** Replicated services below their wanted task count. */
export async function unhealthyServices(
	docker: Pick<Ctx["docker"], "services">,
	filters: Record<string, string[]>,
): Promise<string[]> {
	return (await docker.services.list(filters))
		.filter(
			(s) =>
				s.Spec.Mode &&
				"Replicated" in s.Spec.Mode &&
				s.ServiceStatus &&
				s.ServiceStatus.RunningTasks < s.ServiceStatus.DesiredTasks,
		)
		.map((s) => s.Spec.Name);
}

/** Host commands through the node's agent: argv after `nsenter` into PID 1's namespaces. */
export function agentHost(ctx: Ctx, n: PatchNode): PatchHost {
	const run: PatchHost["run"] = async (argv, o = {}) => {
		const job = ctx.nodes.runJob(n.swarmNodeId, {
			kind: "container",
			image: ctx.cfg.LS_BACKUP_TOOLS_IMAGE,
			containerName: `ls-patch-${crypto.randomUUID().slice(0, 13)}`,
			labels: managedLabels({
				resource: n.id,
				kind: "system",
				org: n.organizationId,
			}),
			host: true,
			cmd: ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", ...argv],
			env: PATCH_ENV,
			timeoutSec: o.timeoutSec ?? 120,
			outputLimitBytes: 8 * 1024 * 1024,
		});
		const dec = { stdout: new TextDecoder(), stderr: new TextDecoder() };
		const out = { stdout: "", stderr: "" };
		for await (const c of job) {
			const text = dec[c.stream].decode(c.data, { stream: true });
			out[c.stream] += text;
			if (o.onLine) for (const l of text.split("\n")) if (l) o.onLine(l);
		}
		const r = await job.result;
		return { code: r.exitCode, ...out };
	};
	return {
		run,
		async reboot() {
			// The job may never report back: the host goes down under it.
			await run(["systemctl", "reboot"], { timeoutSec: 30 }).catch(() => {});
		},
	};
}

/** Scans every node whose agent is connected; one pass at a time across replicas (caller locks). */
export async function scanAll(ctx: Ctx): Promise<void> {
	const deps = clusterDeps(ctx);
	const rows = await ctx.db.select().from(node).orderBy(asc(node.hostname));
	for (const n of rows) {
		if (n.desired === "remove") continue;
		if (!(await ctx.bus.redis.get(`ls:nodes:${n.swarmNodeId}`))) continue;
		await scanNode(ctx, deps, n).catch((e) =>
			log("warn", "patch scan failed", { node: n.id, error: errMsg(e) }),
		);
	}
}

/** Queues a rolling run over every node of the organization, as its patch window says. */
export async function queueWindowRun(ctx: Ctx, organizationId: string) {
	const [policy] = await ctx.db
		.select()
		.from(patchPolicy)
		.where(eq(patchPolicy.organizationId, organizationId));
	if (!policy?.enabled) return;
	const rows = await ctx.db
		.select()
		.from(node)
		.where(
			and(eq(node.organizationId, organizationId), eq(node.desired, "active")),
		)
		.orderBy(asc(node.role), asc(node.hostname));
	// Workers first, the leader last: rebooting it restarts LogiStack itself.
	rows.sort(
		(a, b) => Number(a.facts.leader ?? false) - Number(b.facts.leader ?? false),
	);
	if (!rows.length) return;
	await ctx.db.insert(patchRun).values({
		organizationId,
		trigger: "window",
		securityOnly: policy.securityOnly,
		reboot: policy.reboot,
		nodes: rows.map(newRunNode),
	});
	log("info", "patch window run queued", {
		organizationId,
		nodes: rows.length,
	});
}

export const newRunNode = (n: {
	id: string;
	hostname: string;
}): PatchRunNode => ({
	nodeId: n.id,
	hostname: n.hostname,
	state: "pending",
	step: null,
	error: null,
	upgraded: 0,
	rebooted: false,
	wasDrained: false,
	bootId: null,
	rebootAt: null,
	startedAt: null,
	finishedAt: null,
});

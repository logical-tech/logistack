import type {
	ThresholdEventPayload,
	ThresholdMetric,
} from "@logistack/contracts";
import type { Bus } from "./bus.ts";
import type { Sql } from "./metrics-store.ts";

/** Emits only on a crossing; a first evaluation that is already firing counts as one. */
export function transition(
	wasFiring: boolean | undefined,
	value: number,
	percent: number,
): { firing: boolean; emit: "firing" | "resolved" | undefined } {
	const firing = value > percent;
	if (firing === (wasFiring ?? false)) return { firing, emit: undefined };
	return { firing, emit: firing ? "firing" : "resolved" };
}

const EXPR: Record<ThresholdMetric, string> = {
	cpu: "avg(cpu)",
	memory: "100 * avg(mem_used) / nullif(max(mem_total), 0)",
	disk: "100 * avg(disk_used) / nullif(max(disk_total), 0)",
};

type Row = {
	threshold_id: string;
	organization_id: string;
	metric: ThresholdMetric;
	percent: number;
	for_sec: number;
	swarm_node_id: string;
	hostname: string;
	node_id: string;
	firing: boolean | null;
};

/**
 * Averages each enabled threshold's metric over its window of raw samples, per node, and
 * publishes `metric.threshold` when the average crosses the limit in either direction. A node
 * with no samples in the window is skipped: silence is `node.down`'s job, not this one's.
 */
export async function evaluateThresholds(
	sql: Sql,
	bus: Pick<Bus, "publish">,
): Promise<ThresholdEventPayload[]> {
	const rows = await sql<Row[]>`
		select t.id as threshold_id, t.organization_id, t.metric, t.percent, t.for_sec,
			n.swarm_node_id, n.hostname, n.id as node_id, a.firing
		from metric_threshold t
		join node n on n.organization_id = t.organization_id
			and (t.node_id is null or t.node_id = n.id)
		left join metric_alert a on a.threshold_id = t.id and a.swarm_node_id = n.swarm_node_id
		where t.enabled`;
	const emitted: ThresholdEventPayload[] = [];
	for (const r of rows) {
		const [sample] = await sql.unsafe<{ value: number | null }[]>(
			`select ${EXPR[r.metric]} as value from metric_host_raw
			where node_id = $1 and ts > now() - make_interval(secs => $2)`,
			[r.swarm_node_id, r.for_sec],
		);
		if (sample?.value == null) continue;
		const value = Number(sample.value);
		const { firing, emit } = transition(
			r.firing ?? undefined,
			value,
			r.percent,
		);
		await sql`
			insert into metric_alert (threshold_id, swarm_node_id, firing, value)
			values (${r.threshold_id}, ${r.swarm_node_id}, ${firing}, ${value})
			on conflict (threshold_id, swarm_node_id) do update set
				value = excluded.value, firing = excluded.firing,
				changed_at = case when metric_alert.firing = excluded.firing
					then metric_alert.changed_at else now() end`;
		if (!emit) continue;
		const payload: ThresholdEventPayload = {
			thresholdId: r.threshold_id,
			nodeId: r.node_id,
			hostname: r.hostname,
			metric: r.metric,
			state: emit,
			value: Math.round(value * 10) / 10,
			percent: r.percent,
			forSec: r.for_sec,
		};
		await bus.publish(
			"metric.threshold",
			r.organization_id,
			{ type: "node", id: r.node_id },
			payload,
		);
		emitted.push(payload);
	}
	return emitted;
}

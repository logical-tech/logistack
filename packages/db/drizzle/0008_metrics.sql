-- Metric samples, range-partitioned by UTC day. `node_id` is the Swarm node id the agent reports.
-- Raw rows keep the agent's cumulative network/block counters; rollups store per-second rates.
CREATE TABLE "metric_host_raw" (
	"node_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"cpu" real NOT NULL,
	"load1" real NOT NULL,
	"mem_used" bigint NOT NULL,
	"mem_total" bigint NOT NULL,
	"disk_used" bigint NOT NULL,
	"disk_total" bigint NOT NULL,
	"net_rx" bigint NOT NULL,
	"net_tx" bigint NOT NULL,
	PRIMARY KEY ("node_id", "ts")
) PARTITION BY RANGE ("ts");
--> statement-breakpoint
CREATE TABLE "metric_container_raw" (
	"node_id" text NOT NULL,
	"container_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"service_id" text,
	"name" text NOT NULL,
	"cpu" real NOT NULL,
	"mem_used" bigint NOT NULL,
	"mem_limit" bigint NOT NULL,
	"net_rx" bigint NOT NULL,
	"net_tx" bigint NOT NULL,
	"blk_read" bigint NOT NULL,
	"blk_write" bigint NOT NULL,
	PRIMARY KEY ("node_id", "container_id", "ts")
) PARTITION BY RANGE ("ts");
--> statement-breakpoint
CREATE INDEX "metric_container_raw_service_idx" ON "metric_container_raw" ("service_id", "ts") WHERE "service_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "metric_container_raw_container_idx" ON "metric_container_raw" ("container_id", "ts");
--> statement-breakpoint
CREATE TABLE "metric_host_1m" (
	"node_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"cpu" real NOT NULL,
	"cpu_max" real NOT NULL,
	"load1" real NOT NULL,
	"mem_used" bigint NOT NULL,
	"mem_total" bigint NOT NULL,
	"disk_used" bigint NOT NULL,
	"disk_total" bigint NOT NULL,
	"rx" double precision,
	"tx" double precision,
	"samples" integer NOT NULL,
	PRIMARY KEY ("node_id", "ts")
) PARTITION BY RANGE ("ts");
--> statement-breakpoint
CREATE TABLE "metric_container_1m" (
	"node_id" text NOT NULL,
	"container_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"service_id" text,
	"name" text NOT NULL,
	"cpu" real NOT NULL,
	"cpu_max" real NOT NULL,
	"mem_used" bigint NOT NULL,
	"mem_limit" bigint NOT NULL,
	"rx" double precision,
	"tx" double precision,
	"read" double precision,
	"write" double precision,
	"samples" integer NOT NULL,
	PRIMARY KEY ("node_id", "container_id", "ts")
) PARTITION BY RANGE ("ts");
--> statement-breakpoint
CREATE INDEX "metric_container_1m_service_idx" ON "metric_container_1m" ("service_id", "ts") WHERE "service_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "metric_container_1m_container_idx" ON "metric_container_1m" ("container_id", "ts");
--> statement-breakpoint
-- Hourly rollups are small (one row per node or container per hour); retention deletes rows.
CREATE TABLE "metric_host_1h" (LIKE "metric_host_1m" INCLUDING DEFAULTS, PRIMARY KEY ("node_id", "ts"));
--> statement-breakpoint
CREATE TABLE "metric_container_1h" (LIKE "metric_container_1m" INCLUDING DEFAULTS, PRIMARY KEY ("node_id", "container_id", "ts"));
--> statement-breakpoint
CREATE INDEX "metric_container_1h_service_idx" ON "metric_container_1h" ("service_id", "ts") WHERE "service_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "metric_container_1h_container_idx" ON "metric_container_1h" ("container_id", "ts");
--> statement-breakpoint
CREATE INDEX "metric_host_1h_ts_idx" ON "metric_host_1h" ("ts");
--> statement-breakpoint
CREATE INDEX "metric_container_1h_ts_idx" ON "metric_container_1h" ("ts");
--> statement-breakpoint
-- Idempotent: creates `<parent>_YYYYMMDD` for every UTC day in [from_day, to_day] that is missing.
CREATE FUNCTION "metric_ensure_partitions"(parent text, from_day date, to_day date) RETURNS void AS $$
DECLARE d date := from_day;
BEGIN
	WHILE d <= to_day LOOP
		EXECUTE format(
			'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
			parent || '_' || to_char(d, 'YYYYMMDD'),
			parent,
			d::timestamp AT TIME ZONE 'UTC',
			(d + 1)::timestamp AT TIME ZONE 'UTC'
		);
		d := d + 1;
	END LOOP;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
SELECT "metric_ensure_partitions"(p, (now() AT TIME ZONE 'UTC')::date - 1, (now() AT TIME ZONE 'UTC')::date + 2)
FROM unnest(ARRAY['metric_host_raw', 'metric_container_raw', 'metric_host_1m', 'metric_container_1m']) AS p;

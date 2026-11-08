ALTER TABLE "domain" ADD COLUMN "web_analytics" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Traffic aggregates from the agents, one row per node, domain and minute; a resent minute replaces its row.
-- No raw IP or visitor hash is stored: `visitors` is a HyperLogLog sketch (packages/core/src/traffic.ts).
CREATE TABLE "traffic_1m" (
	"node_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"service_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"requests" integer NOT NULL,
	"s1" integer NOT NULL,
	"s2" integer NOT NULL,
	"s3" integer NOT NULL,
	"s4" integer NOT NULL,
	"s5" integer NOT NULL,
	"bytes_in" bigint NOT NULL,
	"bytes_out" bigint NOT NULL,
	"pageviews" integer NOT NULL,
	"bots" integer NOT NULL,
	"latency" jsonb NOT NULL,
	"paths" jsonb NOT NULL,
	"referrers" jsonb NOT NULL,
	"countries" jsonb NOT NULL,
	"utm_sources" jsonb NOT NULL,
	"events" jsonb NOT NULL,
	"visitors" bytea,
	PRIMARY KEY ("node_id", "domain_id", "ts")
) PARTITION BY RANGE ("ts");
--> statement-breakpoint
CREATE INDEX "traffic_1m_service_idx" ON "traffic_1m" ("service_id", "ts");
--> statement-breakpoint
CREATE INDEX "traffic_1m_org_idx" ON "traffic_1m" ("organization_id", "ts");
--> statement-breakpoint
-- Hourly rollup across nodes, recomputed from traffic_1m; retention deletes rows.
CREATE TABLE "traffic_1h" (
	"domain_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"service_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"requests" integer NOT NULL,
	"s1" integer NOT NULL,
	"s2" integer NOT NULL,
	"s3" integer NOT NULL,
	"s4" integer NOT NULL,
	"s5" integer NOT NULL,
	"bytes_in" bigint NOT NULL,
	"bytes_out" bigint NOT NULL,
	"pageviews" integer NOT NULL,
	"bots" integer NOT NULL,
	"latency" jsonb NOT NULL,
	"paths" jsonb NOT NULL,
	"referrers" jsonb NOT NULL,
	"countries" jsonb NOT NULL,
	"utm_sources" jsonb NOT NULL,
	"events" jsonb NOT NULL,
	"visitors" bytea,
	PRIMARY KEY ("domain_id", "ts")
);
--> statement-breakpoint
CREATE INDEX "traffic_1h_service_idx" ON "traffic_1h" ("service_id", "ts");
--> statement-breakpoint
CREATE INDEX "traffic_1h_org_idx" ON "traffic_1h" ("organization_id", "ts");
--> statement-breakpoint
CREATE INDEX "traffic_1h_ts_idx" ON "traffic_1h" ("ts");
--> statement-breakpoint
SELECT "metric_ensure_partitions"('traffic_1m', (now() AT TIME ZONE 'UTC')::date - 1, (now() AT TIME ZONE 'UTC')::date + 2);

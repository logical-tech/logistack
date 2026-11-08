-- Host disk I/O, hottest sensor and CPU iowait/steal. Nullable: older agents send none of them,
-- and the previous release's positional inserts fill only the columns before these.
ALTER TABLE "metric_host_raw" ADD COLUMN "disk_read" bigint;
--> statement-breakpoint
ALTER TABLE "metric_host_raw" ADD COLUMN "disk_write" bigint;
--> statement-breakpoint
ALTER TABLE "metric_host_raw" ADD COLUMN "temp" real;
--> statement-breakpoint
ALTER TABLE "metric_host_raw" ADD COLUMN "iowait" real;
--> statement-breakpoint
ALTER TABLE "metric_host_raw" ADD COLUMN "steal" real;
--> statement-breakpoint
ALTER TABLE "metric_host_1m" ADD COLUMN "dread" double precision;
--> statement-breakpoint
ALTER TABLE "metric_host_1m" ADD COLUMN "dwrite" double precision;
--> statement-breakpoint
ALTER TABLE "metric_host_1m" ADD COLUMN "temp" real;
--> statement-breakpoint
ALTER TABLE "metric_host_1m" ADD COLUMN "iowait" real;
--> statement-breakpoint
ALTER TABLE "metric_host_1m" ADD COLUMN "steal" real;
--> statement-breakpoint
ALTER TABLE "metric_host_1h" ADD COLUMN "dread" double precision;
--> statement-breakpoint
ALTER TABLE "metric_host_1h" ADD COLUMN "dwrite" double precision;
--> statement-breakpoint
ALTER TABLE "metric_host_1h" ADD COLUMN "temp" real;
--> statement-breakpoint
ALTER TABLE "metric_host_1h" ADD COLUMN "iowait" real;
--> statement-breakpoint
ALTER TABLE "metric_host_1h" ADD COLUMN "steal" real;

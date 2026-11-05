ALTER TYPE "public"."migration_source" ADD VALUE 'coolify';--> statement-breakpoint
CREATE TABLE "migration_bridge" (
	"service_id" text PRIMARY KEY NOT NULL,
	"migration_id" text NOT NULL,
	"aliases" text[] NOT NULL,
	"routes" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "migration" ADD COLUMN "freeze" jsonb;--> statement-breakpoint
ALTER TABLE "migration_bridge" ADD CONSTRAINT "migration_bridge_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_bridge" ADD CONSTRAINT "migration_bridge_migration_id_migration_id_fk" FOREIGN KEY ("migration_id") REFERENCES "public"."migration"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Services a Dokploy migration already imported keep the bridge they had: their slug on Dokploy's
-- network, and routers for its Traefik when they come from a compose file (`dokploy:<app>/<svc>`).
INSERT INTO "migration_bridge" ("service_id", "migration_id", "aliases", "routes")
SELECT s."id", m."id", ARRAY[s."slug"], s."imported_from" LIKE '%/%'
FROM "service" s
JOIN "environment" e ON e."id" = s."environment_id"
JOIN "project" p ON p."id" = e."project_id"
JOIN LATERAL (
	SELECT "id" FROM "migration"
	WHERE "organization_id" = p."organization_id" AND "source" = 'dokploy' AND "status" <> 'decommissioned'
	ORDER BY "created_at" DESC LIMIT 1
) m ON true
WHERE s."imported_from" LIKE 'dokploy:%'
ON CONFLICT DO NOTHING;

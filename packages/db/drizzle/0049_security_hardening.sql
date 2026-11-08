CREATE TABLE "two_factor_lockout" (
	"member_id" text NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "two_factor_lockout_member_id_deadline_pk" PRIMARY KEY("member_id","deadline")
);
--> statement-breakpoint
ALTER TABLE "two_factor_lockout" ADD CONSTRAINT "two_factor_lockout_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- A user is a member of an organization once. Earlier racing SSO sign-ins could insert twice; keep the oldest row.
DELETE FROM "member" m USING "member" o
	WHERE m."organization_id" = o."organization_id" AND m."user_id" = o."user_id"
	AND (m."created_at", m."id") > (o."created_at", o."id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "member_org_user_uidx" ON "member" USING btree ("organization_id","user_id");--> statement-breakpoint
-- Instance admins are users whose role lists admin. Setup always granted it; make sure one exists: the oldest human owner.
UPDATE "user" SET "role" = 'admin' WHERE "id" = (
	SELECT u."id" FROM "member" m JOIN "user" u ON u."id" = m."user_id"
	WHERE u."kind" = 'human' AND 'owner' = ANY(string_to_array(replace(m."role", ' ', ''), ','))
	ORDER BY m."created_at", m."id" LIMIT 1
) AND NOT EXISTS (
	SELECT 1 FROM "user" WHERE 'admin' = ANY(string_to_array(replace(coalesce("role", ''), ' ', ''), ','))
);

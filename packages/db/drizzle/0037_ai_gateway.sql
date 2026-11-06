CREATE TABLE "ai_budget" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"free_cap_micros" bigint,
	"paid_cap_micros" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_budget_member_unique" UNIQUE("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "ai_gateway_key" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"start" text NOT NULL,
	"hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_gateway_key_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "ai_provider_key" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"secret_encrypted" text NOT NULL,
	"base_url" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"last_error" text,
	"last_checked_at" timestamp with time zone,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"gateway_enabled" boolean DEFAULT false NOT NULL,
	"auto_chain" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"gateway_key_id" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"tier" text NOT NULL,
	"endpoint" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"fallbacks" integer DEFAULT 0 NOT NULL,
	"ok" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_budget" ADD CONSTRAINT "ai_budget_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_budget" ADD CONSTRAINT "ai_budget_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_gateway_key" ADD CONSTRAINT "ai_gateway_key_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_gateway_key" ADD CONSTRAINT "ai_gateway_key_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_provider_key" ADD CONSTRAINT "ai_provider_key_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_gateway_key_id_ai_gateway_key_id_fk" FOREIGN KEY ("gateway_key_id") REFERENCES "public"."ai_gateway_key"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_gateway_key_org_idx" ON "ai_gateway_key" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ai_provider_key_org_idx" ON "ai_provider_key" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ai_usage_org_time_idx" ON "ai_usage" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_user_time_idx" ON "ai_usage" USING btree ("organization_id","user_id","created_at");
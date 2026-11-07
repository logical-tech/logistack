CREATE TABLE "image_scan" (
	"digest" text PRIMARY KEY NOT NULL,
	"image" text NOT NULL,
	"status" text NOT NULL,
	"counts" jsonb,
	"error" text,
	"scanned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "image_vulnerability" (
	"digest" text NOT NULL,
	"vulnerability_id" text NOT NULL,
	"pkg_name" text NOT NULL,
	"installed_version" text NOT NULL,
	"fixed_version" text,
	"severity" text NOT NULL,
	"title" text,
	"url" text,
	CONSTRAINT "image_vulnerability_pk" PRIMARY KEY("digest","vulnerability_id","pkg_name","installed_version")
);
--> statement-breakpoint
CREATE TABLE "service_image" (
	"service_id" text PRIMARY KEY NOT NULL,
	"image" text NOT NULL,
	"digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "image_vulnerability" ADD CONSTRAINT "image_vulnerability_digest_image_scan_digest_fk" FOREIGN KEY ("digest") REFERENCES "public"."image_scan"("digest") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_image" ADD CONSTRAINT "service_image_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;
CREATE TABLE "ppip_sending" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"archive_id" uuid NOT NULL,
	"month" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"started_by" uuid NOT NULL,
	"content" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "prescription" ADD COLUMN "sending_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "ppip_sending" ADD CONSTRAINT "ppip_sending_archive_id_archive_id_fk" FOREIGN KEY ("archive_id") REFERENCES "public"."archive"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ppip_sending" ADD CONSTRAINT "ppip_sending_started_by_app_user_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ppip_sending_archive_id_month_index" ON "ppip_sending" USING btree ("archive_id","month");
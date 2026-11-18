CREATE TABLE "reference_update_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger" text NOT NULL,
	"requested_by" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"running" boolean,
	"outcome" text,
	"sync_exit_code" integer,
	"sync_report" jsonb,
	"import_report" jsonb,
	"series_status" jsonb,
	"message" text,
	"output" text,
	CONSTRAINT "reference_update_run_running_unique" UNIQUE("running")
);
--> statement-breakpoint
CREATE INDEX "reference_update_run_started_at_index" ON "reference_update_run" USING btree ("started_at");
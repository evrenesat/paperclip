ALTER TABLE "agents" ADD COLUMN "focus_issue_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "focus_started_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "agents_focus_issue_idx" ON "agents" USING btree ("focus_issue_id");
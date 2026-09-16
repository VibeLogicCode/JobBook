CREATE INDEX "customers_list_idx" ON "customers" USING btree ("record_status","name");--> statement-breakpoint
CREATE INDEX "projects_stage_idx" ON "projects" USING btree ("record_status","stage");--> statement-breakpoint
CREATE INDEX "rate_items_list_idx" ON "rate_items" USING btree ("is_active","record_status","sort_order");--> statement-breakpoint
CREATE INDEX "quote_lines_cost_code_idx" ON "quote_lines" USING btree ("cost_code_id");--> statement-breakpoint
CREATE INDEX "quotes_list_idx" ON "quotes" USING btree ("record_status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "quotes_expiry_idx" ON "quotes" USING btree ("status","valid_until");--> statement-breakpoint
CREATE INDEX "reminders_list_idx" ON "reminders" USING btree ("record_status","due_at");--> statement-breakpoint
CREATE INDEX "expenses_recent_idx" ON "expenses" USING btree ("expense_date" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "schedule_tasks_period_idx" ON "schedule_tasks" USING btree ("planned_start","planned_end");
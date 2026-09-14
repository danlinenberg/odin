CREATE TABLE `work_log` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`external_url` text,
	`title` text NOT NULL,
	`person` text,
	`profile_id` text DEFAULT 'default' NOT NULL,
	`started_at` integer NOT NULL,
	`cwd` text,
	`session_id` text,
	`branch` text,
	`pr_url` text,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `work_log_started_at_idx` ON `work_log` (`started_at`);--> statement-breakpoint
CREATE INDEX `work_log_source_idx` ON `work_log` (`source`);
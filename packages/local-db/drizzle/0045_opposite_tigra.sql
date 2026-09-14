CREATE TABLE `slack_reactions` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`channel_name` text,
	`message_ts` text NOT NULL,
	`author_id` text,
	`author_name` text,
	`text` text DEFAULT '' NOT NULL,
	`permalink` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`unreacted_at` integer,
	`done_at` integer
);
--> statement-breakpoint
CREATE INDEX `slack_reactions_first_seen_at_idx` ON `slack_reactions` (`first_seen_at`);--> statement-breakpoint
CREATE INDEX `slack_reactions_done_at_idx` ON `slack_reactions` (`done_at`);
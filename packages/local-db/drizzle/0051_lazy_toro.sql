CREATE TABLE `remote_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`host` text NOT NULL,
	`ssh_port` integer DEFAULT 22 NOT NULL,
	`username` text NOT NULL,
	`ssh_key_path` text,
	`odin_folder` text NOT NULL,
	`remote_host_service_port` integer DEFAULT 48000 NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `remote_connections_name_idx` ON `remote_connections` (`name`);
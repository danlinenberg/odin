ALTER TABLE `remote_connections` ADD `auth_method` text DEFAULT 'key' NOT NULL;--> statement-breakpoint
ALTER TABLE `remote_connections` ADD `password_encrypted` text;
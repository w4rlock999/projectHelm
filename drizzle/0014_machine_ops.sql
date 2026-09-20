CREATE TABLE `remote_ops` (
	`id` text PRIMARY KEY NOT NULL,
	`remote_id` text,
	`kind` text NOT NULL,
	`detail` text NOT NULL,
	`requested_by` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`code` integer,
	`log_path` text
);
--> statement-breakpoint
ALTER TABLE `remotes` ADD `ssh_identity_file` text;
CREATE TABLE `remotes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`ssh_target` text NOT NULL,
	`helm_port` integer DEFAULT 5555 NOT NULL,
	`token` text NOT NULL,
	`last_seen_at` integer,
	`last_version` text,
	`capabilities` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);

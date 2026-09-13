CREATE TABLE `recall_orphans` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`remote_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_tried_at` integer,
	`last_error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recall_orphans_agent_remote_idx` ON `recall_orphans` (`agent_id`,`remote_id`);
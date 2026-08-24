CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`refused_reason` text,
	`prompt` text NOT NULL,
	`result_text` text,
	`exit_code` integer,
	`is_error` integer,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `runs_agent_started_idx` ON `runs` (`agent_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `agents` ADD `deployed_to` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `deploy_state` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `deployed_at` integer;--> statement-breakpoint
ALTER TABLE `agents` ADD `deploy_error` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `run_budget_per_hour` integer;
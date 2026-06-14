CREATE TABLE `agent_tools` (
	`agent_id` text NOT NULL,
	`tool_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`agent_id`, `tool_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tool_id`) REFERENCES `tools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `agent_tools` (`agent_id`, `tool_id`, `created_at`) SELECT `agent_id`, `id`, `created_at` FROM `tools`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tools` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`interpreter` text DEFAULT 'bash' NOT NULL,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_tools`(`id`, `name`, `description`, `interpreter`, `source`, `created_at`, `updated_at`) SELECT `id`, `name`, `description`, `interpreter`, `source`, `created_at`, `created_at` FROM `tools`;--> statement-breakpoint
DROP TABLE `tools`;--> statement-breakpoint
ALTER TABLE `__new_tools` RENAME TO `tools`;--> statement-breakpoint
PRAGMA foreign_keys=ON;

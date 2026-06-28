ALTER TABLE `channels` RENAME TO `connections`;
--> statement-breakpoint
ALTER TABLE `agents` ADD `session_scope` text DEFAULT 'chat' NOT NULL;
--> statement-breakpoint
UPDATE `agents` SET `session_scope` = 'agent';
--> statement-breakpoint
ALTER TABLE `heartbeats` ADD `target_type` text DEFAULT 'main' NOT NULL;
--> statement-breakpoint
ALTER TABLE `heartbeats` ADD `target_chat_id` text;
--> statement-breakpoint
CREATE TABLE `connections_chat` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`claude_session_id` text,
	`title` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_message_at` integer,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conn_chat_uq` ON `connections_chat` (`connection_id`,`chat_id`);
--> statement-breakpoint
INSERT INTO `connections_chat` (`id`, `connection_id`, `chat_id`, `claude_session_id`, `status`, `created_at`)
SELECT lower(hex(randomblob(16))), c.`id`, c.`chat_id`,
       (SELECT a.`claude_session_id` FROM `agents` a WHERE a.`id` = c.`agent_id`),
       'active', unixepoch()
FROM `connections` c WHERE c.`chat_id` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `connections` DROP COLUMN `chat_id`;

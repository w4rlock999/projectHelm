CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`system_prompt` text NOT NULL,
	`allowed_tools` text,
	`model` text,
	`claude_session_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);

-- Custom SQL migration file, put your code below! --
ALTER TABLE `connections` RENAME TO `gateways`;--> statement-breakpoint
ALTER TABLE `connections_chat` RENAME TO `gateways_chat`;--> statement-breakpoint
ALTER TABLE `gateways_chat` RENAME COLUMN `connection_id` TO `gateway_id`;--> statement-breakpoint
DROP INDEX `conn_chat_uq`;--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_chat_uq` ON `gateways_chat` (`gateway_id`,`chat_id`);

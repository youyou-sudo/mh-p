CREATE TABLE `engine_ops` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`revision_id` text,
	`at` integer NOT NULL,
	`op` text NOT NULL,
	`target` text,
	`ok` integer NOT NULL,
	`duration_ms` integer,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `idx_engine_ops_at` ON `engine_ops` (`at`);--> statement-breakpoint
CREATE TABLE `engine_slots` (
	`slot` integer PRIMARY KEY NOT NULL,
	`node_id` text,
	`port` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `engine_slots_node_id_unique` ON `engine_slots` (`node_id`);--> statement-breakpoint
ALTER TABLE `nodes` ADD `proxy_name` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `proxy_source` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `proxy_json` text;
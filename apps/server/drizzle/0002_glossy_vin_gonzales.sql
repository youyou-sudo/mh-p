CREATE TABLE `route_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`country_regex` text NOT NULL,
	`balance_mode` text DEFAULT 'balanced' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`password_enc` text NOT NULL,
	`password_lookup_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);

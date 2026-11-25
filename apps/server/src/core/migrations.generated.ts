/**
 * 由 scripts/db-generate.ts 生成，勿手改。
 *
 * drizzle/0000_*.sql 是基线，描述的是 v1-v3 建表后的结果，**不会被执行**；
 * drizzle/0001_*.sql 起才映射为 version 4、5 … 依次应用。
 *
 * 生成成 TS 模块而不是运行时读目录，是为了 bun build --compile 的单文件产物仍能带上迁移。
 */
export const DRIZZLE_MIGRATIONS: { version: number; name: string; sql: string }[] = [
  { version: 4, name: "overjoyed-sersi", sql: "CREATE TABLE `engine_ops` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`revision_id` text,\n\t`at` integer NOT NULL,\n\t`op` text NOT NULL,\n\t`target` text,\n\t`ok` integer NOT NULL,\n\t`duration_ms` integer,\n\t`detail` text\n);\nCREATE INDEX `idx_engine_ops_at` ON `engine_ops` (`at`);\nCREATE TABLE `engine_slots` (\n\t`slot` integer PRIMARY KEY NOT NULL,\n\t`node_id` text,\n\t`port` integer NOT NULL,\n\t`updated_at` integer NOT NULL\n);\nCREATE UNIQUE INDEX `engine_slots_node_id_unique` ON `engine_slots` (`node_id`);\nALTER TABLE `nodes` ADD `proxy_name` text;\nALTER TABLE `nodes` ADD `proxy_source` text;\nALTER TABLE `nodes` ADD `proxy_json` text;" },
  { version: 5, name: "glossy-vin-gonzales", sql: "CREATE TABLE `route_groups` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`name` text NOT NULL,\n\t`country_regex` text NOT NULL,\n\t`balance_mode` text DEFAULT 'balanced' NOT NULL,\n\t`enabled` integer DEFAULT 1 NOT NULL,\n\t`password_enc` text NOT NULL,\n\t`password_lookup_hash` text NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL\n);" },
]

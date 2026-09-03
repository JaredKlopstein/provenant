CREATE TABLE `anchors` (
	`id` text PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	`head_hash` text NOT NULL,
	`receipt_count` integer NOT NULL,
	`chain_id` text NOT NULL,
	`backend` text NOT NULL,
	`proof_type` text NOT NULL,
	`proof_token` text,
	`proven_time` text,
	`authority` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `anchors_seq_backend_idx` ON `anchors` (`seq`,`backend`);--> statement-breakpoint
CREATE INDEX `anchors_seq_idx` ON `anchors` (`seq`);--> statement-breakpoint
CREATE INDEX `anchors_proven_time_idx` ON `anchors` (`proven_time`);--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);

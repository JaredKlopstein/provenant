CREATE TABLE `agents` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`agent_version` text DEFAULT '0.0.0' NOT NULL,
	`trust_level` text DEFAULT 'L1' NOT NULL,
	`public_key_jwk` text NOT NULL,
	`key_id` text NOT NULL,
	`tofu_key_id` text NOT NULL,
	`declared_capabilities` text DEFAULT '[]' NOT NULL,
	`registered_at` text NOT NULL,
	`last_seen_at` text
);
--> statement-breakpoint
CREATE INDEX `agents_key_id_idx` ON `agents` (`key_id`);--> statement-breakpoint
CREATE TABLE `receipts` (
	`seq` integer PRIMARY KEY NOT NULL,
	`record_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`session_id` text NOT NULL,
	`timestamp` text NOT NULL,
	`received_at` text NOT NULL,
	`action` text NOT NULL,
	`action_type` text NOT NULL,
	`outcome` text NOT NULL,
	`side_effect_class` text NOT NULL,
	`trust_level` text NOT NULL,
	`prev_hash` text,
	`self_hash` text NOT NULL,
	`key_id` text NOT NULL,
	`signature` text NOT NULL,
	`idempotency_key` text,
	`canonical_json` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipts_record_id_idx` ON `receipts` (`record_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `receipts_self_hash_idx` ON `receipts` (`self_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `receipts_idem_idx` ON `receipts` (`agent_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `receipts_agent_seq_idx` ON `receipts` (`agent_id`,`seq`);--> statement-breakpoint
CREATE INDEX `receipts_timestamp_idx` ON `receipts` (`timestamp`);--> statement-breakpoint
CREATE INDEX `receipts_action_idx` ON `receipts` (`action`);--> statement-breakpoint
CREATE INDEX `receipts_session_idx` ON `receipts` (`session_id`);
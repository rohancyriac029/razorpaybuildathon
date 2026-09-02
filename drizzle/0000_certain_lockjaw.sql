CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`razorpay_customer_id` text NOT NULL,
	`name` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `episodes` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`strategy_name` text NOT NULL,
	`context_hash` text NOT NULL,
	`reasoning` text NOT NULL,
	`proposal` text NOT NULL,
	`verdict_kind` text NOT NULL,
	`verdict_rule_id` text NOT NULL,
	`verdict_reason` text NOT NULL,
	`exec_result` text,
	`outcome` text,
	`run_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `eval_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`config_name` text NOT NULL,
	`strategy_name` text NOT NULL,
	`scenario_id` text NOT NULL,
	`seed` integer NOT NULL,
	`recovered` integer NOT NULL,
	`net_recovered_paise` real NOT NULL,
	`wasted_attempts` integer NOT NULL,
	`contacts_used` integer NOT NULL,
	`terminal_retries_proposed` integer NOT NULL,
	`terminal_retries_executed` integer NOT NULL,
	`offers_proposed` integer NOT NULL,
	`offers_sent` integer NOT NULL,
	`time_to_recovery_ms` integer,
	`oracle_headroom_paise` real,
	`llm_cost_paise_usd` real,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `failures` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`event_id` text NOT NULL,
	`razorpay_payment_id` text,
	`error_code` text,
	`error_source` text,
	`error_step` text,
	`error_reason` text,
	`category` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`event_id`) REFERENCES `webhook_events`(`event_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `intents` (
	`id` text PRIMARY KEY NOT NULL,
	`episode_id` text NOT NULL,
	`order_id` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`proposal_type` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text NOT NULL,
	`razorpay_ref_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `intents_idempotency_key_unique` ON `intents` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `llm_cache` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`response` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`razorpay_order_id` text NOT NULL,
	`razorpay_subscription_id` text,
	`customer_id` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text DEFAULT 'INR' NOT NULL,
	`status` text DEFAULT 'created' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_razorpay_order_id_unique` ON `orders` (`razorpay_order_id`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`razorpay_subscription_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`auth_attempts` integer DEFAULT 0 NOT NULL,
	`plan_amount` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_razorpay_subscription_id_unique` ON `subscriptions` (`razorpay_subscription_id`);--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`received_at` text NOT NULL,
	`processed_at` text
);

import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260908075913_workflow_handoffs",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`model_price_snapshot\` (
          \`id\` text PRIMARY KEY,
          \`provider_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`effective_at\` integer NOT NULL,
          \`source\` text NOT NULL,
          \`prices\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`workflow_attempt_cost\` (
          \`id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`node_id\` text NOT NULL,
          \`provider_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`price_snapshot_id\` text,
          \`usage\` text NOT NULL,
          \`estimated_microusd\` integer,
          \`status\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_workflow_attempt_cost_run_id_workflow_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`workflow_run\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_workflow_attempt_cost_price_snapshot_id_model_price_snapshot_id_fk\` FOREIGN KEY (\`price_snapshot_id\`) REFERENCES \`model_price_snapshot\`(\`id\`) ON DELETE RESTRICT
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`workflow_handoff\` (
          \`id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`source_node_id\` text NOT NULL,
          \`source_port\` text NOT NULL,
          \`target_node_id\` text NOT NULL,
          \`target_port\` text NOT NULL,
          \`mode\` text NOT NULL,
          \`payload\` text NOT NULL,
          \`sequence\` integer NOT NULL,
          \`sealed\` integer DEFAULT false NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_workflow_handoff_run_id_workflow_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`workflow_run\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`workflow_queue_cursor\` (
          \`run_id\` text NOT NULL,
          \`node_id\` text NOT NULL,
          \`port\` text NOT NULL,
          \`sequence\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`workflow_queue_cursor_pk\` PRIMARY KEY(\`run_id\`, \`node_id\`, \`port\`),
          CONSTRAINT \`fk_workflow_queue_cursor_run_id_workflow_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`workflow_run\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`model_price_snapshot_provider_model_effective_idx\` ON \`model_price_snapshot\` (\`provider_id\`,\`model_id\`,\`effective_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`workflow_attempt_cost_run_node_idx\` ON \`workflow_attempt_cost\` (\`run_id\`,\`node_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`workflow_attempt_cost_provider_model_idx\` ON \`workflow_attempt_cost\` (\`provider_id\`,\`model_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`workflow_handoff_run_target_sequence_idx\` ON \`workflow_handoff\` (\`run_id\`,\`target_node_id\`,\`target_port\`,\`sequence\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`workflow_handoff_run_source_idx\` ON \`workflow_handoff\` (\`run_id\`,\`source_node_id\`,\`source_port\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`workflow_queue_cursor_run_node_port_idx\` ON \`workflow_queue_cursor\` (\`run_id\`,\`node_id\`,\`port\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration

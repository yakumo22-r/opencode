import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260908080441_workflow_work_items",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`workflow_work_item\` (
          \`run_id\` text NOT NULL,
          \`node_id\` text NOT NULL,
          \`status\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`workflow_work_item_pk\` PRIMARY KEY(\`run_id\`, \`node_id\`),
          CONSTRAINT \`fk_workflow_work_item_run_id_workflow_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`workflow_run\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`workflow_work_item_run_status_idx\` ON \`workflow_work_item\` (\`run_id\`,\`status\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration

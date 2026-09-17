import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260908095528_workflow_attempt_cost_source",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`workflow_attempt_cost\` ADD \`source_message_id\` text;`)
      yield* tx.run(`ALTER TABLE \`workflow_queue_cursor\` ADD \`source_message_id\` text;`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`workflow_attempt_cost_source_message_idx\` ON \`workflow_attempt_cost\` (\`source_message_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration

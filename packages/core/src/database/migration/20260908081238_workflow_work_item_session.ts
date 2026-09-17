import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260908081238_workflow_work_item_session",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`workflow_work_item\` ADD \`session_id\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration

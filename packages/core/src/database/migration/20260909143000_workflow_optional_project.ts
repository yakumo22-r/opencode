import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260909143000_workflow_optional_project",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      yield* tx.run(`
        CREATE TABLE \`__new_workflow_template\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text,
          \`title\` text NOT NULL,
          \`description\` text,
          \`version\` integer NOT NULL,
          \`graph\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_workflow_template_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`INSERT INTO \`__new_workflow_template\` SELECT * FROM \`workflow_template\`;`)
      yield* tx.run(`
        CREATE TABLE \`__new_workflow_run\` (
          \`id\` text PRIMARY KEY,
          \`template_id\` text NOT NULL,
          \`project_id\` text,
          \`template_version\` integer NOT NULL,
          \`status\` text NOT NULL,
          \`graph\` text NOT NULL,
          \`input\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_workflow_run_template_id_workflow_template_id_fk\` FOREIGN KEY (\`template_id\`) REFERENCES \`workflow_template\`(\`id\`) ON DELETE RESTRICT,
          CONSTRAINT \`fk_workflow_run_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`INSERT INTO \`__new_workflow_run\` SELECT * FROM \`workflow_run\`;`)
      yield* tx.run(`DROP TABLE \`workflow_run\`;`)
      yield* tx.run(`DROP TABLE \`workflow_template\`;`)
      yield* tx.run(`ALTER TABLE \`__new_workflow_template\` RENAME TO \`workflow_template\`;`)
      yield* tx.run(`ALTER TABLE \`__new_workflow_run\` RENAME TO \`workflow_run\`;`)
      yield* tx.run(
        `CREATE INDEX \`workflow_run_project_time_updated_idx\` ON \`workflow_run\` (\`project_id\`,\`time_updated\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`workflow_template_project_time_updated_idx\` ON \`workflow_template\` (\`project_id\`,\`time_updated\`);`,
      )
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
    })
  },
} satisfies DatabaseMigration.Migration

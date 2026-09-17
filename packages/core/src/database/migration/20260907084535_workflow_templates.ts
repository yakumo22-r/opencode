import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260907084535_workflow_templates",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`workflow_run\` (
          \`id\` text PRIMARY KEY,
          \`template_id\` text NOT NULL,
          \`project_id\` text NOT NULL,
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
      yield* tx.run(`
        CREATE TABLE \`workflow_template\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`title\` text NOT NULL,
          \`description\` text,
          \`version\` integer NOT NULL,
          \`graph\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_workflow_template_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`workflow_run_project_time_updated_idx\` ON \`workflow_run\` (\`project_id\`,\`time_updated\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`workflow_template_project_time_updated_idx\` ON \`workflow_template\` (\`project_id\`,\`time_updated\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration

import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import { ProjectTable } from "../project/sql"

export const WorkflowTemplateTable = sqliteTable(
  "workflow_template",
  {
    id: text().primaryKey(),
    project_id: text().references(() => ProjectTable.id, { onDelete: "cascade" }),
    title: text().notNull(),
    description: text(),
    version: integer().notNull(),
    graph: text({ mode: "json" }).notNull(),
    ...Timestamps,
  },
  (table) => [index("workflow_template_project_time_updated_idx").on(table.project_id, table.time_updated)],
)

export const WorkflowRunTable = sqliteTable(
  "workflow_run",
  {
    id: text().primaryKey(),
    template_id: text()
      .notNull()
      .references(() => WorkflowTemplateTable.id, { onDelete: "restrict" }),
    project_id: text().references(() => ProjectTable.id, { onDelete: "cascade" }),
    template_version: integer().notNull(),
    status: text().notNull(),
    graph: text({ mode: "json" }).notNull(),
    input: text({ mode: "json" }).notNull(),
    ...Timestamps,
  },
  (table) => [index("workflow_run_project_time_updated_idx").on(table.project_id, table.time_updated)],
)

export const ModelPriceSnapshotTable = sqliteTable(
  "model_price_snapshot",
  {
    id: text().primaryKey(),
    provider_id: text().notNull(),
    model_id: text().notNull(),
    effective_at: integer().notNull(),
    source: text({ mode: "json" }).notNull(),
    prices: text({ mode: "json" }).notNull(),
    ...Timestamps,
  },
  (table) => [index("model_price_snapshot_provider_model_effective_idx").on(table.provider_id, table.model_id, table.effective_at)],
)

export const WorkflowHandoffTable = sqliteTable(
  "workflow_handoff",
  {
    id: text().primaryKey(),
    run_id: text()
      .notNull()
      .references(() => WorkflowRunTable.id, { onDelete: "cascade" }),
    source_node_id: text().notNull(),
    source_port: text().notNull(),
    target_node_id: text().notNull(),
    target_port: text().notNull(),
    mode: text().notNull(),
    payload: text({ mode: "json" }).notNull(),
    sequence: integer().notNull(),
    sealed: integer({ mode: "boolean" }).notNull().default(false),
    ...Timestamps,
  },
  (table) => [
    index("workflow_handoff_run_target_sequence_idx").on(table.run_id, table.target_node_id, table.target_port, table.sequence),
    index("workflow_handoff_run_source_idx").on(table.run_id, table.source_node_id, table.source_port),
  ],
)

export const WorkflowWorkItemTable = sqliteTable(
  "workflow_work_item",
  {
    run_id: text()
      .notNull()
      .references(() => WorkflowRunTable.id, { onDelete: "cascade" }),
    node_id: text().notNull(),
    status: text().notNull(),
    session_id: text(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.run_id, table.node_id] }),
    index("workflow_work_item_run_status_idx").on(table.run_id, table.status),
  ],
)

export const WorkflowQueueCursorTable = sqliteTable(
  "workflow_queue_cursor",
  {
    run_id: text()
      .notNull()
      .references(() => WorkflowRunTable.id, { onDelete: "cascade" }),
    node_id: text().notNull(),
    source_message_id: text(),
    port: text().notNull(),
    sequence: integer().notNull().default(0),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.run_id, table.node_id, table.port] }),
    index("workflow_queue_cursor_run_node_port_idx").on(table.run_id, table.node_id, table.port),
  ],
)

export const WorkflowAttemptCostTable = sqliteTable(
  "workflow_attempt_cost",
  {
    id: text().primaryKey(),
    run_id: text()
      .notNull()
      .references(() => WorkflowRunTable.id, { onDelete: "cascade" }),
    node_id: text().notNull(),
    source_message_id: text(),
    provider_id: text().notNull(),
    model_id: text().notNull(),
    price_snapshot_id: text().references(() => ModelPriceSnapshotTable.id, { onDelete: "restrict" }),
    usage: text({ mode: "json" }).notNull(),
    estimated_microusd: integer(),
    status: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    index("workflow_attempt_cost_run_node_idx").on(table.run_id, table.node_id),
    index("workflow_attempt_cost_provider_model_idx").on(table.provider_id, table.model_id),
    uniqueIndex("workflow_attempt_cost_source_message_idx").on(table.source_message_id),
  ],
)

export * as Workflow from "./workflow"

import { and, asc, desc, eq, gt, inArray, max } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Workflow as WorkflowSchema } from "@opencode-ai/schema/workflow"
import { Event } from "@opencode-ai/schema/event"
import { Database } from "./database/database"
import { EventV2 } from "./event"
import { WorkflowEvent } from "./workflow/event"
import { SessionMessage } from "./session/message"
import { SessionSchema } from "./session/schema"
import { SessionMessageTable } from "./session/sql"
import { ProjectV2 } from "./project"
import { makeGlobalNode } from "./effect/app-node"
import { Slug } from "./util/slug"
import {
  ModelPriceSnapshotTable,
  WorkflowAttemptCostTable,
  WorkflowHandoffTable,
  WorkflowQueueCursorTable,
  WorkflowRunTable,
  WorkflowTemplateTable,
  WorkflowWorkItemTable,
} from "./workflow/sql"

export const Graph = WorkflowSchema.Graph
export type Graph = WorkflowSchema.Graph
export const Template = WorkflowSchema.Template
export type Template = WorkflowSchema.Template
export const Run = WorkflowSchema.Run
export type Run = WorkflowSchema.Run
export const WorkItemStatus = WorkflowSchema.WorkItemStatus
export type WorkItemStatus = WorkflowSchema.WorkItemStatus
export const WorkItem = WorkflowSchema.WorkItem
export type WorkItem = WorkflowSchema.WorkItem
export const Handoff = WorkflowSchema.Handoff
export type Handoff = WorkflowSchema.Handoff
export const TokenUsage = WorkflowSchema.TokenUsage
export type TokenUsage = WorkflowSchema.TokenUsage
export const CostGroup = WorkflowSchema.CostGroup
export type CostGroup = WorkflowSchema.CostGroup
export const CostReport = WorkflowSchema.CostReport
export type CostReport = WorkflowSchema.CostReport

export class GraphValidationError extends Schema.TaggedErrorClass<GraphValidationError>()("Workflow.GraphValidationError", {
  message: Schema.String,
}) {}

export class TemplateNotFoundError extends Schema.TaggedErrorClass<TemplateNotFoundError>()("Workflow.TemplateNotFoundError", {
  templateID: Schema.String,
}) {}

export class RunNotFoundError extends Schema.TaggedErrorClass<RunNotFoundError>()("Workflow.RunNotFoundError", {
  runID: Schema.String,
}) {}

export class HandoffValidationError extends Schema.TaggedErrorClass<HandoffValidationError>()("Workflow.HandoffValidationError", {
  message: Schema.String,
}) {}

type CreateTemplateInput = {
  projectID?: ProjectV2.ID
  title: string
  description?: string
  graph: Graph
}

export interface Interface {
  readonly validate: (graph: Graph) => Effect.Effect<void, GraphValidationError>
  readonly listTemplates: (projectID?: ProjectV2.ID) => Effect.Effect<Template[], unknown>
  readonly createTemplate: (input: CreateTemplateInput) => Effect.Effect<Template, GraphValidationError | unknown>
  readonly getTemplate: (templateID: string) => Effect.Effect<Template, TemplateNotFoundError | unknown>
  readonly updateTemplate: (input: {
    templateID: string
    title?: string
    description?: string
    graph: Graph
  }) => Effect.Effect<Template, TemplateNotFoundError | GraphValidationError | unknown>
  readonly createRun: (input: { templateID: string; input: unknown }) => Effect.Effect<Run, TemplateNotFoundError | unknown>
  readonly listRuns: (projectID?: ProjectV2.ID) => Effect.Effect<Run[], unknown>
  readonly getRun: (runID: string) => Effect.Effect<Run, RunNotFoundError | unknown>
  readonly listWorkItems: (runID: string) => Effect.Effect<WorkItem[], unknown>
  readonly getWorkItemBySession: (sessionID: string) => Effect.Effect<WorkItem | undefined, unknown>
  readonly setWorkItemStatus: (input: {
    runID: string
    nodeID: string
    status: WorkItemStatus
  }) => Effect.Effect<WorkItem, RunNotFoundError | HandoffValidationError | unknown>
  readonly sendHandoff: (input: {
    runID: string
    sourceNodeID: string
    sourcePort: string
    targetNodeID: string
    targetPort: string
    payload: typeof Schema.Json.Type
    sealed?: boolean
  }) => Effect.Effect<Handoff, RunNotFoundError | HandoffValidationError | unknown>
  readonly readQueue: (input: {
    runID: string
    nodeID: string
    port: string
  }) => Effect.Effect<Handoff[], RunNotFoundError | HandoffValidationError | unknown>
  readonly acknowledgeQueue: (input: {
    runID: string
    nodeID: string
    port: string
    sequence: number
  }) => Effect.Effect<void, RunNotFoundError | HandoffValidationError | unknown>
  readonly recordAttemptCost: (input: {
    runID: string
    nodeID: string
    providerID: string
    modelID: string
    usage: TokenUsage
    sourceMessageID?: string
  }) => Effect.Effect<{ estimatedMicrousd?: number }, RunNotFoundError | HandoffValidationError | unknown>
  readonly projectSessionCosts: (runID: string) => Effect.Effect<number, unknown>
  readonly costReport: (runID: string) => Effect.Effect<CostReport, RunNotFoundError | unknown>
  readonly history: (input: { runID: string; after?: number; limit: number }) => Effect.Effect<{ events: WorkflowEvent.DurableEvent[]; hasMore: boolean }, RunNotFoundError | unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/workflow/Workflow") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2.Service

    const fromTemplate = (row: typeof WorkflowTemplateTable.$inferSelect): Template => ({
      id: row.id,
      projectID: row.project_id ? ProjectV2.ID.make(row.project_id) : undefined,
      title: row.title,
      description: row.description ?? undefined,
      version: row.version,
      graph: row.graph as Graph,
      time: { created: row.time_created, updated: row.time_updated },
    })
    const fromRun = (row: typeof WorkflowRunTable.$inferSelect): Run => ({
      id: row.id,
      templateID: row.template_id,
      projectID: row.project_id ? ProjectV2.ID.make(row.project_id) : undefined,
      templateVersion: row.template_version,
      status: "ready",
      graph: row.graph as Graph,
      input: row.input as Run["input"],
      time: { created: row.time_created, updated: row.time_updated },
    })
    const fromHandoff = (row: typeof WorkflowHandoffTable.$inferSelect): Handoff => ({
      id: row.id,
      runID: row.run_id,
      sourceNodeID: row.source_node_id,
      sourcePort: row.source_port,
      targetNodeID: row.target_node_id,
      targetPort: row.target_port,
      mode: row.mode as Handoff["mode"],
      payload: row.payload as Handoff["payload"],
      sequence: row.sequence,
      sealed: row.sealed,
      time: { created: row.time_created },
    })
    const fromWorkItem = (row: typeof WorkflowWorkItemTable.$inferSelect): WorkItem => ({
      runID: row.run_id,
      nodeID: row.node_id,
      status: row.status as WorkItemStatus,
      sessionID: row.session_id ?? undefined,
      time: { created: row.time_created, updated: row.time_updated },
    })

    const validate = Effect.fn("Workflow.validate")(function* (graph: Graph) {
      const nodeIDs = new Set<string>()
      for (const node of graph.nodes) {
        if (nodeIDs.has(node.id)) return yield* new GraphValidationError({ message: `Duplicate workflow node: ${node.id}` })
        nodeIDs.add(node.id)
      }
      const edgeIDs = new Set<string>()
      const incoming = new Map<string, number>()
      const adjacency = new Map<string, string[]>()
      for (const edge of graph.edges) {
        if (edgeIDs.has(edge.id)) return yield* new GraphValidationError({ message: `Duplicate workflow edge: ${edge.id}` })
        edgeIDs.add(edge.id)
        const source = graph.nodes.find((node) => node.id === edge.sourceNodeID)
        const target = graph.nodes.find((node) => node.id === edge.targetNodeID)
        if (!source || !target) return yield* new GraphValidationError({ message: `Workflow edge ${edge.id} references a missing node` })
        const output = source.outputs[edge.sourcePort]
        const input = target.inputs[edge.targetPort]
        if (!output || !input) return yield* new GraphValidationError({ message: `Workflow edge ${edge.id} references a missing port` })
        const mode = output.mode === "artifact" ? "dependency" : "queue"
        if (input.mode !== mode) {
          return yield* new GraphValidationError({ message: `Workflow edge ${edge.id} has incompatible delivery modes` })
        }
        if (!input.handoffTypes.includes(output.handoffType)) {
          return yield* new GraphValidationError({ message: `Workflow edge ${edge.id} has incompatible handoff types` })
        }
        const portID = `${target.id}\0${edge.targetPort}`
        const count = (incoming.get(portID) ?? 0) + 1
        incoming.set(portID, count)
        if (!input.many && count > 1) {
          return yield* new GraphValidationError({ message: `Workflow input ${target.id}.${edge.targetPort} accepts one edge` })
        }
        if (input.mode === "dependency" && (edge.condition ?? "success") === "success") {
          adjacency.set(source.id, [...(adjacency.get(source.id) ?? []), target.id])
        }
      }
      const visiting = new Set<string>()
      const visited = new Set<string>()
      const hasCycle = (nodeID: string): boolean => {
        if (visiting.has(nodeID)) return true
        if (visited.has(nodeID)) return false
        visiting.add(nodeID)
        const cycle = (adjacency.get(nodeID) ?? []).some(hasCycle)
        visiting.delete(nodeID)
        visited.add(nodeID)
        return cycle
      }
      if (graph.nodes.some((node) => hasCycle(node.id))) {
        return yield* new GraphValidationError({ message: "Workflow success dependencies cannot contain a cycle" })
      }
    })

    let projectSessionCosts!: (runID: string) => Effect.Effect<number, unknown>

    return {
      validate,
      listTemplates: (projectID) =>
        database.db
          .select()
          .from(WorkflowTemplateTable)
          .where(projectID ? eq(WorkflowTemplateTable.project_id, projectID) : undefined)
          .orderBy(desc(WorkflowTemplateTable.time_updated))
          .pipe(Effect.map((rows) => rows.map(fromTemplate))),
      createTemplate: Effect.fn("Workflow.createTemplate")(function* (input: CreateTemplateInput) {
        yield* validate(input.graph)
        const id = `workflow-${Slug.create()}`
        const now = Date.now()
        yield* database.db.insert(WorkflowTemplateTable).values({
          id,
          project_id: input.projectID ?? null,
          title: input.title,
          description: input.description,
          version: 1,
          graph: input.graph,
          time_created: now,
          time_updated: now,
        })
        return {
          id,
          projectID: input.projectID,
          title: input.title,
          description: input.description,
          version: 1,
          graph: input.graph,
          time: { created: now, updated: now },
        }
      }),
      getTemplate: (templateID) =>
        database.db
          .select()
          .from(WorkflowTemplateTable)
          .where(eq(WorkflowTemplateTable.id, templateID))
          .pipe(
            Effect.map((rows) => rows[0]),
            Effect.flatMap((row) =>
              row ? Effect.succeed(fromTemplate(row)) : Effect.fail(new TemplateNotFoundError({ templateID })),
            ),
          ),
      updateTemplate: Effect.fn("Workflow.updateTemplate")(function* (input: {
        templateID: string
        title?: string
        description?: string
        graph: Graph
      }) {
        yield* validate(input.graph)
        const row = yield* database.db
          .select()
          .from(WorkflowTemplateTable)
          .where(eq(WorkflowTemplateTable.id, input.templateID))
          .pipe(Effect.map((rows) => rows[0]))
        if (!row) return yield* new TemplateNotFoundError({ templateID: input.templateID })
        const now = Date.now()
        const next = {
          title: input.title ?? row.title,
          description: input.description ?? row.description,
          graph: input.graph,
          version: row.version + 1,
          time_updated: now,
        }
        yield* database.db.update(WorkflowTemplateTable).set(next).where(eq(WorkflowTemplateTable.id, input.templateID))
        return fromTemplate({ ...row, ...next })
      }),
      createRun: Effect.fn("Workflow.createRun")(function* (input: { templateID: string; input: unknown }) {
        const template = yield* database.db
          .select()
          .from(WorkflowTemplateTable)
          .where(eq(WorkflowTemplateTable.id, input.templateID))
          .pipe(
            Effect.map((rows) => rows[0]),
            Effect.flatMap((row) =>
              row ? Effect.succeed(row) : Effect.fail(new TemplateNotFoundError({ templateID: input.templateID })),
            ),
          )
        const id = `workflow-run-${Slug.create()}`
        const now = Date.now()
        yield* database.db.insert(WorkflowRunTable).values({
          id,
          template_id: template.id,
          project_id: template.project_id,
          template_version: template.version,
          status: "ready",
          graph: template.graph,
          input: input.input,
          time_created: now,
          time_updated: now,
        })
        yield* database.db.insert(WorkflowWorkItemTable).values(
          (template.graph as Graph).nodes.map((node) => ({
            run_id: id,
            node_id: node.id,
            status: hasRequiredDependencies(template.graph as Graph, node.id) ? "pending" : "ready",
            time_created: now,
            time_updated: now,
          })),
        )
        return fromRun({
          id,
          template_id: template.id,
          project_id: template.project_id,
          template_version: template.version,
          status: "ready",
          graph: template.graph,
          input: input.input,
          time_created: now,
          time_updated: now,
        })
      }),
      getRun: (runID) =>
        database.db
          .select()
          .from(WorkflowRunTable)
          .where(eq(WorkflowRunTable.id, runID))
          .pipe(
            Effect.map((rows) => rows[0]),
            Effect.flatMap((row) => (row ? Effect.succeed(fromRun(row)) : Effect.fail(new RunNotFoundError({ runID })))),
          ),
      listRuns: (projectID) =>
        database.db
          .select()
          .from(WorkflowRunTable)
          .where(projectID ? eq(WorkflowRunTable.project_id, projectID) : undefined)
          .orderBy(desc(WorkflowRunTable.time_updated))
          .pipe(Effect.map((rows) => rows.map(fromRun))),
      listWorkItems: (runID): Effect.Effect<WorkItem[], unknown> =>
        database.db
          .select({ id: WorkflowRunTable.id })
          .from(WorkflowRunTable)
          .where(eq(WorkflowRunTable.id, runID))
          .pipe(
            Effect.map((rows) => rows[0]),
            Effect.flatMap((run) =>
              run
                ? database.db
                    .select()
                    .from(WorkflowWorkItemTable)
                    .where(eq(WorkflowWorkItemTable.run_id, runID))
                    .pipe(Effect.map((rows) => rows.map(fromWorkItem)), Effect.mapError(() => new RunNotFoundError({ runID })))
                : Effect.fail(new RunNotFoundError({ runID })),
            ),
          ),
      getWorkItemBySession: (sessionID) =>
        database.db
          .select()
          .from(WorkflowWorkItemTable)
          .where(eq(WorkflowWorkItemTable.session_id, sessionID))
          .pipe(Effect.map((rows) => (rows[0] ? fromWorkItem(rows[0]) : undefined))),
      setWorkItemStatus: Effect.fn("Workflow.setWorkItemStatus")(function* (input) {
        const item = yield* database.db
          .select()
          .from(WorkflowWorkItemTable)
          .where(and(eq(WorkflowWorkItemTable.run_id, input.runID), eq(WorkflowWorkItemTable.node_id, input.nodeID)))
          .pipe(Effect.map((rows) => rows[0]))
        if (!item) {
          const run = yield* database.db
            .select({ id: WorkflowRunTable.id })
            .from(WorkflowRunTable)
            .where(eq(WorkflowRunTable.id, input.runID))
            .pipe(Effect.map((rows) => rows[0]))
          if (!run) return yield* new RunNotFoundError({ runID: input.runID })
          return yield* new HandoffValidationError({ message: "Workflow work item does not exist" })
        }
        if (!canTransition(item.status as WorkItemStatus, input.status)) {
          return yield* new HandoffValidationError({ message: `Cannot transition ${item.status} to ${input.status}` })
        }
        if (input.status === "completed") {
          const run = yield* database.db
            .select({ graph: WorkflowRunTable.graph })
            .from(WorkflowRunTable)
            .where(eq(WorkflowRunTable.id, input.runID))
            .pipe(Effect.map((rows) => rows[0]))
          if (!run) return yield* new RunNotFoundError({ runID: input.runID })
          const requiredOutputs = (run.graph as Graph).edges.filter((edge) => {
            const output = (run.graph as Graph).nodes.find((node) => node.id === input.nodeID)?.outputs[edge.sourcePort]
            return edge.sourceNodeID === input.nodeID && output?.mode === "artifact"
          })
          const handoffs = yield* database.db
            .select()
            .from(WorkflowHandoffTable)
            .where(
              and(
                eq(WorkflowHandoffTable.run_id, input.runID),
                eq(WorkflowHandoffTable.source_node_id, input.nodeID),
                eq(WorkflowHandoffTable.mode, "dependency"),
                eq(WorkflowHandoffTable.sealed, true),
              ),
            )
          if (
            !requiredOutputs.every((edge) =>
              handoffs.some(
                (handoff) =>
                  handoff.source_port === edge.sourcePort &&
                  handoff.target_node_id === edge.targetNodeID &&
                  handoff.target_port === edge.targetPort,
              ),
            )
          ) {
            return yield* new HandoffValidationError({ message: "Workflow work item has unsealed required outputs" })
          }
        }
        const now = Date.now()
        yield* database.db
          .update(WorkflowWorkItemTable)
          .set({ status: input.status, time_updated: now })
          .where(and(eq(WorkflowWorkItemTable.run_id, input.runID), eq(WorkflowWorkItemTable.node_id, input.nodeID)))
        yield* events.publish(WorkflowEvent.WorkItemStatusChanged, {
          timestamp: now,
          runID: input.runID,
          nodeID: input.nodeID,
          status: input.status,
          sessionID: item.session_id ?? undefined,
        })
        if (
          item.status === "running" &&
          (input.status === "waiting" || input.status === "completed" || input.status === "failed")
        ) {
          yield* projectSessionCosts(input.runID)
        }
        return { runID: input.runID, nodeID: input.nodeID, status: input.status, time: { created: item.time_created, updated: now } }
      }),
      sendHandoff: Effect.fn("Workflow.sendHandoff")(function* (input) {
        const run = yield* database.db
          .select()
          .from(WorkflowRunTable)
          .where(eq(WorkflowRunTable.id, input.runID))
          .pipe(
            Effect.map((rows) => rows[0]),
            Effect.flatMap((row) =>
              row ? Effect.succeed(row) : Effect.fail(new RunNotFoundError({ runID: input.runID })),
            ),
          )
        const graph = run.graph as Graph
        const source = graph.nodes.find((node) => node.id === input.sourceNodeID)
        const target = graph.nodes.find((node) => node.id === input.targetNodeID)
        const output = source?.outputs[input.sourcePort]
        const port = target?.inputs[input.targetPort]
        if (!source || !target || !output || !port) {
          return yield* new HandoffValidationError({ message: "Workflow handoff references a missing node or port" })
        }
        const mode = output.mode === "artifact" ? "dependency" : "queue"
        if (port.mode !== mode || !port.handoffTypes.includes(output.handoffType)) {
          return yield* new HandoffValidationError({ message: "Workflow handoff does not match its port contract" })
        }
        const connected = graph.edges.some(
          (edge) =>
            edge.sourceNodeID === input.sourceNodeID &&
            edge.sourcePort === input.sourcePort &&
            edge.targetNodeID === input.targetNodeID &&
            edge.targetPort === input.targetPort,
        )
        if (!connected) return yield* new HandoffValidationError({ message: "Workflow handoff has no graph edge" })
        const sequence =
          (yield* database.db
            .select({ value: max(WorkflowHandoffTable.sequence) })
            .from(WorkflowHandoffTable)
            .where(eq(WorkflowHandoffTable.run_id, input.runID))
            .pipe(Effect.map((rows) => rows[0]?.value ?? 0))) + 1
        const id = `workflow-handoff-${Slug.create()}`
        const now = Date.now()
        const sealed = input.sealed ?? mode === "dependency"
        yield* database.db.insert(WorkflowHandoffTable).values({
          id,
          run_id: input.runID,
          source_node_id: input.sourceNodeID,
          source_port: input.sourcePort,
          target_node_id: input.targetNodeID,
          target_port: input.targetPort,
          mode,
          payload: input.payload,
          sequence,
          sealed,
          time_created: now,
          time_updated: now,
        })
        if (mode === "queue") {
          yield* database.db
            .update(WorkflowWorkItemTable)
            .set({ status: "ready", time_updated: now })
            .where(
              and(
                eq(WorkflowWorkItemTable.run_id, input.runID),
                eq(WorkflowWorkItemTable.node_id, input.targetNodeID),
                eq(WorkflowWorkItemTable.status, "waiting"),
              ),
            )
        }
        if (mode === "dependency" && sealed) {
          const requiredEdges = graph.edges.filter((edge) => {
            const targetInput = graph.nodes.find((node) => node.id === input.targetNodeID)?.inputs[edge.targetPort]
            return edge.targetNodeID === input.targetNodeID && targetInput?.mode === "dependency" && targetInput.required
          })
          const dependencies = yield* database.db
            .select()
            .from(WorkflowHandoffTable)
            .where(
              and(
                eq(WorkflowHandoffTable.run_id, input.runID),
                eq(WorkflowHandoffTable.target_node_id, input.targetNodeID),
                eq(WorkflowHandoffTable.mode, "dependency"),
                eq(WorkflowHandoffTable.sealed, true),
              ),
            )
          const satisfied = requiredEdges.every((edge) =>
            dependencies.some(
              (handoff) => handoff.source_node_id === edge.sourceNodeID && handoff.source_port === edge.sourcePort && handoff.target_port === edge.targetPort,
            ),
          )
          if (satisfied) {
            yield* database.db
              .update(WorkflowWorkItemTable)
              .set({ status: "ready", time_updated: now })
              .where(
                and(
                  eq(WorkflowWorkItemTable.run_id, input.runID),
                  eq(WorkflowWorkItemTable.node_id, input.targetNodeID),
                  eq(WorkflowWorkItemTable.status, "pending"),
                ),
              )
          }
        }
        const handoff = fromHandoff({
          id,
          run_id: input.runID,
          source_node_id: input.sourceNodeID,
          source_port: input.sourcePort,
          target_node_id: input.targetNodeID,
          target_port: input.targetPort,
          mode,
          payload: input.payload,
          sequence,
          sealed,
          time_created: now,
          time_updated: now,
        })
        yield* events.publish(WorkflowEvent.HandoffSent, { timestamp: now, runID: input.runID, handoff })
        return handoff
      }),
      readQueue: Effect.fn("Workflow.readQueue")(function* (input) {
        const run = yield* database.db
          .select({ id: WorkflowRunTable.id, graph: WorkflowRunTable.graph })
          .from(WorkflowRunTable)
          .where(eq(WorkflowRunTable.id, input.runID))
          .pipe(
            Effect.map((rows) => rows[0]),
            Effect.flatMap((row) =>
              row ? Effect.succeed(row) : Effect.fail(new RunNotFoundError({ runID: input.runID })),
            ),
          )
        const node = (run.graph as Graph).nodes.find((item) => item.id === input.nodeID)
        if (node?.inputs[input.port]?.mode !== "queue") {
          return yield* new HandoffValidationError({ message: "Workflow input is not a queue port" })
        }
        const cursor = yield* database.db
          .select()
          .from(WorkflowQueueCursorTable)
          .where(
            and(
              eq(WorkflowQueueCursorTable.run_id, input.runID),
              eq(WorkflowQueueCursorTable.node_id, input.nodeID),
              eq(WorkflowQueueCursorTable.port, input.port),
            ),
          )
          .pipe(Effect.map((rows) => rows[0]?.sequence ?? 0))
        return yield* database.db
          .select()
          .from(WorkflowHandoffTable)
          .where(
            and(
              eq(WorkflowHandoffTable.run_id, input.runID),
              eq(WorkflowHandoffTable.target_node_id, input.nodeID),
              eq(WorkflowHandoffTable.target_port, input.port),
              eq(WorkflowHandoffTable.mode, "queue"),
              gt(WorkflowHandoffTable.sequence, cursor),
            ),
          )
          .orderBy(asc(WorkflowHandoffTable.sequence))
          .pipe(Effect.map((rows) => rows.map(fromHandoff)))
      }),
      acknowledgeQueue: Effect.fn("Workflow.acknowledgeQueue")(function* (input) {
        const handoff = yield* database.db
          .select()
          .from(WorkflowHandoffTable)
          .where(
            and(
              eq(WorkflowHandoffTable.run_id, input.runID),
              eq(WorkflowHandoffTable.target_node_id, input.nodeID),
              eq(WorkflowHandoffTable.target_port, input.port),
              eq(WorkflowHandoffTable.mode, "queue"),
              eq(WorkflowHandoffTable.sequence, input.sequence),
            ),
          )
          .pipe(Effect.map((rows) => rows[0]))
        if (!handoff) return yield* new HandoffValidationError({ message: "Workflow queue handoff does not exist" })
        const now = Date.now()
        yield* database.db
          .insert(WorkflowQueueCursorTable)
          .values({ run_id: input.runID, node_id: input.nodeID, port: input.port, sequence: input.sequence, time_created: now, time_updated: now })
          .onConflictDoUpdate({
            target: [WorkflowQueueCursorTable.run_id, WorkflowQueueCursorTable.node_id, WorkflowQueueCursorTable.port],
            set: { sequence: input.sequence, time_updated: now },
          })
        yield* events.publish(WorkflowEvent.QueueAcknowledged, {
          timestamp: now,
          runID: input.runID,
          nodeID: input.nodeID,
          port: input.port,
          sequence: input.sequence,
        })
      }),
      history: Effect.fn("Workflow.history")(function* (input) {
        const run = yield* database.db
          .select({ id: WorkflowRunTable.id })
          .from(WorkflowRunTable)
          .where(eq(WorkflowRunTable.id, input.runID))
          .pipe(Effect.map((rows) => rows[0]))
        if (!run) return yield* new RunNotFoundError({ runID: input.runID })
        return yield* EventV2.readAggregate(database.db, {
          aggregateID: input.runID,
          after: input.after,
          limit: input.limit,
          manifest: { definitions: Event.durable(WorkflowEvent.DurableDefinitions), schema: WorkflowEvent.Durable },
        })
      }),
      recordAttemptCost: Effect.fn("Workflow.recordAttemptCost")(function* (input) {
        const run = yield* database.db
          .select({ graph: WorkflowRunTable.graph })
          .from(WorkflowRunTable)
          .where(eq(WorkflowRunTable.id, input.runID))
          .pipe(
            Effect.map((rows) => rows[0]),
            Effect.flatMap((row) =>
              row ? Effect.succeed(row) : Effect.fail(new RunNotFoundError({ runID: input.runID })),
            ),
          )
        if (!(run.graph as Graph).nodes.some((node) => node.id === input.nodeID)) {
          return yield* new HandoffValidationError({ message: "Workflow cost references a missing node" })
        }
        const price = yield* database.db
          .select()
          .from(ModelPriceSnapshotTable)
          .where(
            and(
              eq(ModelPriceSnapshotTable.provider_id, input.providerID),
              eq(ModelPriceSnapshotTable.model_id, input.modelID),
            ),
          )
          .orderBy(desc(ModelPriceSnapshotTable.effective_at))
          .pipe(Effect.map((rows) => rows[0]))
        const prices = price?.prices as Record<string, number | undefined> | undefined
        const estimatedMicrousd = prices
          ? Math.round(
              (input.usage.input * (prices.input ?? 0) +
                input.usage.output * (prices.output ?? 0) +
                input.usage.reasoning * (prices.reasoning ?? 0) +
                input.usage.cacheRead * (prices.cacheRead ?? 0) +
                input.usage.cacheWrite * (prices.cacheWrite ?? 0)),
            )
          : undefined
        const now = Date.now()
        yield* database.db.insert(WorkflowAttemptCostTable).values({
          id: `workflow-cost-${Slug.create()}`,
          run_id: input.runID,
          node_id: input.nodeID,
          provider_id: input.providerID,
          model_id: input.modelID,
          price_snapshot_id: price?.id,
          usage: input.usage,
          source_message_id: input.sourceMessageID,
          estimated_microusd: estimatedMicrousd,
          status: price ? "priced" : "unpriced",
          time_created: now,
          time_updated: now,
        })
        return { estimatedMicrousd }
      }),
      projectSessionCosts: (projectSessionCosts = Effect.fn("Workflow.projectSessionCosts")(function* (runID) {
        const run = yield* database.db
          .select({ id: WorkflowRunTable.id })
          .from(WorkflowRunTable)
          .where(eq(WorkflowRunTable.id, runID))
          .pipe(
            Effect.map((rows) => rows[0]),
            Effect.flatMap((row) => (row ? Effect.succeed(row) : Effect.fail(new RunNotFoundError({ runID }))),
          )
        )
        const workItems = yield* database.db
          .select()
          .from(WorkflowWorkItemTable)
          .where(eq(WorkflowWorkItemTable.run_id, run.id))
        const sessionNodes = new Map(
          workItems
            .filter((item): item is typeof item & { session_id: string } => item.session_id !== null)
            .map((item) => [SessionSchema.ID.make(item.session_id), item.node_id] as const),
        )
        if (sessionNodes.size === 0) return 0
        const rows = yield* database.db
          .select()
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.type, "assistant"),
              inArray(SessionMessageTable.session_id, Array.from(sessionNodes.keys())),
            ),
          )
        const entries = rows.flatMap((row) => {
          const decoded = Schema.decodeUnknownOption(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type })
          if (Option.isNone(decoded)) return []
          const entry = { message: decoded.value, sessionID: row.session_id }
          const nodeID = sessionNodes.get(entry.sessionID)
          if (!nodeID || entry.message.type !== "assistant" || !entry.message.tokens) return []
          return [{ nodeID, message: entry.message, tokens: entry.message.tokens }]
        })
        yield* Effect.forEach(
          entries,
          ({ nodeID, message, tokens }) =>
            Effect.gen(function* () {
              const price = yield* database.db
                .select()
                .from(ModelPriceSnapshotTable)
                .where(
                  and(
                    eq(ModelPriceSnapshotTable.provider_id, message.model.providerID),
                    eq(ModelPriceSnapshotTable.model_id, message.model.id),
                  ),
                )
                .orderBy(desc(ModelPriceSnapshotTable.effective_at))
                .pipe(Effect.map((rows) => rows[0]))
              const usage = {
                input: tokens.input,
                output: tokens.output,
                reasoning: tokens.reasoning,
                cacheRead: tokens.cache.read,
                cacheWrite: tokens.cache.write,
              }
              const prices = price?.prices as Record<string, number | undefined> | undefined
              const estimatedMicrousd = prices
                ? Math.round(
                    usage.input * (prices.input ?? 0) +
                      usage.output * (prices.output ?? 0) +
                      usage.reasoning * (prices.reasoning ?? 0) +
                      usage.cacheRead * (prices.cacheRead ?? 0) +
                      usage.cacheWrite * (prices.cacheWrite ?? 0),
                  )
                : undefined
              yield* database.db
                .insert(WorkflowAttemptCostTable)
                .values({
                  id: `workflow-cost-${Slug.create()}`,
                  run_id: runID,
                  node_id: nodeID,
                  source_message_id: message.id,
                  provider_id: message.model.providerID,
                  model_id: message.model.id,
                  price_snapshot_id: price?.id,
                  usage,
                  estimated_microusd: estimatedMicrousd,
                  status: price ? "priced" : "unpriced",
                })
                .onConflictDoNothing()
                .run()
            }),
          { discard: true },
        )
        return entries.length
      })),
      costReport: Effect.fn("Workflow.costReport")(function* (runID) {
        yield* projectSessionCosts(runID)
        const rows = yield* database.db
          .select()
          .from(WorkflowAttemptCostTable)
          .where(eq(WorkflowAttemptCostTable.run_id, runID))
        const groups = new Map<string, CostGroup>()
        for (const row of rows) {
          const usage = row.usage as TokenUsage
          const key = `${row.provider_id}\0${row.model_id}`
          const current = groups.get(key) ?? {
            providerID: row.provider_id,
            modelID: row.model_id,
            usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
            pricedAttempts: 0,
            unpricedAttempts: 0,
          }
          groups.set(key, {
            providerID: current.providerID,
            modelID: current.modelID,
            usage: {
              input: current.usage.input + usage.input,
              output: current.usage.output + usage.output,
              reasoning: current.usage.reasoning + usage.reasoning,
              cacheRead: current.usage.cacheRead + usage.cacheRead,
              cacheWrite: current.usage.cacheWrite + usage.cacheWrite,
            },
            estimatedMicrousd:
              row.status === "priced" && row.estimated_microusd !== null
                ? (current.estimatedMicrousd ?? 0) + row.estimated_microusd
                : current.estimatedMicrousd,
            pricedAttempts: current.pricedAttempts + (row.status === "priced" ? 1 : 0),
            unpricedAttempts: current.unpricedAttempts + (row.status === "priced" ? 0 : 1),
          })
        }
        const report = Array.from(groups.values())
        const estimatedMicrousd = report.reduce((total, group) => total + (group.estimatedMicrousd ?? 0), 0)
        return {
          runID,
          estimatedMicrousd: report.some((group) => group.pricedAttempts > 0) ? estimatedMicrousd : undefined,
          unpricedAttempts: report.reduce((total, group) => total + group.unpricedAttempts, 0),
          groups: report,
        }
      }),
    }
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, EventV2.node] })

function hasRequiredDependencies(graph: Graph, nodeID: string) {
  return graph.edges.some((edge) => {
    const input = graph.nodes.find((node) => node.id === nodeID)?.inputs[edge.targetPort]
    return edge.targetNodeID === nodeID && input?.mode === "dependency" && input.required
  })
}

function canTransition(from: WorkItemStatus, to: WorkItemStatus) {
  if (from === to) return true
  if (from === "pending") return to === "ready" || to === "blocked" || to === "cancelled"
  if (from === "ready") return to === "running" || to === "blocked" || to === "cancelled"
  if (from === "running") return to === "waiting" || to === "completed" || to === "failed" || to === "blocked" || to === "cancelled"
  if (from === "waiting") return to === "ready" || to === "blocked" || to === "completed" || to === "failed" || to === "cancelled"
  if (from === "blocked") return to === "ready" || to === "cancelled"
  if (from === "failed") return to === "ready" || to === "cancelled"
  return false
}

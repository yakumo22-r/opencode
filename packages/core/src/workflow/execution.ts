export * as WorkflowExecution from "./execution"

import { and, asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema, Semaphore, Stream } from "effect"
import path from "path"
import { Database } from "../database/database"
import { AgentV2 } from "../agent"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { Location } from "../location"
import { AbsolutePath } from "../schema"
import { SessionV2 } from "../session"
import { SessionSchema } from "../session/schema"
import { Workflow } from "../workflow"
import { WorkflowEvent } from "./event"
import { WorkflowHandoffTable, WorkflowRunTable, WorkflowWorkItemTable } from "./sql"

export class WorkspaceTargetError extends Schema.TaggedErrorClass<WorkspaceTargetError>()("WorkflowExecution.WorkspaceTargetError", {
  runID: Schema.String,
  nodeID: Schema.String,
}) {}

export class PromptFileError extends Schema.TaggedErrorClass<PromptFileError>()("WorkflowExecution.PromptFileError", {
  path: Schema.String,
}) {}

export interface Interface {
  readonly drain: (runID: string) => Effect.Effect<Workflow.WorkItem[], WorkspaceTargetError | PromptFileError | unknown>
  readonly execute: (runID: string) => Effect.Effect<Workflow.WorkItem[], WorkspaceTargetError | PromptFileError | unknown>
  readonly advance: (runID: string) => Effect.Effect<Workflow.WorkItem[], WorkspaceTargetError | PromptFileError | unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/workflow/WorkflowExecution") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const session = yield* SessionV2.Service
    const workflow = yield* Workflow.Service
    const events = yield* EventV2.Service
    const writeLocks = new Map<string, Semaphore.Semaphore>()
    const workItemLocks = new Map<string, Semaphore.Semaphore>()
    const runLocks = new Map<string, Semaphore.Semaphore>()
    const started = new Set<string>()

    let drain!: (runID: string) => Effect.Effect<Workflow.WorkItem[], WorkspaceTargetError | PromptFileError | unknown>
    let execute!: (runID: string) => Effect.Effect<Workflow.WorkItem[], WorkspaceTargetError | PromptFileError | unknown>
    let advance!: (runID: string) => Effect.Effect<Workflow.WorkItem[], WorkspaceTargetError | PromptFileError | unknown>

    const service = Service.of({
      drain: (drain = Effect.fn("WorkflowExecution.drain")(function* (runID) {
        const run = yield* database.db
          .select()
          .from(WorkflowRunTable)
          .where(eq(WorkflowRunTable.id, runID))
          .pipe(Effect.map((rows) => rows[0]))
        if (!run) return []
        const graph = run.graph as Workflow.Graph
        const ready = yield* database.db
          .select()
          .from(WorkflowWorkItemTable)
          .where(and(eq(WorkflowWorkItemTable.run_id, runID), eq(WorkflowWorkItemTable.status, "ready")))
        return yield* Effect.forEach(ready, (item) =>
          Effect.gen(function* () {
            const current = yield* database.db
              .select()
              .from(WorkflowWorkItemTable)
              .where(and(eq(WorkflowWorkItemTable.run_id, runID), eq(WorkflowWorkItemTable.node_id, item.node_id)))
              .pipe(Effect.map((rows) => rows[0]))
            if (!current || current.status !== "ready") return current ? toWorkItem(current) : toWorkItem(item)
            const node = graph.nodes.find((candidate) => candidate.id === item.node_id)
            if (node?.kind === "root") {
              yield* emitRoot(runID, graph, node, run.input)
              const settled = yield* database.db
                .select()
                .from(WorkflowWorkItemTable)
                .where(and(eq(WorkflowWorkItemTable.run_id, runID), eq(WorkflowWorkItemTable.node_id, item.node_id)))
                .pipe(Effect.map((rows) => rows[0]))
              return settled ? toWorkItem(settled) : toWorkItem(item)
            }
            if (!node || node.workspace.mode === "none" || !node.workspace.directory) {
              return yield* new WorkspaceTargetError({ runID, nodeID: item.node_id })
            }
            const sessionInfo = current.session_id
              ? yield* session.get(SessionSchema.ID.make(current.session_id))
              : yield* session.create({
                  location: Location.Ref.make({ directory: AbsolutePath.make(node.workspace.directory) }),
                  agent: node.agentProfileID ? AgentV2.ID.make(node.agentProfileID) : undefined,
                  model: node.model,
                })
            const dependencies = yield* database.db
              .select()
              .from(WorkflowHandoffTable)
              .where(
                and(
                  eq(WorkflowHandoffTable.run_id, runID),
                  eq(WorkflowHandoffTable.target_node_id, item.node_id),
                  eq(WorkflowHandoffTable.mode, "dependency"),
                  eq(WorkflowHandoffTable.sealed, true),
                ),
              )
              .orderBy(asc(WorkflowHandoffTable.sequence))
            const queues = (
              yield* Effect.forEach(
                Object.keys(node.inputs).filter((port) => node.inputs[port]?.mode === "queue"),
                (port) => workflow.readQueue({ runID, nodeID: node.id, port }),
              )
            )
              .flat()
              .slice(0, 8)
            const promptQueues = queues.filter((handoff) => handoff.targetPort.startsWith("prompt"))
            yield* session.prompt({
              sessionID: sessionInfo.id,
              prompt: {
                  text: current.session_id
                    ? continuationPrompt(node, queues)
                    : yield* buildPrompt(runID, graph, node, run.input, dependencies, queues, promptQueues),
              },
              resume: false,
            })
            yield* Effect.forEach(queues, (handoff) =>
              workflow.acknowledgeQueue({
                runID,
                nodeID: node.id,
                port: handoff.targetPort,
                sequence: handoff.sequence,
              }),
            )
            const now = Date.now()
            yield* database.db
              .update(WorkflowWorkItemTable)
              .set({ session_id: sessionInfo.id, time_updated: now })
              .where(
                and(
                  eq(WorkflowWorkItemTable.run_id, runID),
                  eq(WorkflowWorkItemTable.node_id, item.node_id),
                  eq(WorkflowWorkItemTable.status, "ready"),
                ),
              )
            yield* workflow.setWorkItemStatus({ runID, nodeID: item.node_id, status: "running" })
            return {
              runID,
              nodeID: item.node_id,
              status: "running" as const,
              sessionID: sessionInfo.id,
              time: { created: current.time_created, updated: now },
            }
          }).pipe((effect) => {
            const key = `${runID}:${item.node_id}`
            const lock = workItemLocks.get(key) ?? Semaphore.makeUnsafe(1)
            workItemLocks.set(key, lock)
            return lock.withPermit(effect)
          }),
        )
      })),
      execute: (execute = Effect.fn("WorkflowExecution.execute")(function* (runID) {
        yield* drain(runID)
        const run = yield* database.db
          .select()
          .from(WorkflowRunTable)
          .where(eq(WorkflowRunTable.id, runID))
          .pipe(Effect.map((rows) => rows[0]))
        if (!run) return []
        const graph = run.graph as Workflow.Graph
        const running = yield* database.db
          .select()
          .from(WorkflowWorkItemTable)
          .where(and(eq(WorkflowWorkItemTable.run_id, runID), eq(WorkflowWorkItemTable.status, "running")))
        return yield* Effect.forEach(running, (item) =>
          Effect.gen(function* () {
            if (!item.session_id) return yield* new WorkspaceTargetError({ runID, nodeID: item.node_id })
            yield* session.resume(SessionSchema.ID.make(item.session_id))
            const now = Date.now()
            const current = yield* database.db
              .select()
              .from(WorkflowWorkItemTable)
              .where(and(eq(WorkflowWorkItemTable.run_id, runID), eq(WorkflowWorkItemTable.node_id, item.node_id)))
              .pipe(Effect.map((rows) => rows[0]))
            if (current?.status === "running") {
              yield* workflow.setWorkItemStatus({ runID, nodeID: item.node_id, status: "waiting" })
              const node = graph.nodes.find((candidate) => candidate.id === item.node_id)
              const messages = node
                ? (yield* Effect.forEach(Object.keys(node.inputs).filter((port) => node.inputs[port]?.mode === "queue"), (port) => workflow.readQueue({ runID, nodeID: node.id, port }))).flat()
                : []
              if (messages.length > 0) yield* workflow.setWorkItemStatus({ runID, nodeID: item.node_id, status: "ready" })
            }
            const settled = yield* database.db
              .select()
              .from(WorkflowWorkItemTable)
              .where(and(eq(WorkflowWorkItemTable.run_id, runID), eq(WorkflowWorkItemTable.node_id, item.node_id)))
              .pipe(Effect.map((rows) => rows[0]))
            return settled ? toWorkItem(settled) : toWorkItem(item)
          }).pipe((effect) => {
            const node = graph.nodes.find((candidate) => candidate.id === item.node_id)
            if (!node || (node.workspace.mode !== "write" && node.workspace.mode !== "isolated-write") || !node.workspace.directory)
              return effect
            const lock = writeLocks.get(node.workspace.directory) ?? Semaphore.makeUnsafe(1)
            writeLocks.set(node.workspace.directory, lock)
            return lock.withPermit(effect)
          }),
          { concurrency: "unbounded" },
        )
      })),
      advance: (advance = Effect.fn("WorkflowExecution.advance")(function* (runID) {
        started.add(runID)
        const lock = runLocks.get(runID) ?? Semaphore.makeUnsafe(1)
        runLocks.set(runID, lock)
        return yield* lock.withPermit(step(runID, 32))
      })),
    })
    yield* events.subscribe(WorkflowEvent.WorkItemStatusChanged).pipe(
      Stream.runForEach((event) => {
        if (event.data.status !== "ready" || !started.has(event.data.runID)) return Effect.void
        return advance(event.data.runID).pipe(Effect.catch(() => Effect.void))
      }),
      Effect.forkScoped({ startImmediately: true }),
    )
    return service

    function emitRoot(runID: string, graph: Workflow.Graph, node: Workflow.Graph["nodes"][number], input: unknown) {
      return Effect.gen(function* () {
        yield* workflow.setWorkItemStatus({ runID, nodeID: node.id, status: "running" })
        yield* Effect.forEach(
          graph.edges.filter((edge) => edge.sourceNodeID === node.id),
          (edge) =>
            workflow.sendHandoff({
              runID,
              sourceNodeID: node.id,
              sourcePort: edge.sourcePort,
              targetNodeID: edge.targetNodeID,
              targetPort: edge.targetPort,
              payload: (input ?? {}) as typeof Schema.Json.Type,
              sealed: true,
            }),
        )
        yield* workflow.setWorkItemStatus({ runID, nodeID: node.id, status: "completed" })
      })
    }

    function step(runID: string, remaining: number): Effect.Effect<Workflow.WorkItem[], WorkspaceTargetError | unknown> {
      return Effect.gen(function* () {
        const items = yield* database.db
          .select()
          .from(WorkflowWorkItemTable)
          .where(eq(WorkflowWorkItemTable.run_id, runID))
          .pipe(Effect.map((rows) => rows.map(toWorkItem)))
        if (remaining === 0 || !items.some((item) => item.status === "ready" || item.status === "running")) return items
        yield* execute(runID)
        return yield* step(runID, remaining - 1)
      })
    }
  }),
)

function buildPrompt(
  runID: string,
  graph: Workflow.Graph,
  node: Workflow.Graph["nodes"][number],
  input: unknown,
  dependencies: ReadonlyArray<typeof WorkflowHandoffTable.$inferSelect>,
  queues: ReadonlyArray<Workflow.Handoff>,
  promptQueues: ReadonlyArray<Workflow.Handoff>,
) {
  return Effect.gen(function* () {
    const directory = node.workspace.directory
    const base = directory && graph.promptFile ? yield* readPromptFile(directory, graph.promptFile) : undefined
    const stage = directory && node.promptFile ? yield* readPromptFile(directory, node.promptFile) : undefined
    const files = directory && node.config.promptFiles && typeof node.config.promptFiles === "object" && !Array.isArray(node.config.promptFiles)
      ? yield* Effect.forEach(Object.entries(node.config.promptFiles as Record<string, unknown>), ([port, file]) =>
          typeof file === "string" && file.length > 0
            ? readPromptFile(directory, file).pipe(Effect.map((text) => `${port}: ${text}`))
            : Effect.succeed(undefined),
        )
      : []
    return [base, stage, files.length ? `Additional prompt files:\n${files.filter((file): file is string => !!file).join("\n")}` : undefined, promptQueues.length ? `Prompt port inputs:\n${promptQueues.map((item) => `- ${item.targetPort}: ${JSON.stringify(item.payload)}`).join("\n")}` : undefined, workflowPrompt(runID, graph, node, input, dependencies, queues)].filter((part): part is string => !!part).join("\n\n")
  })
}

function readPromptFile(directory: string, relative: string) {
  return Effect.gen(function* () {
    const root = path.resolve(directory)
    const file = path.resolve(root, relative)
    if (file !== root && !file.startsWith(root + path.sep)) return yield* new PromptFileError({ path: relative })
    return yield* Effect.tryPromise({
      try: () => Bun.file(file).text(),
      catch: () => new PromptFileError({ path: relative }),
    })
  })
}

function workflowPrompt(
  runID: string,
  graph: Workflow.Graph,
  node: Workflow.Graph["nodes"][number],
  input: unknown,
  dependencies: ReadonlyArray<typeof WorkflowHandoffTable.$inferSelect>,
  queues: ReadonlyArray<Workflow.Handoff>,
) {
  const incoming = graph.edges.filter((edge) => edge.targetNodeID === node.id)
  const outgoing = graph.edges.filter((edge) => edge.sourceNodeID === node.id)
  const inputs = Object.keys(node.inputs).flatMap((port) => {
    const spec = node.inputs[port]
    if (!spec) return []
    const sources = incoming.filter((edge) => edge.targetPort === port).map((edge) => `${edge.sourceNodeID}.${edge.sourcePort}`)
    return [`- ${port} (${spec.mode}, ${spec.required ? "required" : "optional"}, ${spec.handoffTypes.join("|")}): ${sources.join(", ") || "unconnected"}`]
  })
  const outputs = Object.keys(node.outputs).flatMap((port) => {
    const spec = node.outputs[port]
    if (!spec) return []
    const targets = outgoing.filter((edge) => edge.sourcePort === port).map((edge) => `${edge.targetNodeID}.${edge.targetPort}`)
    return [`- ${port} (${spec.mode}, ${spec.handoffType}): ${targets.join(", ") || "unconnected"}`]
  })
  const extraPrompts = node.config.promptTexts && typeof node.config.promptTexts === "object" && !Array.isArray(node.config.promptTexts)
    ? Object.entries(node.config.promptTexts as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
        .map(([port, text]) => `- ${port}: ${text}`)
    : []
  const promptFiles = node.config.promptFiles && typeof node.config.promptFiles === "object" && !Array.isArray(node.config.promptFiles)
    ? Object.entries(node.config.promptFiles as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
        .map(([port, file]) => `${port}: ${file}`)
    : []
  const artifacts = dependencies.map(
    (item) => `- ${item.source_node_id}.${item.source_port} -> ${item.target_port}: ${JSON.stringify(item.payload)}`,
  )
  const encoded = input === undefined || input === null || JSON.stringify(input) === "{}" ? undefined : `Run input: ${JSON.stringify(input)}`
  return [
    `You are executing workflow ${runID}, node ${node.id} (${node.kind}): ${node.title}.`,
    `Objective: ${node.objective}`,
    extraPrompts.length ? `Additional prompt ports:\n${extraPrompts.join("\n")}` : undefined,
    promptFiles.length ? `Additional prompt files:\n${promptFiles.join("\n")}` : undefined,
    encoded,
    inputs.length ? `Input ports:\n${inputs.join("\n")}` : undefined,
    outputs.length ? `Output ports:\n${outputs.join("\n")}` : undefined,
    artifacts.length ? `Incoming sealed artifacts:\n${artifacts.join("\n")}` : undefined,
    queueSection(queues),
    [
      "Use workflow tools:",
      "- workflow_send_handoff to emit a port payload. Set sealed true for final artifact outputs.",
       "- workflow_complete_work_item only after every connected artifact output is sealed and no more peer messages are expected.",
    ].join("\n"),
    "Do not claim final completion until the workflow runtime records required output handoffs.",
  ]
    .filter((part): part is string => !!part)
    .join("\n\n")
}

function continuationPrompt(node: Workflow.Graph["nodes"][number], queues: ReadonlyArray<Workflow.Handoff>) {
  return [
    `Continue workflow node ${node.id}: ${node.title}.`,
    `Objective: ${node.objective}`,
    queueSection(queues) ?? "No new queue messages. Continue the objective, send required handoffs, wait, or complete.",
    "Use workflow_send_handoff and workflow_complete_work_item as needed. Incoming peer messages are injected automatically.",
  ].join("\n\n")
}

function queueSection(queues: ReadonlyArray<Workflow.Handoff>) {
  if (queues.length === 0) return undefined
  return `New queue messages:\n${queues
    .map((item) => `- ${item.sourceNodeID}.${item.sourcePort} -> ${item.targetPort} seq=${item.sequence}: ${JSON.stringify(item.payload)}`)
    .join("\n")}`
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, SessionV2.node, Workflow.node],
})

function toWorkItem(item: typeof WorkflowWorkItemTable.$inferSelect): Workflow.WorkItem {
  return {
    runID: item.run_id,
    nodeID: item.node_id,
    status: item.status as Workflow.WorkItemStatus,
    sessionID: item.session_id ?? undefined,
    time: { created: item.time_created, updated: item.time_updated },
  }
}

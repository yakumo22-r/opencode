export * as WorkflowTools from "./tools"

import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { Tool } from "../tool/tool"
import { ApplicationTools } from "../tool/application-tools"
import { Workflow } from "../workflow"

export class WorkItemNotFoundError extends Schema.TaggedErrorClass<WorkItemNotFoundError>()("WorkflowTools.WorkItemNotFoundError", {
  sessionID: Schema.String,
}) {}

export interface Interface {
  readonly workItem: (sessionID: string) => Effect.Effect<Workflow.WorkItem, WorkItemNotFoundError | unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/workflow/WorkflowTools") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const workflow = yield* Workflow.Service
    const applications = yield* ApplicationTools.Service
    const workItem = Effect.fn("WorkflowTools.workItem")(function* (sessionID: string) {
      const item = yield* workflow.getWorkItemBySession(sessionID)
      if (!item) return yield* new WorkItemNotFoundError({ sessionID })
      return item
    })
    const tools = {
      workflow_send_handoff: Tool.make({
        scope: "workflow",
        description: "Send a workflow handoff through one of this node's declared output ports.",
        input: Schema.Struct({
          sourcePort: Schema.String,
          targetNodeID: Schema.String,
          targetPort: Schema.String,
          payload: Schema.Json,
          sealed: Schema.Boolean.pipe(Schema.optional),
        }),
        output: Schema.Struct({ id: Schema.String, sequence: Schema.Number, mode: Schema.String }),
        execute: (input, context) =>
          Effect.gen(function* () {
            const item = yield* workItem(context.sessionID).pipe(
              Effect.mapError(toToolFailure),
            )
            const handoff = yield* workflow
              .sendHandoff({
                runID: item.runID,
                sourceNodeID: item.nodeID,
                sourcePort: input.sourcePort,
                targetNodeID: input.targetNodeID,
                targetPort: input.targetPort,
                payload: input.payload,
                sealed: input.sealed,
              })
              .pipe(Effect.mapError(toToolFailure))
            return { id: handoff.id, sequence: handoff.sequence, mode: handoff.mode }
          }),
      }),
      workflow_complete_work_item: Tool.make({
        scope: "workflow",
        description: "Mark this workflow node complete after all required final output handoffs are sealed.",
        input: Schema.Struct({}),
        output: Schema.Struct({ status: Schema.Literal("completed") }),
        execute: (_, context) =>
          Effect.gen(function* () {
            const item = yield* workItem(context.sessionID).pipe(
              Effect.mapError(toToolFailure),
            )
            yield* workflow
              .setWorkItemStatus({ runID: item.runID, nodeID: item.nodeID, status: "completed" })
              .pipe(Effect.mapError(toToolFailure))
            return { status: "completed" as const }
          }),
      }),
    }
    yield* applications.register(tools).pipe(Effect.orDie)
    return Service.of({ workItem })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Workflow.node, ApplicationTools.node] })

function toToolFailure(error: unknown) {
  return new Tool.Failure({ message: error instanceof Error ? error.message : String(error) })
}

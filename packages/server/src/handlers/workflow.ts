import { Workflow } from "@opencode-ai/core/workflow"
import { WorkflowExecution } from "@opencode-ai/core/workflow/execution"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InvalidRequestError, WorkflowRunNotFoundError, WorkflowTemplateNotFoundError } from "@opencode-ai/protocol/errors"
import { Api } from "../api"

export const WorkflowHandler = HttpApiBuilder.group(Api, "server.workflow", (handlers) =>
  Effect.gen(function* () {
    const workflow = yield* Workflow.Service
    const execution = yield* WorkflowExecution.Service

    return handlers
      .handle("workflow.listTemplates", Effect.fn(function* (ctx) {
        return { data: yield* workflow.listTemplates(ctx.query.projectID).pipe(Effect.orDie) }
      }))
      .handle("workflow.createTemplate", Effect.fn(function* (ctx) {
        return {
          data: yield* workflow.createTemplate(ctx.payload).pipe(
            Effect.catch((error: unknown) =>
              error instanceof Workflow.GraphValidationError
                ? Effect.fail(new InvalidRequestError({ message: error.message }))
                : Effect.die(error),
            ),
          ),
        }
      }))
      .handle("workflow.updateTemplate", Effect.fn(function* (ctx) {
        return {
          data: yield* workflow
            .updateTemplate({ templateID: ctx.params.templateID, ...ctx.payload })
            .pipe(mapTemplateError),
        }
      }))
      .handle("workflow.getTemplate", Effect.fn(function* (ctx) {
        return {
          data: yield* workflow.getTemplate(ctx.params.templateID).pipe(
            Effect.catch((error: unknown) =>
              error instanceof Workflow.TemplateNotFoundError
                ? Effect.fail(
                    new WorkflowTemplateNotFoundError({
                      templateID: error.templateID,
                      message: `Workflow template not found: ${error.templateID}`,
                    }),
                  )
                : Effect.die(error),
            ),
          ),
        }
      }))
      .handle("workflow.createRun", Effect.fn(function* (ctx) {
        return {
          data: yield* workflow.createRun({ templateID: ctx.payload.templateID, input: ctx.payload.input ?? {} }).pipe(
            Effect.catch((error: unknown) =>
              error instanceof Workflow.TemplateNotFoundError
                ? Effect.fail(
                    new WorkflowTemplateNotFoundError({
                      templateID: error.templateID,
                      message: `Workflow template not found: ${error.templateID}`,
                    }),
                  )
                : Effect.die(error),
            ),
          ),
        }
      }))
      .handle("workflow.listRuns", Effect.fn(function* (ctx) {
        return { data: yield* workflow.listRuns(ctx.query.projectID).pipe(Effect.orDie) }
      }))
      .handle("workflow.getRun", Effect.fn(function* (ctx) {
        return {
          data: yield* workflow.getRun(ctx.params.runID).pipe(
            Effect.catch((error: unknown) =>
              error instanceof Workflow.RunNotFoundError
                ? Effect.fail(new WorkflowRunNotFoundError({ runID: error.runID, message: `Workflow run not found: ${error.runID}` }))
                : Effect.die(error),
            ),
          ),
        }
      }))
      .handle("workflow.history", Effect.fn(function* (ctx) {
        const history = yield* workflow.history({ runID: ctx.params.runID, after: ctx.query.after, limit: ctx.query.limit ?? 100 }).pipe(
          Effect.catch((error: unknown) =>
            error instanceof Workflow.RunNotFoundError
              ? Effect.fail(new WorkflowRunNotFoundError({ runID: error.runID, message: `Workflow run not found: ${error.runID}` }))
              : Effect.die(error),
          ),
        )
        return { data: history.events, hasMore: history.hasMore }
      }))
      .handle("workflow.listWorkItems", Effect.fn(function* (ctx) {
        return {
          data: yield* workflow.listWorkItems(ctx.params.runID).pipe(
            Effect.catch((error: unknown) =>
              error instanceof Workflow.RunNotFoundError
                ? Effect.fail(new WorkflowRunNotFoundError({ runID: error.runID, message: `Workflow run not found: ${error.runID}` }))
                : Effect.die(error),
            ),
          ),
        }
      }))
      .handle("workflow.updateWorkItem", Effect.fn(function* (ctx) {
        return {
          data: yield* workflow
            .setWorkItemStatus({ runID: ctx.params.runID, nodeID: ctx.params.nodeID, status: ctx.payload.status })
            .pipe(mapWorkflowError),
        }
      }))
      .handle("workflow.getCost", Effect.fn(function* (ctx) {
        return {
          data: yield* workflow.costReport(ctx.params.runID).pipe(
            Effect.catch((error: unknown) =>
              error instanceof Workflow.RunNotFoundError
                ? Effect.fail(new WorkflowRunNotFoundError({ runID: error.runID, message: `Workflow run not found: ${error.runID}` }))
                : Effect.die(error),
            ),
          ),
        }
      }))
      .handle("workflow.sendHandoff", Effect.fn(function* (ctx) {
        return {
          data: yield* workflow.sendHandoff({ runID: ctx.params.runID, ...ctx.payload }).pipe(mapWorkflowError),
        }
      }))
      .handle("workflow.readHandoffQueue", Effect.fn(function* (ctx) {
        return {
          data: yield* workflow.readQueue(ctx.params).pipe(mapWorkflowError),
        }
      }))
      .handle("workflow.acknowledgeHandoffQueue", Effect.fn(function* (ctx) {
        yield* workflow.acknowledgeQueue({ ...ctx.params, sequence: ctx.payload.sequence }).pipe(mapWorkflowError)
        return { data: undefined }
      }))
      .handle("workflow.drain", Effect.fn(function* (ctx) {
        yield* workflow.getRun(ctx.params.runID).pipe(
          Effect.catch((error: unknown) =>
            error instanceof Workflow.RunNotFoundError
              ? Effect.fail(new WorkflowRunNotFoundError({ runID: error.runID, message: `Workflow run not found: ${error.runID}` }))
              : Effect.die(error),
          ),
        )
        return {
          data: yield* execution.drain(ctx.params.runID).pipe(
            Effect.catch((error: unknown) =>
              error instanceof WorkflowExecution.WorkspaceTargetError
                ? Effect.fail(new InvalidRequestError({ message: `Workflow node ${error.nodeID} is missing a workspace directory` }))
                : error instanceof WorkflowExecution.PromptFileError
                  ? Effect.fail(new InvalidRequestError({ message: `Workflow prompt file not found: ${error.path}` }))
                  : Effect.die(error),
            ),
          ),
        }
      }))
      .handle("workflow.execute", Effect.fn(function* (ctx) {
        yield* workflow.getRun(ctx.params.runID).pipe(
          Effect.catch((error: unknown) =>
            error instanceof Workflow.RunNotFoundError
              ? Effect.fail(new WorkflowRunNotFoundError({ runID: error.runID, message: `Workflow run not found: ${error.runID}` }))
              : Effect.die(error),
          ),
        )
        return {
          data: yield* execution.execute(ctx.params.runID).pipe(
            Effect.catch((error: unknown) =>
              error instanceof WorkflowExecution.WorkspaceTargetError
                ? Effect.fail(new InvalidRequestError({ message: `Workflow node ${error.nodeID} is missing a workspace directory` }))
                : error instanceof WorkflowExecution.PromptFileError
                  ? Effect.fail(new InvalidRequestError({ message: `Workflow prompt file not found: ${error.path}` }))
                  : Effect.die(error),
            ),
          ),
        }
      }))
      .handle("workflow.advance", Effect.fn(function* (ctx) {
        yield* workflow.getRun(ctx.params.runID).pipe(
          Effect.catch((error: unknown) =>
            error instanceof Workflow.RunNotFoundError
              ? Effect.fail(new WorkflowRunNotFoundError({ runID: error.runID, message: `Workflow run not found: ${error.runID}` }))
              : Effect.die(error),
          ),
        )
        return {
          data: yield* execution.advance(ctx.params.runID).pipe(
            Effect.catch((error: unknown) =>
              error instanceof WorkflowExecution.WorkspaceTargetError
                ? Effect.fail(new InvalidRequestError({ message: `Workflow node ${error.nodeID} is missing a workspace directory` }))
                : error instanceof WorkflowExecution.PromptFileError
                  ? Effect.fail(new InvalidRequestError({ message: `Workflow prompt file not found: ${error.path}` }))
                  : Effect.die(error),
            ),
          ),
        }
      }))
  }),
)

function mapTemplateError<A>(
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, InvalidRequestError | WorkflowTemplateNotFoundError> {
  return effect.pipe(
    Effect.catch((error: unknown) => {
      if (!(error instanceof Workflow.TemplateNotFoundError) && !(error instanceof Workflow.GraphValidationError))
        return Effect.die(error)
      const mapped: InvalidRequestError | WorkflowTemplateNotFoundError =
        error instanceof Workflow.TemplateNotFoundError
          ? new WorkflowTemplateNotFoundError({
              templateID: error.templateID,
              message: `Workflow template not found: ${error.templateID}`,
            })
          : new InvalidRequestError({ message: error.message })
      return Effect.fail(mapped)
    }),
  )
}

function mapWorkflowError<A>(
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, InvalidRequestError | WorkflowRunNotFoundError> {
  return effect.pipe(
    Effect.catch((error: unknown) => {
      if (!(error instanceof Workflow.RunNotFoundError) && !(error instanceof Workflow.HandoffValidationError))
        return Effect.die(error)
      const mapped: InvalidRequestError | WorkflowRunNotFoundError =
        error instanceof Workflow.RunNotFoundError
          ? new WorkflowRunNotFoundError({ runID: error.runID, message: `Workflow run not found: ${error.runID}` })
          : new InvalidRequestError({ message: error.message })
      return Effect.fail(mapped)
    }),
  )
}

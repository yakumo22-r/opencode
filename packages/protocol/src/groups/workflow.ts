import { Project } from "@opencode-ai/schema/project"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { NonNegativeInt, PositiveInt } from "@opencode-ai/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError, WorkflowRunNotFoundError, WorkflowTemplateNotFoundError } from "../errors"

const WorkflowHistoryLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(100))
const WorkflowHistoryQuery = Schema.Struct({
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(WorkflowHistoryLimit), Schema.optional),
  after: Schema.NumberFromString.pipe(Schema.decodeTo(NonNegativeInt), Schema.optional),
})

export const WorkflowGroup = HttpApiGroup.make("server.workflow")
  .add(
    HttpApiEndpoint.get("workflow.listTemplates", "/api/workflow/template", {
      query: Schema.Struct({ projectID: Project.ID.pipe(Schema.optional) }),
      success: Schema.Struct({ data: Schema.Array(Workflow.Template) }).annotate({ identifier: "WorkflowTemplatesResponse" }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.workflow.template.list",
        summary: "List workflow templates",
        description: "Retrieve workflow templates, optionally filtered by project.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("workflow.createTemplate", "/api/workflow/template", {
      payload: Schema.Struct({
        projectID: Project.ID.pipe(Schema.optional),
        title: Schema.String,
        description: Schema.String.pipe(Schema.optional),
        graph: Workflow.Graph,
      }),
      success: Schema.Struct({ data: Workflow.Template }).annotate({ identifier: "WorkflowTemplateResponse" }),
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.workflow.template.create",
        summary: "Create workflow template",
        description: "Validate and persist a workflow template graph.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.put("workflow.updateTemplate", "/api/workflow/template/:templateID", {
      params: { templateID: Schema.String },
      payload: Schema.Struct({
        title: Schema.String.pipe(Schema.optional),
        description: Schema.String.pipe(Schema.optional),
        graph: Workflow.Graph,
      }),
      success: Schema.Struct({ data: Workflow.Template }).annotate({ identifier: "WorkflowTemplateUpdateResponse" }),
      error: [InvalidRequestError, WorkflowTemplateNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.workflow.template.update",
        summary: "Update workflow template",
        description: "Validate and persist a new version of a workflow template graph.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("workflow.getTemplate", "/api/workflow/template/:templateID", {
      params: { templateID: Schema.String },
      success: Schema.Struct({ data: Workflow.Template }).annotate({ identifier: "WorkflowTemplateGetResponse" }),
      error: WorkflowTemplateNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.workflow.template.get",
        summary: "Get workflow template",
        description: "Retrieve a workflow template by ID.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("workflow.createRun", "/api/workflow/run", {
      payload: Schema.Struct({
        templateID: Schema.String,
        input: Schema.Json.pipe(Schema.optional),
      }),
      success: Schema.Struct({ data: Workflow.Run }).annotate({ identifier: "WorkflowRunResponse" }),
      error: WorkflowTemplateNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.workflow.run.create",
        summary: "Create workflow run",
        description: "Create an immutable run snapshot from a workflow template.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("workflow.listRuns", "/api/workflow/run", {
      query: Schema.Struct({ projectID: Project.ID.pipe(Schema.optional) }),
      success: Schema.Struct({ data: Schema.Array(Workflow.Run) }).annotate({ identifier: "WorkflowRunsResponse" }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.workflow.run.list",
        summary: "List workflow runs",
        description: "Retrieve workflow runs, optionally filtered by project, ordered by recent activity.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("workflow.getRun", "/api/workflow/run/:runID", {
      params: { runID: Schema.String },
      success: Schema.Struct({ data: Workflow.Run }).annotate({ identifier: "WorkflowRunGetResponse" }),
      error: WorkflowRunNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.workflow.run.get",
        summary: "Get workflow run",
        description: "Retrieve a workflow run snapshot by ID.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("workflow.history", "/api/workflow/run/:runID/history", {
      params: { runID: Schema.String },
      query: WorkflowHistoryQuery,
      success: Schema.Struct({ data: Schema.Array(WorkflowEvent.Durable), hasMore: Schema.Boolean }).annotate({
        identifier: "WorkflowHistoryResponse",
      }),
      error: WorkflowRunNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.workflow.history",
        summary: "Get workflow run history",
        description: "Read one finite page of durable workflow events after an exclusive Run aggregate sequence.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("workflow.listWorkItems", "/api/workflow/run/:runID/work-item", {
      params: { runID: Schema.String },
      success: Schema.Struct({ data: Schema.Array(Workflow.WorkItem) }).annotate({ identifier: "WorkflowWorkItemsResponse" }),
      error: WorkflowRunNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.workflow.run.workItems",
        summary: "List workflow work items",
        description: "Retrieve work item states for a workflow run.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("workflow.updateWorkItem", "/api/workflow/run/:runID/work-item/:nodeID", {
      params: Schema.Struct({ runID: Schema.String, nodeID: Schema.String }),
      payload: Schema.Struct({ status: Workflow.WorkItemStatus }),
      success: Schema.Struct({ data: Workflow.WorkItem }).annotate({ identifier: "WorkflowWorkItemResponse" }),
      error: [InvalidRequestError, WorkflowRunNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.workflow.workItem.update",
        summary: "Update workflow work item",
        description: "Change a work item state through the workflow state machine; completion requires sealed artifact outputs.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("workflow.getCost", "/api/workflow/run/:runID/cost", {
      params: { runID: Schema.String },
      success: Schema.Struct({ data: Workflow.CostReport }).annotate({ identifier: "WorkflowCostResponse" }),
      error: WorkflowRunNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.workflow.run.cost",
        summary: "Get workflow run cost",
        description: "Project session usage and return estimated USD cost grouped by provider and model.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("workflow.sendHandoff", "/api/workflow/run/:runID/handoff", {
      params: { runID: Schema.String },
      payload: Schema.Struct({
        sourceNodeID: Schema.String,
        sourcePort: Schema.String,
        targetNodeID: Schema.String,
        targetPort: Schema.String,
        payload: Schema.Json,
        sealed: Schema.Boolean.pipe(Schema.optional),
      }),
      success: Schema.Struct({ data: Workflow.Handoff }).annotate({ identifier: "WorkflowHandoffResponse" }),
      error: [InvalidRequestError, WorkflowRunNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.workflow.handoff.send",
        summary: "Send workflow handoff",
        description: "Deliver a sealed dependency artifact or a queue message through a validated workflow edge.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("workflow.readHandoffQueue", "/api/workflow/run/:runID/queue/:nodeID/:port", {
      params: Schema.Struct({ runID: Schema.String, nodeID: Schema.String, port: Schema.String }),
      success: Schema.Struct({ data: Schema.Array(Workflow.Handoff) }).annotate({ identifier: "WorkflowQueueResponse" }),
      error: [InvalidRequestError, WorkflowRunNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.workflow.handoff.queue.read",
        summary: "Read workflow handoff queue",
        description: "Read unacknowledged messages delivered to a node queue input port.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("workflow.acknowledgeHandoffQueue", "/api/workflow/run/:runID/queue/:nodeID/:port/acknowledge", {
      params: Schema.Struct({ runID: Schema.String, nodeID: Schema.String, port: Schema.String }),
      payload: Schema.Struct({ sequence: Schema.Number }),
      success: Schema.Struct({ data: Schema.Void }).annotate({ identifier: "WorkflowQueueAcknowledgeResponse" }),
      error: [InvalidRequestError, WorkflowRunNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.workflow.handoff.queue.acknowledge",
        summary: "Acknowledge workflow handoff queue",
        description: "Advance the durable queue cursor through a delivered handoff sequence.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("workflow.drain", "/api/workflow/run/:runID/drain", {
      params: { runID: Schema.String },
      success: Schema.Struct({ data: Schema.Array(Workflow.WorkItem) }).annotate({ identifier: "WorkflowDrainResponse" }),
      error: [InvalidRequestError, WorkflowRunNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.workflow.run.drain",
        summary: "Drain ready workflow work items",
        description: "Admit durable Session inputs for ready work items without starting provider execution.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("workflow.execute", "/api/workflow/run/:runID/execute", {
      params: { runID: Schema.String },
      success: Schema.Struct({ data: Schema.Array(Workflow.WorkItem) }).annotate({ identifier: "WorkflowExecuteResponse" }),
      error: [InvalidRequestError, WorkflowRunNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.workflow.execute",
        summary: "Execute workflow work items",
        description: "Resume admitted Session work for running workflow items and settle idle items into waiting.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("workflow.advance", "/api/workflow/run/:runID/advance", {
      params: { runID: Schema.String },
      success: Schema.Struct({ data: Schema.Array(Workflow.WorkItem) }).annotate({ identifier: "WorkflowAdvanceResponse" }),
      error: [InvalidRequestError, WorkflowRunNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.workflow.run.advance",
        summary: "Advance a workflow run until idle",
        description: "Repeatedly drain and execute eligible work items until the run has no ready or running nodes.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "workflows",
      description: "Experimental visual workflow routes.",
    }),
  )

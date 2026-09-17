export * as Workflow from "./workflow"

import { Schema } from "effect"
import { Project } from "./project"
import { Model } from "./model"
import { NonNegativeInt, optional } from "./schema"

export const NodeKind = Schema.Literals(["root", "task", "research", "implement", "review", "test", "approval"]).annotate({
  identifier: "Workflow.NodeKind",
})
export type NodeKind = typeof NodeKind.Type

export const HandoffType = Schema.Literals([
  "task_spec",
  "plan",
  "research",
  "patch",
  "review",
  "test_result",
  "summary",
  "generic_document",
]).annotate({ identifier: "Workflow.HandoffType" })
export type HandoffType = typeof HandoffType.Type

export interface InputPort extends Schema.Schema.Type<typeof InputPort> {}
export const InputPort = Schema.Struct({
  handoffTypes: Schema.Array(HandoffType),
  required: Schema.Boolean,
  many: Schema.Boolean,
  mode: Schema.Literals(["dependency", "queue"]),
}).annotate({ identifier: "Workflow.InputPort" })

export interface OutputPort extends Schema.Schema.Type<typeof OutputPort> {}
export const OutputPort = Schema.Struct({
  handoffType: HandoffType,
  many: Schema.Boolean,
  mode: Schema.Literals(["artifact", "message"]),
}).annotate({ identifier: "Workflow.OutputPort" })

export interface Node extends Schema.Schema.Type<typeof Node> {}
export const Node = Schema.Struct({
  id: Schema.String,
  kind: NodeKind,
  title: Schema.String,
  objective: Schema.String,
  agentProfileID: Schema.String.pipe(optional),
  model: Model.Ref.pipe(optional),
  promptFile: Schema.String.pipe(optional),
  inputs: Schema.Record(Schema.String, InputPort),
  outputs: Schema.Record(Schema.String, OutputPort),
  workspace: Schema.Struct({
    mode: Schema.Literals(["read", "write", "isolated-write", "none"]),
    directory: Schema.String.pipe(optional),
  }),
  config: Schema.Record(Schema.String, Schema.Unknown),
  display: Schema.Struct({ x: Schema.Number, y: Schema.Number }),
}).annotate({ identifier: "Workflow.Node" })

export interface Edge extends Schema.Schema.Type<typeof Edge> {}
export const Edge = Schema.Struct({
  id: Schema.String,
  sourceNodeID: Schema.String,
  sourcePort: Schema.String,
  targetNodeID: Schema.String,
  targetPort: Schema.String,
  condition: Schema.Literals(["success", "failure"]).pipe(optional),
}).annotate({ identifier: "Workflow.Edge" })

export interface Graph extends Schema.Schema.Type<typeof Graph> {}
export const Graph = Schema.Struct({
  nodes: Schema.Array(Node),
  edges: Schema.Array(Edge),
  promptFile: Schema.String.pipe(optional),
}).annotate({ identifier: "Workflow.Graph" })

export interface Template extends Schema.Schema.Type<typeof Template> {}
export const Template = Schema.Struct({
  id: Schema.String,
  projectID: Project.ID.pipe(optional),
  title: Schema.String,
  description: Schema.String.pipe(optional),
  version: NonNegativeInt,
  graph: Graph,
  time: Schema.Struct({ created: NonNegativeInt, updated: NonNegativeInt }),
}).annotate({ identifier: "Workflow.Template" })

export interface Run extends Schema.Schema.Type<typeof Run> {}
export const Run = Schema.Struct({
  id: Schema.String,
  templateID: Schema.String,
  projectID: Project.ID.pipe(optional),
  templateVersion: NonNegativeInt,
  status: Schema.Literal("ready"),
  graph: Graph,
  input: Schema.Json,
  time: Schema.Struct({ created: NonNegativeInt, updated: NonNegativeInt }),
}).annotate({ identifier: "Workflow.Run" })

export const WorkItemStatus = Schema.Literals([
  "pending",
  "ready",
  "running",
  "waiting",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]).annotate({ identifier: "Workflow.WorkItemStatus" })
export type WorkItemStatus = typeof WorkItemStatus.Type

export interface WorkItem extends Schema.Schema.Type<typeof WorkItem> {}
export const WorkItem = Schema.Struct({
  runID: Schema.String,
  nodeID: Schema.String,
  status: WorkItemStatus,
  sessionID: Schema.String.pipe(optional),
  time: Schema.Struct({ created: NonNegativeInt, updated: NonNegativeInt }),
}).annotate({ identifier: "Workflow.WorkItem" })

export interface Handoff extends Schema.Schema.Type<typeof Handoff> {}
export const Handoff = Schema.Struct({
  id: Schema.String,
  runID: Schema.String,
  sourceNodeID: Schema.String,
  sourcePort: Schema.String,
  targetNodeID: Schema.String,
  targetPort: Schema.String,
  mode: Schema.Literals(["dependency", "queue"]),
  payload: Schema.Json,
  sequence: NonNegativeInt,
  sealed: Schema.Boolean,
  time: Schema.Struct({ created: NonNegativeInt }),
}).annotate({ identifier: "Workflow.Handoff" })

export interface TokenUsage extends Schema.Schema.Type<typeof TokenUsage> {}
export const TokenUsage = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  reasoning: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
}).annotate({ identifier: "Workflow.TokenUsage" })

export interface CostGroup extends Schema.Schema.Type<typeof CostGroup> {}
export const CostGroup = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  usage: TokenUsage,
  estimatedMicrousd: Schema.Number.pipe(optional),
  pricedAttempts: NonNegativeInt,
  unpricedAttempts: NonNegativeInt,
}).annotate({ identifier: "Workflow.CostGroup" })

export interface CostReport extends Schema.Schema.Type<typeof CostReport> {}
export const CostReport = Schema.Struct({
  runID: Schema.String,
  estimatedMicrousd: Schema.Number.pipe(optional),
  unpricedAttempts: NonNegativeInt,
  groups: Schema.Array(CostGroup),
}).annotate({ identifier: "Workflow.CostReport" })

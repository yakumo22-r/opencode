export * as WorkflowEvent from "./workflow-event"

import { Schema } from "effect"
import { Event } from "./event"
import { NonNegativeInt } from "./schema"
import { Workflow } from "./workflow"

const options = { durable: { aggregate: "runID", version: 1 } } as const
const Base = { timestamp: NonNegativeInt, runID: Schema.String }

export const WorkItemStatusChanged = Event.define({
  type: "workflow.work-item.status-changed",
  ...options,
  schema: { ...Base, nodeID: Schema.String, status: Workflow.WorkItemStatus, sessionID: Schema.String.pipe(Schema.optional) },
})
export const HandoffSent = Event.define({ type: "workflow.handoff.sent", ...options, schema: { ...Base, handoff: Workflow.Handoff } })
export const QueueAcknowledged = Event.define({
  type: "workflow.queue.acknowledged",
  ...options,
  schema: { ...Base, nodeID: Schema.String, port: Schema.String, sequence: NonNegativeInt },
})

export const DurableDefinitions = Event.inventory(WorkItemStatusChanged, HandoffSent, QueueAcknowledged)
export const Durable = Schema.Union(DurableDefinitions, { mode: "oneOf" }).pipe(Schema.toTaggedUnion("type"))
export type DurableEvent = typeof Durable.Type

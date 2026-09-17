# Visual Workflows

## Purpose

Provide a durable, inspectable workflow layer for multi-agent tasks. A workflow
is a directed graph of long-lived typed work items. Nodes exchange named,
typed handoffs through multiple input and output ports. It owns dependency
scheduling, artifacts, collaboration queues, budgets, approvals, and recovery.
A `SessionV2` remains the location-scoped execution context for one agent
attempt; it does not become a cross-agent graph scheduler.

The first supported domain is software-engineering work in one local project.
The design must not assume that all future workflows are coding workflows.

## Goals

- Let users visually create a reusable workflow template by placing and
  connecting nodes.
- Let every node select a versioned agent profile with its own model, tools,
  permissions, reasoning level, limits, and system prompt version.
- Persist the workflow definition, each run, every state transition, inputs,
  outputs, and model-attempt metadata locally.
- Build a focused context for each attempt from immutable artifact references,
  rather than forwarding an entire multi-agent transcript.
- Let independent agents exchange durable, directed messages while their work
  items remain active, then resume from the relevant handoff without losing
  their own workspace context.
- Allow safe parallel read-only work while protecting a shared workspace from
  concurrent writes.
- Support an AI proposing bounded additions to a running graph without giving
  it unrestricted graph mutation.
- Make a completed result traceable to its inputs, agent profile, commands, and
  verification evidence.
- Account for every provider attempt with the provider's price snapshot, split
  by provider, model, input, output, reasoning, cache read, and cache write
  tokens, then aggregate the cost from one user request to its final output.
- Give users actionable cost-optimization evidence without treating an estimate
  as an invoice.

## Non-goals for the first version

- Distributed scheduling, clustering, or work shared between machines.
- General cycles, compensation transactions, or unbounded recursive delegation.
- Simultaneous writes to the same worktree.
- Editing execution-relevant fields on a work item that has started.
- Automatically promoting every model conclusion to durable long-term memory.
- Replacing existing SessionV2 admission, execution, interruption, or event
  replay semantics.

## Terminology

- **Workflow template**: a mutable graph definition that can be saved and used
  to create runs.
- **Workflow run**: an immutable snapshot of a template plus user input and
  execution state.
- **Work item**: one scheduled node in a run.
- **Attempt**: one execution of a work item using one resolved agent profile.
- **Handoff**: an immutable artifact or message sent from one output port to one
  input port.
- **Collaboration queue**: an ordered durable inbox attached to a node input
  port. Receiving a handoff wakes an eligible active or waiting work item.
- **Artifact**: immutable content produced or consumed by work items, addressed
  by content hash.
- **Context snapshot**: the exact ordered artifact references and generated
  summaries supplied to an attempt.
- **Agent profile**: a versioned configuration for how a work item runs.
- **Proposal**: a bounded graph change requested by an agent and accepted by the
  scheduler or a user before it becomes a work item.
- **Price snapshot**: the versioned official unit prices resolved for one model
  attempt before or when provider usage is recorded.
- **Cost report**: an aggregate of recorded attempt usage and price snapshots
  for one work item, run, template, project, or selected time range.

## Boundaries

```text
Visual UI / TUI entry points
  -> Workflow HTTP API
    -> Workflow store and scheduler
      -> Work item attempt
        -> location-scoped SessionV2 and tools
```

The workflow layer owns graph semantics. SessionV2 owns an individual agent's
prompt admission, provider turns, tool calls, and local interruption chain.
The scheduler may wake or create a session for a single attempt, but a session
must not discover, execute, or persist a workflow DAG itself.

The visual graph is a client of the Workflow HTTP API. It is not the source of
truth and it must not infer valid execution order from canvas position.

Existing TUI plugins can expose commands, a compact status route, approval
actions, and navigation to a visual UI. The terminal TUI is not the primary
implementation target for drag, connect, pan, and zoom interaction.

## Graph Model

The stored template uses stable node and edge identifiers. Position and display
metadata are editable client concerns; execution fields are validated server
side.

```ts
type WorkflowTemplate = {
  id: string
  version: number
  title: string
  description?: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  createdAt: number
  updatedAt: number
}

type WorkflowNode = {
  id: string
  kind: "task" | "research" | "implement" | "review" | "test" | "approval"
  title: string
  objective: string
  agentProfileID?: string
  inputs: Record<string, InputPort>
  outputs: Record<string, OutputPort>
  workspace: { mode: "read" | "write" | "isolated-write" | "none"; directory?: string }
  config: Record<string, unknown>
  display: { x: number; y: number }
}

type WorkflowEdge = {
  id: string
  sourceNodeID: string
  sourcePort: string
  targetNodeID: string
  targetPort: string
  condition?: "success" | "failure"
}
```

`approval` is a scheduler-owned gate and has no model profile. Other initial
node kinds are presets, not separate runtime architectures. They determine
default ports, recommended profile capabilities, and validation policy. Custom
node kinds are deferred until their runtime and port schemas can be versioned.

## Ports, Edges, and Handoffs

Every port has a declared handoff type, cardinality, and delivery behavior.
Ports are not merely graph decoration: they are the contract for what a node
must receive and what it may emit. A node may have any number of named input
and output ports.

Initial handoff types are `task_spec`, `plan`, `research`, `patch`, `review`,
`test_result`, `summary`, and `generic_document`. Typed request and response
payloads can be introduced only when their schemas are stable.

```ts
type InputPort = {
  handoffTypes: string[]
  required: boolean
  many: boolean
  mode: "dependency" | "queue"
}

type OutputPort = {
  handoffType: string
  many: boolean
  mode: "artifact" | "message"
}
```

An edge maps one output port to one input port. `artifact` outputs connect to
`dependency` inputs and establish completion dependencies. `message` outputs
connect to `queue` inputs and establish a directed collaboration channel. A
pair of nodes needs two edges for bidirectional conversation.

An edge is valid only when:

- Both node and port identifiers exist.
- The source output mode is compatible with the target input mode.
- The source handoff type is accepted by the target input.
- A single-value input is not connected to more than one unconditional source.
- A `success` dependency edge does not introduce a cycle.
- A failure dependency points to a node that can process its failure handoff.
- The graph respects workspace-write isolation rules below.

Message edges do not participate in dependency-cycle validation. They form
durable queues and may be cyclic; a front-end node and a back-end node can each
send to the other. The server computes completion dependencies and queue
subscriptions from accepted edges. The client may show a temporary invalid
connection while dragging, but cannot save it.

### Handoff Semantics

Each sent handoff has a sender node/attempt, source port, recipient node,
target port, payload artifact reference, sequence number, and delivery state.
It is append-only. A queue consumer records its cursor independently, so an
interrupted node can resume without reprocessing or losing messages.

- A dependency handoff is published when its source work item completes. It is
  immutable and satisfies a required downstream input.
- A message handoff is appended immediately to the target port's queue. It does
  not complete either node and does not make the receiver depend on the sender's
  final completion.
- A node may emit zero, one, or many messages from the same output port.
- A node seals an artifact output only when it declares that output final. A
  final review node can therefore wait for the final `frontend_patch` and
  `backend_patch` handoffs without waiting for collaboration queues to become
  empty.
- Message queues must have explicit capacity, rate, and total-budget limits.
  Reaching a limit blocks the sender or requires an approval; it never silently
  drops a handoff.

## Template Editing and Run Snapshots

A template can be freely edited while it has no active save conflict. Starting
a run validates the graph and copies its definition and resolved profile
versions into the run. Future template edits do not affect that run.

Runs preserve their graph history. A run can add only scheduler-approved work
items; it cannot delete historical nodes or rewrite started work. A user can:

- Cancel pending work items or the whole run.
- Retry a failed work item, producing a new attempt.
- Approve, reject, or modify a pending proposal.
- Change only safe execution fields of a pending work item, such as a title or
  a selected profile, after validation and before scheduling.

The UI has two explicit modes:

- **Template mode** supports drag, connect, delete, configure, save, and
  automatic layout.
- **Run mode** renders the snapshot and live status. It exposes evidence,
  retries, cancellations, approvals, and proposed additions, but not arbitrary
  topology edits.

## Run and Work Item States

```text
Workflow run: draft -> ready -> running -> completed
                              -> failed
                              -> cancelled

Work item: pending -> ready -> running -> waiting -> ready
                           -> blocked -> cancelled
                           -> completed
                           -> failed
```

- `pending` awaits graph admission or required inputs.
- `ready` has satisfied dependencies and is eligible for the scheduler.
- `running` has one active attempt and may emit handoffs.
- `waiting` has no active provider turn but remains eligible to resume when a
  queue handoff arrives, a dependency becomes available, or a user intervenes.
- `blocked` awaits approval, an unavailable required input, or explicit user
  action. It is not automatically awakened by ordinary queue traffic.
- `failed` has exhausted retry policy or reached a non-retriable failure.
- `completed` has produced declared output artifacts and passed node-level
  completion checks.

Each work item has a completion policy. The initial policy is `explicit`: the
agent must publish every required final output and report completion. This is
separate from temporary quiescence; a node with no provider turn can remain
`waiting` for peer communication. Future policies may add deadlines and
supervisor-controlled completion, but they must not infer completion merely
because a queue is momentarily empty.

Failure edges are evaluated only after an upstream item reaches `failed`. A
failed required `success` dependency blocks its dependents unless a defined
failure path handles it. A workflow completes only when all reachable items
have completed, been explicitly cancelled, or been skipped by a defined branch
policy. The initial version may omit conditional branch skipping and instead
model failure handlers as explicit follow-up items.

## Scheduling and Workspace Safety

The scheduler is process-local and run-ID based. It discovers the run from the
workflow store only when a drain begins. Different runs may execute
concurrently subject to budgets and workspace locks.

Each node declares a workspace mode:

- `read`: may inspect files and run non-mutating commands.
- `write`: may modify the run's shared worktree.
- `isolated-write`: may modify a dedicated worktree created for that item.
- `none`: no workspace access, for example an approval gate.

A work item must name the directory or isolated worktree it operates in. Two
nodes in the same workflow may target different directories, such as a front-end
repository and a back-end repository. The scheduler applies write locks per
workspace target, not per workflow run.

Initial policy:

- Any number of `read` items may run in parallel.
- At most one `write` item runs per workspace.
- `isolated-write` items may run in parallel only in separate worktrees.
- Integration from isolated worktrees is an explicit serial node.
- `review` and `test` default to `read`, but a profile may grant narrowly scoped
  tool permissions only when a workflow author chooses it.

Scheduling is advisory and restart-safe at durable boundaries. A durable state
transition happens before an attempt starts and after it ends. Provider work is
not automatically retried after process crash; recovery exposes the interrupted
attempt and requires an explicit retry decision until a safe continuation model
is designed.

## Collaboration and Continuation

Collaboration is not implemented by giving one agent another agent's full
session transcript. A message handoff carries the sender's focused question,
decision, request, or evidence as an artifact. The receiver gets the new
handoff plus its own node objective, prior context snapshot, cursor position,
and relevant local workspace state.

When a queue receives a message, the scheduler applies this policy:

- If the receiver is `waiting`, admit one durable continuation input and wake
  its work item.
- If it is `running`, append the handoff to its inbox. The active provider turn
  is not interrupted unless the port policy explicitly permits interruption.
- If it has completed, reject the handoff by default and surface it as a graph
  error. A workflow author must connect a dedicated repair or follow-up node
  instead of implicitly reopening a completed item.
- If it is failed, blocked, or cancelled, retain the handoff as evidence but do
  not execute it automatically.

One wake processes a bounded batch from the relevant queue. The agent can
answer, continue its own implementation, send a response on another output
port, then either publish final outputs or return to `waiting`. This prevents a
high-volume peer queue from starving the node's primary objective.

### Front-end and Back-end Example

```text
Requirement decomposition
  final_frontend_plan -> Front-end implementation.plan
  final_backend_plan  -> Back-end implementation.plan

Front-end implementation
  api_question -------> Back-end implementation.frontend_questions
  backend_reply <------ Back-end implementation.frontend_replies
  final_patch --------> Final review.frontend_patch

Back-end implementation
  ui_question --------> Front-end implementation.backend_questions
  frontend_reply <----- Front-end implementation.backend_replies
  final_patch --------> Final review.backend_patch
```

The front-end and back-end nodes use distinct workspace targets and can run in
parallel. Their message edges may cycle indefinitely at the graph level, but
the scheduler bounds message count, continuation count, time, and cost. Final
review becomes `ready` only after both required final patch outputs are sealed.

## Agent Profiles

Agent profiles are versioned records. A run resolves and stores the exact
version before an attempt begins.

```ts
type AgentProfile = {
  id: string
  version: number
  name: string
  model: { providerID: string; modelID: string; variant?: string }
  reasoning: "low" | "medium" | "high"
  systemPromptVersion: string
  tools: string[]
  permissions: Record<string, unknown>
  maxTokens?: number
  timeoutMs?: number
  budget?: { maxCost?: number; maxProviderTurns?: number }
}
```

Resolution order is global default, workflow-template default, node default,
then an explicit pending-work-item override. Overrides store a profile version,
not mutable inline model settings. This keeps runs reproducible and makes cost
and permission audits meaningful.

## Cost Accounting and Optimization

Cost accounting is a durable execution concern, not a UI calculation. Every
provider attempt records the raw usage returned by the provider and the exact
price snapshot used to calculate its USD estimate. A run's total is the sum of
its attempts, including planner, subagent, continuation, review, retry, and
failed attempts. It is never inferred only from the final output node.

```ts
type TokenUsage = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

type ModelPriceSnapshot = {
  id: string
  providerID: string
  modelID: string
  effectiveAt: number
  source: { kind: "official" | "manual"; url?: string; retrievedAt?: number }
  usdPerMillionTokens: {
    input?: number
    output?: number
    reasoning?: number
    cacheRead?: number
    cacheWrite?: number
  }
}

type AttemptCost = {
  attemptID: string
  providerID: string
  modelID: string
  priceSnapshotID?: string
  usage: TokenUsage
  estimatedUsd?: number
  status: "priced" | "unpriced" | "provider_reported"
}
```

The calculation uses the applicable price for each token bucket independently:

```text
estimated_usd =
  input       / 1,000,000 * input_price +
  output      / 1,000,000 * output_price +
  reasoning   / 1,000,000 * reasoning_price +
  cache_read  / 1,000,000 * cache_read_price +
  cache_write / 1,000,000 * cache_write_price
```

Missing usage or price fields must remain explicit. Zero is valid only when the
provider actually reports zero or the model's official price is zero. If a
provider reports an authoritative charge, preserve it alongside the computed
estimate and label that source in the UI; do not overwrite one with the other.

### Price Sources and Versioning

The initial version must use a locally stored, versioned price catalog populated
from official provider pricing pages or official provider APIs where available.
The catalog records its source URL and retrieval time. It must not scrape prices
at request time, make provider documentation a runtime dependency, or silently
replace historical prices when a provider changes its website.

- Resolve a price snapshot by exact `providerID`, `modelID`, and effective time.
- Store the selected snapshot ID on the attempt before publishing the cost.
- Keep past snapshots immutable so historical run totals remain reproducible.
- Mark a cost `unpriced` when no official match exists rather than guessing from
  a similar model.
- Allow an explicit user-managed manual snapshot for private, self-hosted, or
  enterprise pricing. Reports must visibly distinguish it from official pricing.
- Price catalog refresh is a separate explicit operation with reviewable changes,
  never an untracked background mutation.

### Aggregation

The product must expose totals at each useful level:

- **Attempt**: raw token buckets, provider/model, price snapshot, duration,
  estimated USD, and whether the provider reported an authoritative charge.
- **Work item**: all attempts, including retries and continuation turns, grouped
  by provider/model.
- **Workflow run**: the end-to-end cost from the user's initial input through
  final delivery, grouped by provider/model and node role.
- **Template and project**: historical aggregate by time range, model, provider,
  node kind, and outcome.

An incomplete run shows a partial total and an unpriced-usage count. A completed
run may be called an end-to-end estimate only when every priced attempt has a
price snapshot and every known provider usage record is included.

### Optimization Evidence

Cost optimization recommendations must be based on observed workflow data and
be phrased as options, not automatic profile changes. The report should surface:

- Total USD estimate and token distribution by provider and model.
- Input, output, reasoning, cache-read, and cache-write token totals and cost
  contribution separately.
- The most expensive nodes, retries, continuation wakes, and failed attempts.
- Cache hit ratio when cache-readable input and cache-read usage are available.
- Cost per completed work item and cost by outcome, so a cheap but failure-prone
  profile is not incorrectly presented as efficient.
- Comparable historical runs of the same template or node kind, including model,
  duration, success rate, and cost ranges.
- Candidate changes such as a lower-cost research profile, fewer redundant
  context artifacts, more effective cache reuse, or a reduced continuation
  budget. Each candidate must show the data behind it and any observed quality
  or completion tradeoff.

The UI must label all values as estimated USD unless they originate from an
authoritative provider charge. It must show the price source, price effective
time, and any unpriced usage so users can judge the result correctly.

## Context and Artifacts

Every important input and output is an immutable artifact. Artifact bodies live
in a local content-addressed store; the database stores metadata, hash, path,
source attempt, and references. Large command output and patches must not be
duplicated in every database row or prompt.

```ts
type Artifact = {
  id: string
  hash: string
  type: string
  storagePath: string
  sourceAttemptID?: string
  createdAt: number
}

type ContextSnapshot = {
  id: string
  attemptID: string
  taskSpecArtifactID: string
  artifactIDs: string[]
  summaryArtifactIDs: string[]
  createdAt: number
}
```

Before an attempt, the Context Builder assembles only:

- System rules from the resolved agent profile.
- The node objective, acceptance criteria, and workspace scope.
- Required upstream artifacts, preserving their original references.
- Compact summaries of relevant upstream work when the original body is not
  required.
- Relevant project inspection results and prior verification evidence.

A summary is an optimization, not the sole source of truth. The original
artifact remains addressable and can be included when the agent needs evidence
or exact code. The saved context snapshot makes a model request explainable and
replayable at the prompt-construction boundary.

## Dynamic Proposals

An agent cannot write directly to the run graph. It may emit a structured
proposal such as adding a research item, a repair item, or an approval gate.

```ts
type WorkflowProposal = {
  id: string
  runID: string
  sourceAttemptID: string
  kind: "add_node" | "add_edge"
  change: unknown
  reasonArtifactID: string
  status: "pending" | "accepted" | "rejected"
}
```

The scheduler validates proposals with the same graph rules as template edits,
plus limits on depth, total node count, profile permissions, and remaining
budget. Low-risk additions can be auto-accepted by a template policy. Writes,
profile escalation, budget increases, and topology changes that alter a user
declared acceptance path require approval by default.

Accepted proposals append nodes and edges to the run snapshot and produce
events. Rejected proposals remain visible as evidence but never enter the
scheduler queue.

## Persistence and Audit

Initial local persistence uses the existing core database migration path and a
local artifact directory. Core tables should cover:

- `workflow_template` and versioned graph definitions.
- `workflow_run` with the immutable template snapshot and lifecycle state.
- `workflow_work_item` with resolved inputs, dependencies, state, and workspace
  mode.
- `workflow_attempt` with resolved profile version, SessionV2 reference, timing,
  raw provider usage, price snapshot, estimated cost, result, and error.
- `model_price_snapshot` with provider/model identity, official or manual source,
  effective time, token-bucket unit prices, and retrieval metadata.
- `workflow_handoff` with immutable payload reference, source and target ports,
  sequence number, delivery mode, and sender attempt.
- `workflow_queue_cursor` with one receiver cursor per work item input port.
- `workflow_artifact` with content hash and local object-store path.
- `workflow_context_snapshot` with ordered references supplied to an attempt.
- `workflow_proposal` with requested change, validation result, and approval.
- `workflow_event` as an append-only event stream.

Use snake_case database fields. API-facing schemas may use the conventions
already established by Protocol and Server. Artifact deletion, retention, and
garbage collection are explicitly deferred; no implementation may delete an
artifact that is referenced by a run or context snapshot.

## API and Event Direction

The public API needs endpoints or RPC methods for:

- Template list, get, create, update, validate, and delete.
- Run creation from a template, get, list, cancel, and retry.
- Work item get, pending-item profile override, and approval response.
- Artifact metadata and content retrieval with workspace authorization.
- Proposal list, accept, and reject.
- Cost reports scoped to an attempt, work item, run, template, or project, with
  provider/model/token-bucket grouping and unpriced usage visibility.

The event stream publishes durable state changes, attempt lifecycle changes,
artifact creation, proposal changes, and scheduler errors. UI clients refresh
from durable state after reconnect; they must not rely on receiving every live
event.

After adding public Protocol or Server `HttpApi` definitions, run `bun run
generate` from `packages/client`. Do not edit generated client sources.

## Visual UI Requirements

The visual client should use a graph-canvas library that supports drag, ports,
connection validation, pan, zoom, selection, and custom nodes. It must:

- Render templates and runs as separate routes and modes.
- Validate obvious port incompatibilities during connection drag, then defer to
  server validation when saving.
- Persist node positions as template display metadata only.
- Show each node's type, profile, workspace mode, state, current attempt, and
  upstream/downstream relations.
- Open an inspector for objective, acceptance criteria, input/output artifacts,
  profile version, logs, token usage, cost price source, retries, and failures.
- Render a run-level cost view with total estimated USD, provider/model groups,
  token buckets, unpriced usage, and optimization evidence.
- Render proposed nodes and edges distinctly until accepted.
- Subscribe to events but reconcile from a run snapshot after reconnect.
- Avoid placing provider credentials or policy enforcement in the client.

The TUI extension is intentionally smaller: a command to open or focus a
workflow, a status view, and actions for approve, reject, cancel, and retry.
Its plugin module is separate from any server plugin module as required by the
TUI plugin target rules.

## Delivery Plan

### Phase 0: Interaction and protocol prototype

- Build a non-executing visual prototype for the decomposition, front-end,
  back-end, and final-review example.
- Test node authoring, named multi-port connection editing, separate workspace
  selection, queue-edge direction, and run-state visualization with users.
- Define the structured model output for `send_handoff`, `seal_output`,
  `wait_for_handoff`, and `complete_work_item` before adding a scheduler.
- Inventory existing provider usage fields and define the durable mapping to
  input, output, reasoning, cache-read, and cache-write buckets. Seed the price
  catalog with versioned official sources for providers/models already supported
  by the prototype.
- Do not expose a public HTTP API or generated SDK until this protocol and the
  state transitions have focused tests.

### Phase 1: Durable handoff execution

- Add internal schemas, database migrations, artifact storage, and an
  append-only event model.
- Implement template validation for multi-port task nodes, artifact dependency
  edges, and message queue edges.
- Create runs from snapshots and execute one ready work item at a time.
- Create context snapshots and bind each attempt to a SessionV2 execution
  context.
- Persist handoffs and queue cursors, then support `waiting -> ready` wakeups
  without automatically treating a message as work-item completion.
- Persist raw attempt usage and immutable price snapshots, then produce a
  run-level USD estimate grouped by provider and model.
- Expose internal APIs and tests for persistence, state transitions, retries,
  and crash-visible interrupted attempts.

### Phase 2: DAG, collaboration, and controlled concurrency

- Add typed ports, edge validation, ready-set scheduling, and read/write
  workspace locks.
- Add bounded bidirectional peer queues, continuation admission, explicit final
  output sealing, and final-node convergence across multiple inputs.
- Support parallel read work, explicit isolated worktrees, test and review
  nodes, profile resolution, and budget enforcement.
- Add event replay and durable API contracts.
- Add historical cost reports, cache metrics, and evidence-backed optimization
  comparisons across template runs.

### Phase 3: Visual editor

- Implement template canvas, inspector, save validation, and automatic layout.
- Implement run canvas, live state, artifacts, logs, retries, and approvals.
- Add the small TUI navigation/status extension.

### Phase 4: Dynamic graph proposals

- Define structured proposal output for supported node types.
- Validate and audit proposals, add policy-controlled auto-acceptance, and add
  visual approval flows.

## Acceptance Criteria

A phase is not complete merely because an agent reports success. The first
end-to-end milestone is complete only when:

- A user creates a template with research, implement, test, and approval nodes.
- The server rejects an invalid port connection and a dependency cycle.
- A decomposition node emits distinct final plans to front-end and back-end
  implementation nodes in separate workspace targets.
- Front-end and back-end implementation nodes exchange durable messages through
  directed queue ports and resume after receiving a peer handoff.
- Starting a run creates an immutable graph and profile snapshot.
- Independent read nodes may run concurrently; shared-worktree writers do not.
- Each attempt has a persisted context snapshot and links to produced artifacts.
- Each provider attempt records raw token buckets and either an immutable price
  snapshot or an explicit unpriced status.
- The run view reports the end-to-end estimated USD grouped by provider/model,
  including input, output, reasoning, cache-read, and cache-write costs.
- A cost recommendation names the measured cost, completion, and quality
  evidence used for the recommendation and never changes an agent profile
  automatically.
- A failed test can be retried without rewriting prior attempts or artifacts.
- Refreshing or reconnecting the UI reconstructs state from durable records.
- A proposed write node remains unscheduled until policy or a user approves it.
- A review node becomes ready only after all of its required final artifact
  inputs are sealed, regardless of any still-open message queues.

## Implementation Handoff

Every implementing agent must read this document and the repository `AGENTS.md`
files before changing code. Preserve these constraints:

- Keep workflow orchestration separate from SessionV2 execution.
- Model communication as persistent handoffs between named ports, never as
  direct transcript sharing or unbounded in-memory agent-to-agent chat.
- Treat database state and artifact references as the source of truth, not UI
  canvas state or transient event delivery.
- Do not add a second orchestration path through legacy `SessionPrompt.loop(...)`.
- Do not create generated client files manually; regenerate them after public API
  changes.
- Keep runtime dependencies directed from Schema to Core and Protocol, then from
  Core and Protocol to Server. Client runtime code may not depend on Core or
  Server.
- Test from package directories, never from the repository root.

The current `Workflow` Core scaffold is intentionally only a persistence and
basic dependency-validation spike. It does not implement this collaboration
protocol. Do not expand it opportunistically into a scheduler before Phase 0
settles the port, handoff, continuation, and completion contracts above.

Open decisions to resolve before implementation begins:

- The first visible host for the graph canvas: an existing web client route, a
  desktop route, or a separately served local page.
- Exact public API naming and whether workflow schemas belong in Protocol or a
  dedicated package.
- The SessionV2 lifecycle for a work item attempt: dedicated session per
  attempt, or a constrained session reuse policy.
- Artifact store path, workspace scoping, quotas, and retention policy.
- The initial policy language for proposal auto-acceptance and approvals.

import { describe, expect } from "bun:test"
import { DateTime, Effect, Exit, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Workflow } from "@opencode-ai/core/workflow"
import { ModelPriceSnapshotTable, WorkflowAttemptCostTable } from "@opencode-ai/core/workflow/sql"
import { WorkflowExecution } from "@opencode-ai/core/workflow/execution"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionInputTable, SessionMessageTable } from "@opencode-ai/core/session/sql"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { eq } from "drizzle-orm"
import os from "os"
import path from "path"
import { testEffect } from "./lib/effect"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.make(`project-${directory}`), directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionV2.node,
      Workflow.node,
      WorkflowExecution.node,
    ]),
    [[ProjectV2.node, projects], [SessionExecution.node, SessionExecution.noopLayer]],
  ),
)
const projectID = ProjectV2.ID.make("prj_workflow_test")

const graph: Workflow.Graph = {
  nodes: [
    {
      id: "research",
      kind: "research",
      title: "Research",
      objective: "Inspect the project",
      inputs: {},
      outputs: { report: { handoffType: "research", many: false, mode: "artifact" } },
      workspace: { mode: "read", directory: "/workflow-test" },
      config: {},
      display: { x: 0, y: 0 },
    },
    {
      id: "implement",
      kind: "implement",
      title: "Implement",
      objective: "Apply the change",
      inputs: { report: { handoffTypes: ["research"], required: true, many: false, mode: "dependency" } },
      outputs: { patch: { handoffType: "patch", many: false, mode: "artifact" } },
      workspace: { mode: "write", directory: "/workflow-test" },
      config: {},
      display: { x: 320, y: 0 },
    },
  ],
  edges: [
    {
      id: "research-to-implement",
      sourceNodeID: "research",
      sourcePort: "report",
      targetNodeID: "implement",
      targetPort: "report",
      condition: "success",
    },
  ],
}

const collaborativeGraph: Workflow.Graph = {
  nodes: [
    {
      id: "frontend",
      kind: "implement",
      title: "Front-end",
      objective: "Implement the UI",
      inputs: { backend_replies: { handoffTypes: ["generic_document"], required: false, many: true, mode: "queue" } },
      outputs: {
        backend_questions: { handoffType: "generic_document", many: true, mode: "message" },
        final_patch: { handoffType: "patch", many: false, mode: "artifact" },
      },
      workspace: { mode: "write", directory: "/frontend" },
      config: {},
      display: { x: 0, y: 0 },
    },
    {
      id: "backend",
      kind: "implement",
      title: "Back-end",
      objective: "Implement the API",
      inputs: { frontend_questions: { handoffTypes: ["generic_document"], required: false, many: true, mode: "queue" } },
      outputs: {
        frontend_replies: { handoffType: "generic_document", many: true, mode: "message" },
        final_patch: { handoffType: "patch", many: false, mode: "artifact" },
      },
      workspace: { mode: "write", directory: "/backend" },
      config: {},
      display: { x: 320, y: 0 },
    },
  ],
  edges: [
    { id: "frontend-to-backend", sourceNodeID: "frontend", sourcePort: "backend_questions", targetNodeID: "backend", targetPort: "frontend_questions" },
    { id: "backend-to-frontend", sourceNodeID: "backend", sourcePort: "frontend_replies", targetNodeID: "frontend", targetPort: "backend_replies" },
  ],
}

const reviewGraph: Workflow.Graph = {
  nodes: [
    ...collaborativeGraph.nodes,
    {
      id: "review",
      kind: "review",
      title: "Final review",
      objective: "Review both changes",
      inputs: {
        frontend_patch: { handoffTypes: ["patch"], required: true, many: false, mode: "dependency" },
        backend_patch: { handoffTypes: ["patch"], required: true, many: false, mode: "dependency" },
      },
      outputs: {},
      workspace: { mode: "read", directory: "/review" },
      config: {},
      display: { x: 640, y: 0 },
    },
  ],
  edges: [
    ...collaborativeGraph.edges,
    { id: "frontend-to-review", sourceNodeID: "frontend", sourcePort: "final_patch", targetNodeID: "review", targetPort: "frontend_patch", condition: "success" },
    { id: "backend-to-review", sourceNodeID: "backend", sourcePort: "final_patch", targetNodeID: "review", targetPort: "backend_patch", condition: "success" },
  ],
}

describe("Workflow", () => {
  it.effect("rejects invalid workflow cycles", () =>
    Effect.gen(function* () {
      const workflow = yield* Workflow.Service
      const result = yield* Effect.exit(workflow.validate({
        ...graph,
        nodes: graph.nodes.map((node) =>
          node.id === "research"
            ? { ...node, inputs: { patch: { handoffTypes: ["patch"], required: false, many: false, mode: "dependency" } } }
            : node,
        ),
        edges: [
          ...graph.edges,
          {
            id: "implement-to-research",
            sourceNodeID: "implement",
            sourcePort: "patch",
            targetNodeID: "research",
            targetPort: "patch",
            condition: "success",
          },
        ],
      }))

      expect(Exit.isFailure(result)).toBe(true)
    }),
  )

  it.effect("persists an immutable graph snapshot for a run", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const workflow = yield* Workflow.Service
      const now = Date.now()
      yield* database.db.insert(ProjectTable).values({
        id: projectID,
        worktree: AbsolutePath.make("/workflow-test"),
        sandboxes: [],
        time_created: now,
        time_updated: now,
      }).onConflictDoNothing().run().pipe(Effect.orDie)

      const template = yield* workflow.createTemplate({ projectID, title: "Feature delivery", graph })
      const run = yield* workflow.createRun({ templateID: template.id, input: { prompt: "Add workflows" } })

      expect(run.templateID).toBe(template.id)
      expect(run.templateVersion).toBe(template.version)
      expect(run.graph).toEqual(template.graph)
      expect(run.graph).not.toBe(template.graph)
    }),
  )

  it.effect("passes the run requirement from the root node to the first node", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const workflow = yield* Workflow.Service
      const execution = yield* WorkflowExecution.Service
      const now = Date.now()
      const projectID = ProjectV2.ID.make("prj_workflow_root")
      yield* database.db.insert(ProjectTable).values({
        id: projectID,
        worktree: AbsolutePath.make("/workflow-root"),
        sandboxes: [],
        time_created: now,
        time_updated: now,
      }).onConflictDoNothing().run().pipe(Effect.orDie)
      const template = yield* workflow.createTemplate({
        projectID,
        title: "Root",
        graph: {
          nodes: [
            {
              id: "root",
              kind: "root",
              title: "Root",
              objective: "",
              inputs: {},
              outputs: { result: { handoffType: "task_spec", many: true, mode: "artifact" } },
              workspace: { mode: "none" },
              config: {},
              display: { x: 0, y: 0 },
            },
            {
              id: "task",
              kind: "task",
              title: "First",
              objective: "Do the work",
              inputs: { context: { handoffTypes: ["task_spec"], required: true, many: false, mode: "dependency" } },
              outputs: { result: { handoffType: "summary", many: false, mode: "artifact" } },
              workspace: { mode: "write", directory: "/workflow-root" },
              config: {},
              display: { x: 320, y: 0 },
            },
          ],
          edges: [
            { id: "root-to-task", sourceNodeID: "root", sourcePort: "result", targetNodeID: "task", targetPort: "context", condition: "success" },
          ],
        },
      })
      const run = yield* workflow.createRun({ templateID: template.id, input: { requirement: "Ship the workflow canvas" } })
      const items = yield* execution.drain(run.id)

      expect(items.find((item) => item.nodeID === "root")?.status).toBe("completed")
      expect((yield* workflow.listWorkItems(run.id)).find((item) => item.nodeID === "task")?.status).toBe("ready")
    }),
  )

  it.effect("creates and lists a workflow template without a project", () =>
    Effect.gen(function* () {
      const workflow = yield* Workflow.Service
      const template = yield* workflow.createTemplate({ title: "Cross-project", graph })

      expect(template.projectID).toBeUndefined()
      expect((yield* workflow.listTemplates()).map((item) => item.id)).toContain(template.id)
      expect((yield* workflow.createRun({ templateID: template.id, input: {} })).projectID).toBeUndefined()
    }),
  )

  it.effect("updates a workflow template without rewriting existing run snapshots", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const workflow = yield* Workflow.Service
      const now = Date.now()
      yield* database.db.insert(ProjectTable).values({
        id: projectID,
        worktree: AbsolutePath.make("/workflow-update"),
        sandboxes: [],
        time_created: now,
        time_updated: now,
      }).onConflictDoNothing().run().pipe(Effect.orDie)
      const template = yield* workflow.createTemplate({ projectID, title: "Draft", graph })
      const run = yield* workflow.createRun({ templateID: template.id, input: {} })
      const updated = yield* workflow.updateTemplate({
        templateID: template.id,
        title: "Revised",
        graph: {
          ...graph,
          nodes: graph.nodes.map((node) => (node.id === "research" ? { ...node, title: "Investigate" } : node)),
        },
      })

      expect(updated.version).toBe(template.version + 1)
      expect(updated.title).toBe("Revised")
      expect(updated.graph.nodes.find((node) => node.id === "research")?.title).toBe("Investigate")
      expect((yield* workflow.getRun(run.id)).graph.nodes.find((node) => node.id === "research")?.title).toBe("Research")
    }),
  )

  it.effect("lists workflow runs by recent activity within a project", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const workflow = yield* Workflow.Service
      const now = Date.now()
      yield* database.db.insert(ProjectTable).values({
        id: projectID,
        worktree: AbsolutePath.make("/workflow-runs"),
        sandboxes: [],
        time_created: now,
        time_updated: now,
      }).onConflictDoNothing().run().pipe(Effect.orDie)
      const template = yield* workflow.createTemplate({ projectID, title: "Run list", graph })
      const first = yield* workflow.createRun({ templateID: template.id, input: { sequence: 1 } })
      const second = yield* workflow.createRun({ templateID: template.id, input: { sequence: 2 } })

      expect((yield* workflow.listRuns(projectID)).map((run) => run.id)).toEqual([second.id, first.id])
    }),
  )

  it.effect("delivers and acknowledges bidirectional queue handoffs", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const workflow = yield* Workflow.Service
      const now = Date.now()
      yield* database.db.insert(ProjectTable).values({
        id: ProjectV2.ID.make("prj_workflow_collaboration"),
        worktree: AbsolutePath.make("/workflow-collaboration"),
        sandboxes: [],
        time_created: now,
        time_updated: now,
      }).onConflictDoNothing().run().pipe(Effect.orDie)
      const template = yield* workflow.createTemplate({
        projectID: ProjectV2.ID.make("prj_workflow_collaboration"),
        title: "Front-end and back-end",
        graph: collaborativeGraph,
      })
      const run = yield* workflow.createRun({ templateID: template.id, input: {} })
      const handoff = yield* workflow.sendHandoff({
        runID: run.id,
        sourceNodeID: "frontend",
        sourcePort: "backend_questions",
        targetNodeID: "backend",
        targetPort: "frontend_questions",
        payload: { question: "Which endpoint returns the saved workflow?" },
      })

      expect((yield* workflow.readQueue({ runID: run.id, nodeID: "backend", port: "frontend_questions" }))).toEqual([handoff])
      yield* workflow.acknowledgeQueue({ runID: run.id, nodeID: "backend", port: "frontend_questions", sequence: handoff.sequence })
      expect((yield* workflow.readQueue({ runID: run.id, nodeID: "backend", port: "frontend_questions" }))).toEqual([])
    }),
  )

  it.effect("records replayable workflow run events", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const workflow = yield* Workflow.Service
      const now = Date.now()
      yield* database.db.insert(ProjectTable).values({
        id: projectID,
        worktree: AbsolutePath.make("/workflow-events"),
        sandboxes: [],
        time_created: now,
        time_updated: now,
      }).onConflictDoNothing().run().pipe(Effect.orDie)
      const template = yield* workflow.createTemplate({ projectID, title: "Events", graph: collaborativeGraph })
      const run = yield* workflow.createRun({ templateID: template.id, input: {} })
      const handoff = yield* workflow.sendHandoff({
        runID: run.id,
        sourceNodeID: "frontend",
        sourcePort: "backend_questions",
        targetNodeID: "backend",
        targetPort: "frontend_questions",
        payload: { text: "API ready" },
      })
      yield* workflow.acknowledgeQueue({ runID: run.id, nodeID: "backend", port: "frontend_questions", sequence: handoff.sequence })
      yield* workflow.setWorkItemStatus({ runID: run.id, nodeID: "frontend", status: "running" })

      const page = yield* workflow.history({ runID: run.id, limit: 2 })
      expect(page.events.map((event) => event.type)).toEqual(["workflow.handoff.sent", "workflow.queue.acknowledged"])
      expect(page.hasMore).toBe(true)
      const last = page.events.at(-1)
      if (!last?.durable) return yield* Effect.die("Workflow history did not return a cursor")
      const after = last.durable.seq
      expect((yield* workflow.history({ runID: run.id, after, limit: 2 })).events.map((event) => event.type)).toEqual([
        "workflow.work-item.status-changed",
      ])
    }),
  )

  it.effect("wakes waiting peers and releases review after every final handoff", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const workflow = yield* Workflow.Service
      const now = Date.now()
      const projectID = ProjectV2.ID.make("prj_workflow_review")
      yield* database.db.insert(ProjectTable).values({
        id: projectID,
        worktree: AbsolutePath.make("/workflow-review"),
        sandboxes: [],
        time_created: now,
        time_updated: now,
      }).onConflictDoNothing().run().pipe(Effect.orDie)
      const template = yield* workflow.createTemplate({ projectID, title: "Deliver and review", graph: reviewGraph })
      const run = yield* workflow.createRun({ templateID: template.id, input: {} })
      expect((yield* workflow.listWorkItems(run.id)).find((item) => item.nodeID === "review")?.status).toBe("pending")

      yield* workflow.setWorkItemStatus({ runID: run.id, nodeID: "backend", status: "running" })
      yield* workflow.setWorkItemStatus({ runID: run.id, nodeID: "backend", status: "waiting" })
      yield* workflow.sendHandoff({
        runID: run.id,
        sourceNodeID: "frontend",
        sourcePort: "backend_questions",
        targetNodeID: "backend",
        targetPort: "frontend_questions",
        payload: { question: "Can you add the API?" },
      })
      expect((yield* workflow.listWorkItems(run.id)).find((item) => item.nodeID === "backend")?.status).toBe("ready")

      yield* workflow.sendHandoff({
        runID: run.id,
        sourceNodeID: "frontend",
        sourcePort: "final_patch",
        targetNodeID: "review",
        targetPort: "frontend_patch",
        payload: { files: ["ui.tsx"] },
      })
      expect((yield* workflow.listWorkItems(run.id)).find((item) => item.nodeID === "review")?.status).toBe("pending")
      yield* workflow.sendHandoff({
        runID: run.id,
        sourceNodeID: "backend",
        sourcePort: "final_patch",
        targetNodeID: "review",
        targetPort: "backend_patch",
        payload: { files: ["api.ts"] },
      })
      expect((yield* workflow.listWorkItems(run.id)).find((item) => item.nodeID === "review")?.status).toBe("ready")
      yield* workflow.setWorkItemStatus({ runID: run.id, nodeID: "frontend", status: "running" })
      expect(
        (yield* workflow.setWorkItemStatus({ runID: run.id, nodeID: "frontend", status: "completed" })).status,
      ).toBe("completed")
    }),
  )

  it.effect("admits a ready work item without waking model execution", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const workflow = yield* Workflow.Service
      const execution = yield* WorkflowExecution.Service
      const session = yield* SessionV2.Service
      const now = Date.now()
      const projectID = ProjectV2.ID.make("prj_workflow_execution")
      yield* database.db.insert(ProjectTable).values({
        id: projectID,
        worktree: AbsolutePath.make("/workflow-execution"),
        sandboxes: [],
        time_created: now,
        time_updated: now,
      }).onConflictDoNothing().run().pipe(Effect.orDie)
      const template = yield* workflow.createTemplate({
        projectID,
        title: "Execute",
        graph: {
          ...graph,
          nodes: graph.nodes.map((node) =>
            node.id === "research"
              ? { ...node, model: { id: ModelV2.ID.make("workflow-model"), providerID: ProviderV2.ID.make("workflow-provider") } }
              : node,
          ),
        },
      })
      const run = yield* workflow.createRun({ templateID: template.id, input: {} })
      const drained = yield* execution.drain(run.id)
      const item = drained.find((candidate) => candidate.nodeID === "research")

      expect(item?.status).toBe("running")
      expect(item?.sessionID).toBeDefined()
      expect(yield* session.active).toEqual(new Set())
      if (!item?.sessionID) return yield* Effect.die("Workflow execution did not bind a session")
      const sessionID = SessionSchema.ID.make(item.sessionID)
      expect(yield* session.get(sessionID)).toMatchObject({
        id: sessionID,
        model: { id: ModelV2.ID.make("workflow-model"), providerID: ProviderV2.ID.make("workflow-provider") },
      })
      expect(
        yield* database.db
          .select()
          .from(SessionInputTable)
          .where(eq(SessionInputTable.session_id, sessionID)),
      ).toHaveLength(1)
    }),
  )

  it.effect("admits project and node prompt files into the session input", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const workflow = yield* Workflow.Service
      const execution = yield* WorkflowExecution.Service
      const now = Date.now()
      const projectID = ProjectV2.ID.make("prj_workflow_prompt")
      const directory = path.join(os.tmpdir(), `workflow-prompt-${now}`)
      yield* Effect.promise(() => Bun.write(path.join(directory, "base.md"), "PROJECT BASE PROMPT"))
      yield* Effect.promise(() => Bun.write(path.join(directory, "research.md"), "RESEARCH STAGE PROMPT"))
      yield* database.db.insert(ProjectTable).values({
        id: projectID,
        worktree: AbsolutePath.make(directory),
        sandboxes: [],
        time_created: now,
        time_updated: now,
      }).onConflictDoNothing().run().pipe(Effect.orDie)
      const template = yield* workflow.createTemplate({
        projectID,
        title: "Prompt files",
        graph: {
          ...graph,
          promptFile: "base.md",
          nodes: graph.nodes.map((node) =>
            node.id === "research"
              ? { ...node, promptFile: "research.md", workspace: { ...node.workspace, directory } }
              : { ...node, workspace: { ...node.workspace, directory } },
          ),
        },
      })
      const run = yield* workflow.createRun({ templateID: template.id, input: {} })
      const drained = yield* execution.drain(run.id)
      const item = drained.find((candidate) => candidate.nodeID === "research")
      if (!item?.sessionID) return yield* Effect.die("Workflow prompt admission did not bind a session")
      const rows = yield* database.db
        .select()
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, SessionSchema.ID.make(item.sessionID)))
      const encoded = JSON.stringify(rows[0]?.prompt)
      expect(encoded).toContain("PROJECT BASE PROMPT")
      expect(encoded).toContain("RESEARCH STAGE PROMPT")
      expect(encoded).toContain("workflow_complete_work_item")
      expect(encoded).toContain("workflow_send_handoff")
      expect(encoded).toContain("implement.report")
    }),
  )

  it.effect("admits sealed dependency payloads into the downstream session input", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const workflow = yield* Workflow.Service
      const execution = yield* WorkflowExecution.Service
      const now = Date.now()
      const projectID = ProjectV2.ID.make("prj_workflow_artifact_prompt")
      yield* database.db.insert(ProjectTable).values({
        id: projectID,
        worktree: AbsolutePath.make("/workflow-artifact-prompt"),
        sandboxes: [],
        time_created: now,
        time_updated: now,
      }).onConflictDoNothing().run().pipe(Effect.orDie)
      const template = yield* workflow.createTemplate({ projectID, title: "Artifact prompt", graph })
      const run = yield* workflow.createRun({ templateID: template.id, input: {} })
      yield* workflow.sendHandoff({
        runID: run.id,
        sourceNodeID: "research",
        sourcePort: "report",
        targetNodeID: "implement",
        targetPort: "report",
        payload: { findings: "use bun" },
      })
      const drained = yield* execution.drain(run.id)
      const item = drained.find((candidate) => candidate.nodeID === "implement")
      if (!item?.sessionID) return yield* Effect.die("Workflow artifact admission did not bind a session")
      const encoded = JSON.stringify(
        yield* database.db
          .select()
          .from(SessionInputTable)
          .where(eq(SessionInputTable.session_id, SessionSchema.ID.make(item.sessionID))),
      )
      expect(encoded).toContain("use bun")
      expect(encoded).toContain("Incoming sealed artifacts")
    }),
  )

  it.effect("admits a continuation when a waiting node wakes on a queue handoff", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const workflow = yield* Workflow.Service
      const execution = yield* WorkflowExecution.Service
      const now = Date.now()
      const projectID = ProjectV2.ID.make("prj_workflow_queue_continue")
      yield* database.db.insert(ProjectTable).values({
        id: projectID,
        worktree: AbsolutePath.make("/workflow-queue-continue"),
        sandboxes: [],
        time_created: now,
        time_updated: now,
      }).onConflictDoNothing().run().pipe(Effect.orDie)
      const template = yield* workflow.createTemplate({ projectID, title: "Queue continue", graph: collaborativeGraph })
      const run = yield* workflow.createRun({ templateID: template.id, input: {} })
      const first = yield* execution.execute(run.id)
      const item = first.find((candidate) => candidate.nodeID === "backend")
      if (!item?.sessionID) return yield* Effect.die("Workflow queue continuation did not bind a session")
      yield* workflow.sendHandoff({
        runID: run.id,
        sourceNodeID: "frontend",
        sourcePort: "backend_questions",
        targetNodeID: "backend",
        targetPort: "frontend_questions",
        payload: { question: "Which endpoint returns the saved workflow?" },
      })
      yield* execution.drain(run.id)
      const rows = yield* database.db
        .select()
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, SessionSchema.ID.make(item.sessionID)))
      expect(rows).toHaveLength(2)
      expect(JSON.stringify(rows)).toContain("Which endpoint returns the saved workflow?")
      expect(JSON.stringify(rows)).toContain("Continue workflow node backend")
    }),
  )

  it.effect("executes admitted work and waits when the session settles without workflow actions", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const workflow = yield* Workflow.Service
      const execution = yield* WorkflowExecution.Service
      const now = Date.now()
      const projectID = ProjectV2.ID.make("prj_workflow_execute")
      yield* database.db.insert(ProjectTable).values({
        id: projectID,
        worktree: AbsolutePath.make("/workflow-execute"),
        sandboxes: [],
        time_created: now,
        time_updated: now,
      }).onConflictDoNothing().run().pipe(Effect.orDie)
      const template = yield* workflow.createTemplate({ projectID, title: "Execute", graph })
      const run = yield* workflow.createRun({ templateID: template.id, input: {} })

      expect((yield* execution.execute(run.id)).find((item) => item.nodeID === "research")?.status).toBe("waiting")
      expect((yield* workflow.listWorkItems(run.id)).find((item) => item.nodeID === "research")?.status).toBe("waiting")
    }),
  )

  it.effect("advances a run until no ready or running work remains", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const workflow = yield* Workflow.Service
      const execution = yield* WorkflowExecution.Service
      const now = Date.now()
      const projectID = ProjectV2.ID.make("prj_workflow_advance")
      yield* database.db.insert(ProjectTable).values({
        id: projectID,
        worktree: AbsolutePath.make("/workflow-advance"),
        sandboxes: [],
        time_created: now,
        time_updated: now,
      }).onConflictDoNothing().run().pipe(Effect.orDie)
      const template = yield* workflow.createTemplate({ projectID, title: "Advance", graph })
      const run = yield* workflow.createRun({ templateID: template.id, input: {} })
      const items = yield* execution.advance(run.id)

      expect(items.find((item) => item.nodeID === "research")?.status).toBe("waiting")
      expect(items.find((item) => item.nodeID === "implement")?.status).toBe("pending")
      expect(items.some((item) => item.status === "ready" || item.status === "running")).toBe(false)
    }),
  )

  it.effect("projects assistant usage into priced workflow costs once", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const workflow = yield* Workflow.Service
      const execution = yield* WorkflowExecution.Service
      const now = Date.now()
      const projectID = ProjectV2.ID.make("prj_workflow_cost")
      yield* database.db.insert(ProjectTable).values({
        id: projectID,
        worktree: AbsolutePath.make("/workflow-cost"),
        sandboxes: [],
        time_created: now,
        time_updated: now,
      }).onConflictDoNothing().run().pipe(Effect.orDie)
      yield* database.db.insert(ModelPriceSnapshotTable).values({
        id: "price_openai_gpt",
        provider_id: "openai",
        model_id: "gpt-4.1",
        effective_at: now,
        source: { kind: "official", url: "https://openai.com/api/pricing" },
        prices: { input: 3, output: 15, reasoning: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        time_created: now,
        time_updated: now,
      })
      const template = yield* workflow.createTemplate({ projectID, title: "Cost", graph })
      const run = yield* workflow.createRun({ templateID: template.id, input: {} })
      const drained = yield* execution.drain(run.id)
      const item = drained.find((candidate) => candidate.nodeID === "research")
      if (!item?.sessionID) return yield* Effect.die("Workflow execution did not bind a session")
      const sessionID = SessionSchema.ID.make(item.sessionID)
      const messageID = SessionMessage.ID.create()
      const encodeMessage = Schema.encodeSync(SessionMessage.Message)
      const {
        id: _,
        type,
        ...data
      } = encodeMessage(
        SessionMessage.Assistant.make({
          id: messageID,
          type: "assistant",
          agent: "build",
          model: { id: ModelV2.ID.make("gpt-4.1"), providerID: ProviderV2.ID.make("openai") },
          content: [],
          tokens: { input: 1000, output: 200, reasoning: 50, cache: { read: 400, write: 100 } },
          time: { created: DateTime.makeUnsafe(now) },
        }),
      )
      yield* database.db.insert(SessionMessageTable).values({
        id: messageID,
        session_id: sessionID,
        type,
        seq: 1,
        time_created: now,
        data,
      })

      expect(yield* workflow.projectSessionCosts(run.id)).toBe(1)
      expect(yield* workflow.projectSessionCosts(run.id)).toBe(1)
      const costs = yield* database.db
        .select()
        .from(WorkflowAttemptCostTable)
        .where(eq(WorkflowAttemptCostTable.run_id, run.id))
      expect(costs).toHaveLength(1)
      expect(costs[0]).toMatchObject({
        node_id: "research",
        provider_id: "openai",
        model_id: "gpt-4.1",
        source_message_id: messageID,
        status: "priced",
        estimated_microusd: 7245,
        usage: { input: 1000, output: 200, reasoning: 50, cacheRead: 400, cacheWrite: 100 },
      })
      expect(yield* workflow.costReport(run.id)).toMatchObject({
        runID: run.id,
        estimatedMicrousd: 7245,
        unpricedAttempts: 0,
        groups: [
          {
            providerID: "openai",
            modelID: "gpt-4.1",
            usage: { input: 1000, output: 200, reasoning: 50, cacheRead: 400, cacheWrite: 100 },
            estimatedMicrousd: 7245,
            pricedAttempts: 1,
            unpricedAttempts: 0,
          },
        ],
      })
    }),
  )

  it.effect("projects costs when a running work item waits", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const workflow = yield* Workflow.Service
      const execution = yield* WorkflowExecution.Service
      const now = Date.now()
      const projectID = ProjectV2.ID.make("prj_workflow_cost_wait")
      yield* database.db.insert(ProjectTable).values({
        id: projectID,
        worktree: AbsolutePath.make("/workflow-cost-wait"),
        sandboxes: [],
        time_created: now,
        time_updated: now,
      }).onConflictDoNothing().run().pipe(Effect.orDie)
      const template = yield* workflow.createTemplate({ projectID, title: "Wait cost", graph })
      const run = yield* workflow.createRun({ templateID: template.id, input: {} })
      const drained = yield* execution.drain(run.id)
      const item = drained.find((candidate) => candidate.nodeID === "research")
      if (!item?.sessionID) return yield* Effect.die("Workflow execution did not bind a session")
      const sessionID = SessionSchema.ID.make(item.sessionID)
      const messageID = SessionMessage.ID.create()
      const encodeMessage = Schema.encodeSync(SessionMessage.Message)
      const {
        id: _,
        type,
        ...data
      } = encodeMessage(
        SessionMessage.Assistant.make({
          id: messageID,
          type: "assistant",
          agent: "build",
          model: { id: ModelV2.ID.make("gpt-4.1"), providerID: ProviderV2.ID.make("openai") },
          content: [],
          tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: DateTime.makeUnsafe(now) },
        }),
      )
      yield* database.db.insert(SessionMessageTable).values({
        id: messageID,
        session_id: sessionID,
        type,
        seq: 1,
        time_created: now,
        data,
      })
      yield* workflow.setWorkItemStatus({ runID: run.id, nodeID: "research", status: "waiting" })
      const costs = yield* database.db
        .select()
        .from(WorkflowAttemptCostTable)
        .where(eq(WorkflowAttemptCostTable.run_id, run.id))
      expect(costs).toHaveLength(1)
      expect(costs[0]).toMatchObject({
        source_message_id: messageID,
        status: "unpriced",
        usage: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      })
    }),
  )
})

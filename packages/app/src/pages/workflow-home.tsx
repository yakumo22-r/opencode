import { getFilename } from "@opencode-ai/core/util/path"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useNavigate } from "@solidjs/router"
import { createMemo, createResource, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { workflowClient } from "@/pages/workflow-client"

export function WorkflowHomePage() {
  const language = useLanguage()
  const navigate = useNavigate()
  const layout = useLayout()
  const server = useServer()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const [form, setForm] = createStore({
    runID: "",
    title: "",
    objective: "",
    requirement: "",
    projectID: undefined as string | undefined,
    busy: undefined as "create" | string | undefined,
    refresh: 0,
  })

  const projects = createMemo(() => {
    const opened = layout.projects.list().filter((project) => project.id && project.id !== "global")
    if (opened.length > 0) return opened
    return serverSync().data.project.filter((project) => project.id !== "global")
  })
  const selectedID = createMemo(() => {
    if (form.projectID && projects().some((project) => project.id === form.projectID)) return form.projectID
    const last = server.projects.last()
    return (last ? projects().find((project) => project.worktree === last) : undefined)?.id ?? projects()[0]?.id
  })
  const selected = createMemo(() => projects().find((project) => project.id === selectedID()))
  const [catalog] = createResource(
    () => form.refresh,
    async () => {
      const client = workflowClient(serverSDK())
      const [templates, runs] = await Promise.all([
        client.template.list().then((result) => result.data.data),
        client.run.list().then((result) => result.data.data),
      ])
      return { templates, runs }
    },
  )

  const open = () => {
    const value = form.runID.trim()
    if (value) navigate(`/workflow/run/${encodeURIComponent(value)}`)
  }

  const createTemplate = async () => {
    const title = form.title.trim()
    const objective = form.objective.trim()
    if (!title || !objective) return
    setForm("busy", "create")
    try {
      const template = (
        await workflowClient(serverSDK()).template.create({
          title,
          graph: starterGraph(title, objective, selected()?.worktree),
        })
      ).data.data
      navigate(`/workflow/template/${encodeURIComponent(template.id)}`)
    } finally {
      setForm("busy", undefined)
    }
  }

  const createExample = async (example: ExampleTemplate) => {
    setForm("busy", example.id)
    try {
      const template = (
        await workflowClient(serverSDK()).template.create({
          title: language.t(example.title),
          graph: example.graph(selected()?.worktree),
        })
      ).data.data
      navigate(`/workflow/template/${encodeURIComponent(template.id)}`)
    } finally {
      setForm("busy", undefined)
    }
  }

  const startRun = async (templateID: string) => {
    const requirement = form.requirement.trim()
    if (!requirement) return
    setForm("busy", templateID)
    try {
      const run = (await workflowClient(serverSDK()).run.create({ templateID, input: { requirement } })).data.data
      navigate(`/workflow/run/${encodeURIComponent(run.id)}`)
    } finally {
      setForm("busy", undefined)
    }
  }

  return (
    <main class="fixed inset-0 z-50 overflow-auto bg-v2-background-bg-base px-5 py-6 lg:px-12 lg:py-10">
      <div class="mx-auto flex w-full max-w-6xl flex-col gap-7 pb-12">
        <header class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p class="text-xs font-medium uppercase tracking-[0.14em] text-v2-text-text-muted">{language.t("workflow.home.eyebrow")}</p>
            <h1 class="mt-3 text-2xl font-[560] text-v2-text-text-strong">{language.t("workflow.home.title")}</h1>
            <p class="mt-2 text-sm leading-6 text-v2-text-text-muted">{language.t("workflow.home.description")}</p>
          </div>
          <ButtonV2 variant="ghost-muted" size="normal" icon="close" onClick={() => navigate("/")}>
            {language.t("common.close")}
          </ButtonV2>
        </header>

        <Show
          when={projects().length > 0}
          fallback={<p class="text-sm text-v2-text-text-muted">{language.t("workflow.home.noProject")}</p>}
        >
          <nav class="flex flex-wrap gap-2" aria-label={language.t("workflow.home.projects")}>
            <For each={projects()}>
              {(project) => (
                <ButtonV2
                  variant={selectedID() === project.id ? "neutral" : "ghost-muted"}
                  size="small"
                  onClick={() => setForm("projectID", project.id)}
                >
                  {project.name || getFilename(project.worktree)}
                </ButtonV2>
              )}
            </For>
          </nav>
        </Show>

        <section class="grid gap-5 lg:grid-cols-2">
            <article class="rounded-xl border border-v2-border-border-weak bg-v2-background-bg-layer-02 p-4 sm:p-6">
              <h2 class="text-sm font-[560] text-v2-text-text-strong">{language.t("workflow.home.templates")}</h2>
              <form
                class="mt-4 flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  void createTemplate()
                }}
              >
                <input
                  value={form.title}
                  onInput={(event) => setForm("title", event.currentTarget.value)}
                  class="rounded-lg border border-v2-border-border-weak bg-v2-background-bg-base px-3 py-2.5 text-sm text-v2-text-text-strong outline-none placeholder:text-v2-text-text-muted focus:border-v2-icon-icon-accent"
                  placeholder={language.t("workflow.home.titlePlaceholder")}
                  aria-label={language.t("workflow.home.titlePlaceholder")}
                />
                <input
                  value={form.objective}
                  onInput={(event) => setForm("objective", event.currentTarget.value)}
                  class="rounded-lg border border-v2-border-border-weak bg-v2-background-bg-base px-3 py-2.5 text-sm text-v2-text-text-strong outline-none placeholder:text-v2-text-text-muted focus:border-v2-icon-icon-accent"
                  placeholder={language.t("workflow.home.objectivePlaceholder")}
                  aria-label={language.t("workflow.home.objectivePlaceholder")}
                />
                <ButtonV2 type="submit" variant="neutral" size="normal" disabled={!form.title.trim() || !form.objective.trim() || form.busy !== undefined}>
                  {form.busy === "create" ? language.t("workflow.home.creating") : language.t("workflow.home.create")}
                </ButtonV2>
              </form>
              <textarea
                value={form.requirement}
                onInput={(event) => setForm("requirement", event.currentTarget.value)}
                class="mt-4 min-h-24 rounded-lg border border-v2-border-border-weak bg-v2-background-bg-base px-3 py-2.5 text-sm text-v2-text-text-strong outline-none placeholder:text-v2-text-text-muted focus:border-v2-icon-icon-accent"
                placeholder={language.t("workflow.home.requirementPlaceholder")}
                aria-label={language.t("workflow.home.requirementPlaceholder")}
              />
              <Show when={catalog.loading}>
                <p class="mt-4 text-sm text-v2-text-text-muted">{language.t("workflow.run.loading")}</p>
              </Show>
              <Show when={catalog()?.templates.length} fallback={<p class="mt-6 text-sm text-v2-text-text-muted">{language.t("workflow.home.noTemplates")}</p>}>
                <ul class="mt-5 space-y-3">
                  <For each={catalog()?.templates}>
                    {(template) => (
                      <li class="flex items-center justify-between gap-3 rounded-lg border border-v2-border-border-weak bg-v2-background-bg-base p-3">
                        <div class="min-w-0">
                          <p class="truncate font-[560] text-v2-text-text-strong">{template.title}</p>
                          <p class="mt-1 text-xs text-v2-text-text-muted">{language.t("workflow.home.nodeCount", { count: template.graph.nodes.length })}</p>
                        </div>
                        <div class="flex shrink-0 gap-2">
                          <ButtonV2 variant="ghost-muted" size="small" onClick={() => navigate(`/workflow/template/${encodeURIComponent(template.id)}`)}>
                            {language.t("workflow.home.edit")}
                          </ButtonV2>
                          <ButtonV2
                            variant="ghost-muted"
                            size="small"
                            disabled={form.busy !== undefined || !form.requirement.trim()}
                            onClick={() => void startRun(template.id)}
                          >
                            {form.busy === template.id ? language.t("workflow.home.starting") : language.t("workflow.home.start")}
                          </ButtonV2>
                        </div>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </article>
            <article class="rounded-xl border border-v2-border-border-weak bg-v2-background-bg-layer-02 p-4 sm:p-6">
              <h2 class="text-sm font-[560] text-v2-text-text-strong">{language.t("workflow.home.runs")}</h2>
              <Show when={catalog()?.runs.length} fallback={<p class="mt-6 text-sm text-v2-text-text-muted">{language.t("workflow.home.noRuns")}</p>}>
                <ul class="mt-4 space-y-3">
                  <For each={catalog()?.runs}>
                    {(run) => (
                      <li>
                        <button
                          type="button"
                          class="flex w-full items-center justify-between gap-3 rounded-lg border border-v2-border-border-weak bg-v2-background-bg-base p-3 text-left outline-none hover:bg-v2-background-bg-layer-03 focus-visible:ring-2 focus-visible:ring-v2-icon-icon-accent"
                          onClick={() => navigate(`/workflow/run/${encodeURIComponent(run.id)}`)}
                        >
                          <span class="truncate text-sm font-[560] text-v2-text-text-strong">{run.id}</span>
                          <span class="shrink-0 text-xs text-v2-text-text-muted">{language.t("workflow.home.nodeCount", { count: run.graph.nodes.length })}</span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </article>
          </section>

          <section class="rounded-xl border border-v2-border-border-weak bg-v2-background-bg-layer-02 p-4 sm:p-6">
            <div>
              <h2 class="text-sm font-[560] text-v2-text-text-strong">{language.t("workflow.home.examples")}</h2>
              <p class="mt-1 text-xs text-v2-text-text-muted">{language.t("workflow.home.examplesDescription")}</p>
            </div>
            <div class="mt-4 grid gap-3 md:grid-cols-3">
              <For each={EXAMPLE_TEMPLATES}>
                {(example) => (
                  <article class="flex flex-col rounded-lg border border-v2-border-border-weak bg-v2-background-bg-base p-3">
                    <h3 class="text-sm font-[560] text-v2-text-text-strong">{language.t(example.title)}</h3>
                    <p class="mt-1 flex-1 text-xs leading-5 text-v2-text-text-muted">{language.t(example.description)}</p>
                    <ButtonV2 class="mt-3 self-start" variant="ghost-muted" size="small" disabled={form.busy !== undefined} onClick={() => void createExample(example)}>
                      {form.busy === example.id ? language.t("workflow.home.creating") : language.t("workflow.home.useExample")}
                    </ButtonV2>
                  </article>
                )}
              </For>
            </div>
          </section>

        <form class="flex flex-col gap-3 sm:flex-row" onSubmit={(event) => { event.preventDefault(); open() }}>
          <input
            value={form.runID}
            onInput={(event) => setForm("runID", event.currentTarget.value)}
            class="min-w-0 flex-1 rounded-lg border border-v2-border-border-weak bg-v2-background-bg-base px-3 py-2.5 text-sm text-v2-text-text-strong outline-none placeholder:text-v2-text-text-muted focus:border-v2-icon-icon-accent"
            placeholder={language.t("workflow.home.placeholder")}
            aria-label={language.t("workflow.home.placeholder")}
          />
          <ButtonV2 type="submit" variant="ghost-muted" size="normal" disabled={!form.runID.trim()}>
            {language.t("workflow.home.open")}
          </ButtonV2>
        </form>
      </div>
    </main>
  )
}

type ExampleTemplate = {
  id: string
  title: string
  description: string
  graph: (directory?: string) => ReturnType<typeof starterGraph>
}

const EXAMPLE_TEMPLATES: ExampleTemplate[] = [
  {
    id: "research-build-test",
    title: "workflow.home.example.researchBuildTest.title",
    description: "workflow.home.example.researchBuildTest.description",
    graph: (directory) => pipelineGraph("Research, build and test", [
      ["research", "Research", "Collect requirements and propose an implementation plan."],
      ["implement", "Implement", "Implement the plan in the workspace."],
      ["test", "Test", "Run the relevant tests and report failures."],
    ], directory),
  },
  {
    id: "content-review",
    title: "workflow.home.example.contentReview.title",
    description: "workflow.home.example.contentReview.description",
    graph: (directory) => pipelineGraph("Content review", [
      ["research", "Draft", "Draft a clear and concise version of the requested content."],
      ["review", "Review", "Check accuracy, tone, and completeness."],
      ["approval", "Approval", "Wait for a human decision before publishing."],
    ], directory),
  },
  {
    id: "parallel-feedback",
    title: "workflow.home.example.parallelFeedback.title",
    description: "workflow.home.example.parallelFeedback.description",
    graph: (directory) => parallelGraph(directory),
  },
]

function pipelineGraph(title: string, stages: Array<["research" | "implement" | "review" | "test" | "approval", string, string]>, directory?: string) {
  const nodes = [
    {
      id: "root", kind: "root" as const, title, objective: "", inputs: {},
      outputs: { result: { handoffType: "task_spec" as const, many: true, mode: "artifact" as const } },
      workspace: { mode: "none" as const }, config: {}, display: { x: 40, y: 180 },
    },
    ...stages.map(([kind, nodeTitle, objective], index) => ({
      id: `stage-${index}`, kind, title: nodeTitle, objective,
      inputs: { context: { handoffTypes: ["task_spec", "summary", "research", "plan", "patch", "generic_document"] as const, required: index === 0, many: false, mode: "dependency" as const } },
      outputs: { result: { handoffType: "summary" as const, many: false, mode: "artifact" as const }, message: { handoffType: "generic_document" as const, many: true, mode: "message" as const } },
      workspace: { mode: "write" as const, directory }, config: {}, display: { x: 360 + index * 340, y: 180 },
    })),
  ]
  return { nodes, edges: nodes.slice(1).map((node, index) => ({ id: `edge-${index}`, sourceNodeID: nodes[index].id, sourcePort: "result" as const, targetNodeID: node.id, targetPort: "context" as const, condition: "success" as const })) }
}

function parallelGraph(directory?: string) {
  const graph = pipelineGraph("Parallel feedback", [["research", "Analyze", "Analyze the request and identify risks."]], directory)
  const stages = [
    ["review", "Quality review", "Review the request from a quality perspective.", 360, 80],
    ["test", "Technical review", "Review the request from a technical perspective.", 360, 280],
  ] as const
  graph.nodes.push(...stages.map(([kind, title, objective, x, y]) => ({
    id: title.toLowerCase().replaceAll(" ", "-"), kind, title, objective,
    inputs: { context: { handoffTypes: ["task_spec", "summary", "research", "plan", "patch", "generic_document"] as const, required: true, many: false, mode: "dependency" as const } },
    outputs: { result: { handoffType: "summary" as const, many: false, mode: "artifact" as const } }, workspace: { mode: "write" as const, directory }, config: {}, display: { x, y },
  })))
  graph.edges.push(...graph.nodes.slice(2).map((node, index) => ({ id: `parallel-edge-${index}`, sourceNodeID: "stage-0", sourcePort: "result" as const, targetNodeID: node.id, targetPort: "context" as const, condition: "success" as const })))
  return graph
}

function starterGraph(title: string, objective: string, directory?: string) {
  return {
    nodes: [
      {
        id: "root",
        kind: "root" as const,
        title: title,
        objective: "",
        inputs: {},
        outputs: { result: { handoffType: "task_spec" as const, many: true, mode: "artifact" as const } },
        workspace: { mode: "none" as const },
        config: {},
        display: { x: 40, y: 40 },
      },
      {
        id: "task",
        kind: "task" as const,
        title,
        objective,
        inputs: {
          context: { handoffTypes: ["task_spec", "summary", "research", "plan", "patch", "generic_document"], required: true, many: false, mode: "dependency" as const },
          inbox: { handoffTypes: ["generic_document"], required: false, many: true, mode: "queue" as const },
        },
        outputs: {
          result: { handoffType: "summary" as const, many: false, mode: "artifact" as const },
          message: { handoffType: "generic_document" as const, many: true, mode: "message" as const },
        },
        workspace: { mode: "write" as const, directory },
        config: {},
        display: { x: 360, y: 40 },
      },
    ],
    edges: [
      {
        id: "root-to-task",
        sourceNodeID: "root",
        sourcePort: "result",
        targetNodeID: "task",
        targetPort: "context",
        condition: "success" as const,
      },
    ],
  }
}

import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, createResource, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { sessionHref } from "@/utils/session-route"
import { workflowClient } from "@/pages/workflow-client"

type Status = "pending" | "ready" | "running" | "waiting" | "blocked" | "completed" | "failed" | "cancelled"
type History = Awaited<ReturnType<typeof loadHistory>>
const NODE_W = 240
const NODE_H = 148

export function WorkflowRunPage() {
  const params = useParams<{ runID: string }>()
  const language = useLanguage()
  const navigate = useNavigate()
  const server = useServer()
  const sdk = useServerSDK()
  const [state, setState] = createStore({
    refresh: 0,
    executing: undefined as "drain" | "execute" | "advance" | undefined,
    history: { data: [], hasMore: false } as History,
    ack: undefined as string | undefined,
  })
  const [run] = createResource(() => [params.runID, state.refresh] as const, ([runID]) => loadRun(sdk(), runID))

  const timer = setInterval(() => setState("refresh", (value) => value + 1), 3000)
  onCleanup(() => clearInterval(timer))

  createEffect(() => {
    const runID = params.runID
    setState("history", { data: [], hasMore: false })
    void loadHistory(sdk(), runID)
      .then((next) => setState("history", next))
      .catch(() => setState("history", { data: [], hasMore: false }))
  })

  createEffect(() => {
    state.refresh
    const latest = state.history.data.at(-1)?.durable?.seq
    if (latest === undefined) return
    void loadHistory(sdk(), params.runID, latest).then((next) => {
      if (next.data.length === 0) return
      setState("history", (current) => ({ data: [...current.data, ...next.data], hasMore: current.hasMore }))
    })
  })

  const execute = async (action: "drain" | "execute" | "advance") => {
    setState("executing", action)
    try {
      const client = workflowClient(sdk())
      if (action === "drain") await client.run.drain({ runID: params.runID })
      else if (action === "advance") await client.run.advance({ runID: params.runID })
      else await client.execute({ runID: params.runID })
      setState("refresh", (value) => value + 1)
    } finally {
      setState("executing", undefined)
    }
  }

  const acknowledge = async (nodeID: string, port: string, sequence: number) => {
    const key = `${nodeID}:${port}:${sequence}`
    setState("ack", key)
    try {
      await workflowClient(sdk()).handoff.queue.acknowledge({ runID: params.runID, nodeID, port, sequence })
      setState("refresh", (value) => value + 1)
    } finally {
      setState("ack", undefined)
    }
  }

  return (
    <main class="fixed inset-0 z-50 overflow-auto bg-v2-background-bg-base px-5 py-6 lg:px-12 lg:py-10">
      <div class="mx-auto flex w-full max-w-7xl flex-col gap-7 pb-12">
        <header class="flex flex-col gap-4 border-b border-v2-border-border-weak pb-6 sm:flex-row sm:items-start sm:justify-between">
          <div class="min-w-0">
            <p class="text-xs font-medium uppercase tracking-[0.14em] text-v2-text-text-muted">{language.t("workflow.run.eyebrow")}</p>
            <h1 class="mt-2 truncate text-2xl font-[560] text-v2-text-text-strong">{run()?.run.id ?? params.runID}</h1>
            <p class="mt-2 text-sm text-v2-text-text-muted">{language.t("workflow.run.description")}</p>
          </div>
          <div class="flex flex-wrap gap-2">
            <ButtonV2 variant="ghost-muted" size="normal" disabled={state.executing !== undefined} onClick={() => void execute("drain")}>
              {state.executing === "drain" ? language.t("workflow.run.admitting") : language.t("workflow.run.admit")}
            </ButtonV2>
            <ButtonV2 variant="ghost-muted" size="normal" disabled={state.executing !== undefined} onClick={() => void execute("execute")}>
              {state.executing === "execute" ? language.t("workflow.run.executing") : language.t("workflow.run.execute")}
            </ButtonV2>
            <ButtonV2 variant="neutral" size="normal" disabled={state.executing !== undefined} onClick={() => void execute("advance")}>
              {state.executing === "advance" ? language.t("workflow.run.advancing") : language.t("workflow.run.advance")}
            </ButtonV2>
            <ButtonV2 variant="ghost-muted" size="normal" onClick={() => navigate("/workflow")}>
              {language.t("workflow.home.eyebrow")}
            </ButtonV2>
            <ButtonV2 variant="ghost-muted" size="normal" icon="close" onClick={() => navigate("/")}>
              {language.t("common.close")}
            </ButtonV2>
          </div>
        </header>

        <Show when={run.loading}>
          <p class="text-sm text-v2-text-text-muted">{language.t("workflow.run.loading")}</p>
        </Show>
        <Show when={run.error}>
          <p class="rounded-lg border border-icon-critical-base/30 bg-icon-critical-base/10 p-4 text-sm text-v2-text-text-strong">
            {language.t("workflow.run.unavailable")}
          </p>
        </Show>
        <Show when={run()}>
          {(data) => (
            <RunContent
              data={data()}
              history={state.history}
              ack={state.ack}
              sessionHref={(sessionID) => (server.key ? sessionHref(server.key, sessionID) : undefined)}
              onAcknowledge={acknowledge}
            />
          )}
        </Show>
      </div>
    </main>
  )
}

function RunContent(props: {
  data: Awaited<ReturnType<typeof loadRun>>
  history: History
  ack: string | undefined
  sessionHref: (sessionID: string) => string | undefined
  onAcknowledge: (nodeID: string, port: string, sequence: number) => void
}) {
  const language = useLanguage()
  const navigate = useNavigate()
  const titles = createMemo(() => new Map(props.data.run.graph.nodes.map((node) => [node.id, node.title] as const)))
  const item = (nodeID: string) => props.data.items.find((entry) => entry.nodeID === nodeID)
  const status = (nodeID: string): Status => item(nodeID)?.status ?? "pending"
  const queues = () => props.data.queues.filter((queue) => queue.messages.length > 0)
  const extent = createMemo(() => ({
    width: Math.max(960, ...props.data.run.graph.nodes.map((node) => node.display.x + NODE_W + 48)),
    height: Math.max(400, ...props.data.run.graph.nodes.map((node) => node.display.y + NODE_H + 48)),
  }))
  const edgeMode = (edge: (typeof props.data.run.graph.edges)[number]) =>
    props.data.run.graph.nodes.find((node) => node.id === edge.sourceNodeID)?.outputs[edge.sourcePort]?.mode
  return (
    <>
      <section class="grid gap-3 sm:grid-cols-3">
        <Metric label={language.t("workflow.run.nodes")} value={String(props.data.run.graph.nodes.length)} />
        <Metric label={language.t("workflow.run.active")} value={String(props.data.items.filter((entry) => entry.status === "running").length)} />
        <Metric label={language.t("workflow.run.cost")} value={formatCost(props.data.cost.estimatedMicrousd)} />
      </section>
      <section class="rounded-xl border border-v2-border-border-weak bg-v2-background-bg-layer-02 p-4 sm:p-6">
        <div class="mb-5 flex items-center justify-between gap-4">
          <h2 class="text-sm font-[560] text-v2-text-text-strong">{language.t("workflow.run.graph")}</h2>
          <span class="text-xs text-v2-text-text-muted">{language.t("workflow.run.connectionCount", { count: props.data.run.graph.edges.length })}</span>
        </div>
        <div class="relative overflow-auto rounded-lg border border-v2-border-border-weak bg-v2-background-bg-base" style={{ height: "min(70vh, 640px)" }}>
          <div class="relative" style={{ width: `${extent().width}px`, height: `${extent().height}px` }}>
            <svg class="pointer-events-none absolute inset-0 h-full w-full">
              <For each={props.data.run.graph.edges}>
                {(edge) => {
                  const source = () => props.data.run.graph.nodes.find((node) => node.id === edge.sourceNodeID)
                  const target = () => props.data.run.graph.nodes.find((node) => node.id === edge.targetNodeID)
                  return (
                    <Show when={source() && target()}>
                      <line
                        class="stroke-v2-icon-icon-accent"
                        stroke-width="2"
                        stroke-dasharray={edgeMode(edge) === "message" ? "6 4" : undefined}
                        x1={(source()?.display.x ?? 0) + NODE_W}
                        y1={(source()?.display.y ?? 0) + NODE_H * (edge.sourcePort === "message" ? 0.65 : 0.35)}
                        x2={target()?.display.x ?? 0}
                        y2={(target()?.display.y ?? 0) + NODE_H * (edge.targetPort === "inbox" ? 0.65 : 0.35)}
                      />
                    </Show>
                  )
                }}
              </For>
            </svg>
            <For each={props.data.run.graph.nodes}>
              {(node) => {
                const sessionID = () => item(node.id)?.sessionID
                const href = () => {
                  const id = sessionID()
                  return id ? props.sessionHref(id) : undefined
                }
                return (
                  <article
                    class="absolute overflow-hidden rounded-lg border border-v2-border-border-weak bg-v2-background-bg-layer-02 p-3"
                    style={{ left: `${node.display.x}px`, top: `${node.display.y}px`, width: `${NODE_W}px`, height: `${NODE_H}px` }}
                  >
                    <div class={`absolute inset-x-0 top-0 h-1 ${statusColor(status(node.id))}`} />
                    <div class="flex items-start justify-between gap-3">
                      <div class="min-w-0">
                        <h3 class="truncate font-[560] text-v2-text-text-strong">{node.title}</h3>
                        <p class="mt-1 line-clamp-2 text-xs text-v2-text-text-muted">{node.objective}</p>
                      </div>
                      <StatusBadge status={status(node.id)} />
                    </div>
                    <p class="mt-2 truncate text-xs text-v2-text-text-muted">{node.workspace.directory ?? language.t("workflow.run.noDirectory")}</p>
                    <div class="mt-2">
                      <Show when={href()} fallback={<p class="text-xs text-v2-text-text-muted">{language.t("workflow.run.noSession")}</p>}>
                        {(value) => (
                          <ButtonV2 variant="ghost-muted" size="small" onClick={() => navigate(value())}>
                            {language.t("workflow.run.openSession")}
                          </ButtonV2>
                        )}
                      </Show>
                    </div>
                  </article>
                )
              }}
            </For>
          </div>
        </div>
      </section>
      <Show when={props.data.queues.length > 0}>
        <section class="rounded-xl border border-v2-border-border-weak bg-v2-background-bg-layer-02 p-4 sm:p-6">
          <h2 class="text-sm font-[560] text-v2-text-text-strong">{language.t("workflow.run.queue")}</h2>
          <Show when={queues().length > 0} fallback={<p class="mt-4 text-sm text-v2-text-text-muted">{language.t("workflow.run.noQueue")}</p>}>
            <ul class="mt-4 space-y-3">
              <For each={queues()}>
                {(queue) => (
                  <For each={queue.messages}>
                    {(message) => (
                      <li class="flex items-start justify-between gap-3 rounded-lg border border-v2-border-border-weak bg-v2-background-bg-base p-3">
                        <div class="min-w-0">
                          <p class="text-sm font-[560] text-v2-text-text-strong">
                            {language.t("workflow.run.event.handoff", {
                              source: titles().get(message.sourceNodeID) ?? message.sourceNodeID,
                              target: titles().get(message.targetNodeID) ?? message.targetNodeID,
                            })}
                          </p>
                          <p class="mt-1 truncate text-xs text-v2-text-text-muted">{payloadText(message.payload)}</p>
                        </div>
                        <ButtonV2
                          variant="ghost-muted"
                          size="small"
                          disabled={props.ack !== undefined}
                          onClick={() => props.onAcknowledge(queue.nodeID, queue.port, message.sequence)}
                        >
                          {props.ack === `${queue.nodeID}:${queue.port}:${message.sequence}`
                            ? language.t("workflow.run.acknowledging")
                            : language.t("workflow.run.acknowledge")}
                        </ButtonV2>
                      </li>
                    )}
                  </For>
                )}
              </For>
            </ul>
          </Show>
        </section>
      </Show>
      <section class="grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
        <article class="rounded-xl border border-v2-border-border-weak bg-v2-background-bg-layer-02 p-4 sm:p-6">
          <h2 class="text-sm font-[560] text-v2-text-text-strong">{language.t("workflow.run.activity")}</h2>
          <Show when={props.history.data.length > 0} fallback={<p class="py-8 text-sm text-v2-text-text-muted">{language.t("workflow.run.noActivity")}</p>}>
            <ol class="mt-4 space-y-3">
              <For each={props.history.data.slice(-12).reverse()}>
                {(event) => (
                  <li class="border-l-2 border-v2-border-border-weak pl-3 text-sm text-v2-text-text-muted">
                    {eventLabel(event, titles(), language)}
                  </li>
                )}
              </For>
            </ol>
          </Show>
        </article>
        <article class="rounded-xl border border-v2-border-border-weak bg-v2-background-bg-layer-02 p-4 sm:p-6">
          <h2 class="text-sm font-[560] text-v2-text-text-strong">{language.t("workflow.run.costBreakdown")}</h2>
          <p class="mt-3 text-2xl font-[560] text-v2-text-text-strong">{formatCost(props.data.cost.estimatedMicrousd)}</p>
          <p class="mt-1 text-sm text-v2-text-text-muted">{language.t("workflow.run.unpriced", { count: props.data.cost.unpricedAttempts })}</p>
          <For each={props.data.cost.groups}>
            {(group) => <p class="mt-3 text-xs text-v2-text-text-muted">{group.providerID}/{group.modelID}: {formatCost(group.estimatedMicrousd)}</p>}
          </For>
        </article>
      </section>
    </>
  )
}

function Metric(props: { label: string; value: string }) {
  return <div class="rounded-xl border border-v2-border-border-weak bg-v2-background-bg-layer-02 p-4"><p class="text-xs text-v2-text-text-muted">{props.label}</p><p class="mt-2 text-xl font-[560] text-v2-text-text-strong">{props.value}</p></div>
}

function StatusBadge(props: { status: Status }) {
  const language = useLanguage()
  return <span class={`shrink-0 rounded-full px-2 py-1 text-xs ${statusColor(props.status)}`}>{language.t(`workflow.status.${props.status}`)}</span>
}

function statusColor(status: Status) {
  if (status === "completed") return "bg-success-base/15 text-success-base"
  if (status === "failed" || status === "blocked") return "bg-icon-critical-base/15 text-icon-critical-base"
  if (status === "running") return "bg-v2-icon-icon-accent/15 text-v2-icon-icon-accent"
  if (status === "waiting") return "bg-icon-warning-base/15 text-icon-warning-base"
  return "bg-v2-background-bg-layer-03 text-v2-text-text-muted"
}

function formatCost(microusd: number | undefined) {
  return microusd === undefined ? "-" : `$${(microusd / 1_000_000).toFixed(4)}`
}

function payloadText(payload: unknown) {
  if (typeof payload === "string") return payload
  if (payload && typeof payload === "object" && "text" in payload && typeof payload.text === "string") return payload.text
  return JSON.stringify(payload)
}

function eventLabel(
  event: History["data"][number],
  titles: Map<string, string>,
  language: ReturnType<typeof useLanguage>,
) {
  const title = (id: string) => titles.get(id) ?? id
  if (event.type === "workflow.work-item.status-changed") {
    return language.t("workflow.run.event.status", {
      node: title(event.data.nodeID),
      status: language.t(`workflow.status.${event.data.status}`),
    })
  }
  if (event.type === "workflow.handoff.sent") {
    return language.t("workflow.run.event.handoff", {
      source: title(event.data.handoff.sourceNodeID),
      target: title(event.data.handoff.targetNodeID),
    })
  }
  if (event.type === "workflow.queue.acknowledged") {
    return language.t("workflow.run.event.ack", { node: title(event.data.nodeID), port: event.data.port })
  }
  return event.type
}

async function loadRun(server: ReturnType<typeof useServerSDK>, runID: string) {
  const client = workflowClient(server)
  const [run, items, cost] = await Promise.all([
    client.run.get({ runID }).then((result) => result.data.data),
    client.run.workItems({ runID }).then((result) => result.data.data),
    client.run.cost({ runID }).then((result) => result.data.data),
  ])
  const queues = await Promise.all(
    run.graph.nodes.flatMap((node) =>
      Object.entries(node.inputs)
        .filter(([, port]) => port.mode === "queue")
        .map(async ([port]) => ({
          nodeID: node.id,
          port,
          messages: (await client.handoff.queue.read({ runID, nodeID: node.id, port })).data.data,
        })),
    ),
  )
  return { run, items, cost, queues }
}

async function loadHistory(server: ReturnType<typeof useServerSDK>, runID: string, after?: number) {
  return (
    await workflowClient(server).history({
      runID,
      limit: "100",
      after: after === undefined ? undefined : String(after),
    })
  ).data
}

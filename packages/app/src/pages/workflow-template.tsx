import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, createResource, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { getFilename } from "@opencode-ai/core/util/path"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useProviders } from "@/hooks/use-providers"
import { resolveDefaultModel } from "@/hooks/provider-catalog"
import { workflowClient } from "@/pages/workflow-client"

type Node = Awaited<ReturnType<typeof loadTemplate>>["graph"]["nodes"][number]
type Edge = Awaited<ReturnType<typeof loadTemplate>>["graph"]["edges"][number]
type Port = string
type Gesture =
  | { type: "pan"; x: number; y: number }
  | { type: "node"; ids: string[]; origin: { x: number; y: number }; start: Record<string, { x: number; y: number }> }
  | { type: "link"; nodeID: string; port: Port; x: number; y: number }
  | { type: "box"; x0: number; y0: number; x1: number; y1: number }

const NODE_W = 304
const NODE_H = 188
const NODE_HEADER_H = 48
const PORT_HEADING_H = 20
const PORT_ROW_H = 28
const PORT_SECTION_GAP = 8
const PORT_ROW_GAP = 4
function nodeSize(node: Node | Node["kind"]) {
  const kind = typeof node === "string" ? node : node.kind
  if (kind === "root") return { w: 148, h: 52 }
  if (typeof node !== "string") {
    const ports = Math.max(Object.keys(node.inputs).length, Object.keys(node.outputs).length, 1)
    const prompts = Object.keys(promptTexts(node)).length
    return { w: NODE_W, h: Math.max(NODE_H, NODE_HEADER_H + 12 + PORT_HEADING_H + PORT_SECTION_GAP + ports * PORT_ROW_H + Math.max(0, ports - 1) * PORT_ROW_GAP + 12 + prompts * 38) }
  }
  return { w: NODE_W, h: NODE_H }
}

type NodeDisplayFlag = "showInputs" | "showOutputs" | "showWorkspace" | "showPrompt"

function nodeFlag(node: Node | undefined, key: NodeDisplayFlag) {
  return node?.config[key] !== false
}

function nodeTools(node: Node) {
  const tools = node.config.tools
  if (!Array.isArray(tools)) return []
  return tools.filter((item): item is string => typeof item === "string")
}

function portRows(node: Node) {
  const inputs = Object.keys(node.inputs)
  const outputs = Object.keys(node.outputs)
  return Array.from({ length: Math.max(inputs.length, outputs.length) }, (_, index) => ({ input: inputs[index], output: outputs[index] }))
}

function portColor(label: string) {
  if (label.includes("queue")) return "#d99a36"
  if (label.includes("message")) return "#b779d6"
  if (label.includes("artifact")) return "#55b887"
  return "#6ca9e6"
}

function portLabel(port: string, language: ReturnType<typeof useLanguage>) {
  if (port === "context") return language.t("workflow.template.port.context")
  if (port === "inbox") return language.t("workflow.template.port.inbox")
  if (port === "result") return language.t("workflow.template.port.result")
  if (port === "message") return language.t("workflow.template.port.message")
  return port
}

function nodeDescription(kind: Node["kind"]) {
  if (kind === "root") return "workflow.template.description.root"
  if (kind === "research") return "workflow.template.description.research"
  if (kind === "implement") return "workflow.template.description.implement"
  if (kind === "review") return "workflow.template.description.review"
  if (kind === "test") return "workflow.template.description.test"
  if (kind === "approval") return "workflow.template.description.approval"
  return "workflow.template.description.task"
}

function promptTexts(node: Node) {
  const value = node.config.promptTexts
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, string>
}

function promptFiles(node: Node) {
  const value = node.config.promptFiles
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, string>
}

function setPromptFile(draft: { nodes: Node[] }, setDraft: (key: "nodes", value: Node[]) => void, index: number, name: string, value: string) {
  setDraft("nodes", draft.nodes.map((item, itemIndex) => itemIndex === index ? { ...item, config: { ...item.config, promptFiles: { ...promptFiles(item), [name]: value || undefined } } } : item))
}

function addPrompt(draft: { nodes: Node[] }, setDraft: (key: "nodes", value: Node[]) => void, index: number) {
  const node = draft.nodes[index]
  if (!node) return
  const name = `prompt${Object.keys(promptTexts(node)).length}`
  setDraft("nodes", draft.nodes.map((item, itemIndex) => {
    if (itemIndex !== index) return item
    return {
      ...item,
      inputs: name === "prompt0" ? item.inputs : { ...item.inputs, [name]: { handoffTypes: ["generic_document"], required: false, many: true, mode: "queue" } },
      outputs: { ...item.outputs, [name]: { handoffType: "generic_document", many: true, mode: "message" } },
      config: { ...item.config, promptTexts: { ...promptTexts(item), [name]: "" } },
    }
  }))
}

function updatePromptText(draft: { nodes: Node[] }, setDraft: (key: "nodes", value: Node[]) => void, index: number, name: string, text: string) {
  setDraft("nodes", draft.nodes.map((item, itemIndex) => itemIndex === index ? { ...item, config: { ...item.config, promptTexts: { ...promptTexts(item), [name]: text } } } : item))
}

function toggleNodeFlag(
  draft: { nodes: Node[] },
  setDraft: (key: "nodes", value: Node[]) => void,
  nodeID: string,
  key: NodeDisplayFlag,
) {
  setDraft(
    "nodes",
    draft.nodes.map((node) => {
      if (node.id !== nodeID) return node
      return { ...node, config: { ...node.config, [key]: node.config[key] === false } }
    }),
  )
}

function nodeChrome(kind: Node["kind"]) {
  if (kind === "root") return { border: "#8b6cc9", header: "rgba(139,108,201,0.28)", radius: "999px" }
  if (kind === "research") return { border: "#4d8ec8", header: "rgba(77,142,200,0.22)", radius: "10px" }
  if (kind === "implement") return { border: "#3f9a6e", header: "rgba(63,154,110,0.22)", radius: "10px" }
  if (kind === "review") return { border: "#c4902c", header: "rgba(196,144,44,0.22)", radius: "10px" }
  if (kind === "test") return { border: "#2a9aa8", header: "rgba(42,154,168,0.22)", radius: "10px" }
  if (kind === "approval") return { border: "#c45c78", header: "rgba(196,92,120,0.22)", radius: "10px" }
  return { border: "var(--color-v2-border-border-weak, #4a4a4a)", header: "rgba(255,255,255,0.04)", radius: "10px" }
}

export function WorkflowTemplatePage() {
  const params = useParams<{ templateID: string }>()
  const language = useLanguage()
  const navigate = useNavigate()
  const layout = useLayout()
  const serverSync = useServerSync()
  const sdk = useServerSDK()
  const [template] = createResource(() => params.templateID, (templateID) => loadTemplate(sdk(), templateID))
  const [draft, setDraft] = createStore({
    title: "",
    promptFile: "",
    nodes: [] as Node[],
    edges: [] as Edge[],
    selected: [] as string[],
    view: { x: 0, y: 0, zoom: 1 },
    gesture: undefined as Gesture | undefined,
    menu: undefined as { x: number; y: number; nodeID?: string } | undefined,
    saving: false,
    invalid: false,
  })
  let viewport: HTMLDivElement | undefined

  createEffect(() => {
    const value = template()
    if (!value) return
    const nodes = value.graph.nodes.map(withPorts)
    setDraft({
      title: value.title,
      promptFile: value.graph.promptFile ?? "",
      nodes,
      edges: value.graph.edges.slice(),
      selected: [],
      menu: undefined,
      invalid: false,
    })
    requestAnimationFrame(() => fitCanvas(nodes, viewport, setDraft))
  })

  onMount(() => {
    const onMove = (event: PointerEvent) => {
      const gesture = draft.gesture
      if (!gesture || !viewport) return
      if (gesture.type === "pan") {
        setDraft("view", { x: event.clientX - gesture.x, y: event.clientY - gesture.y, zoom: draft.view.zoom })
        return
      }
      const point = worldPoint(viewport, draft.view, event)
      if (gesture.type === "box") {
        setDraft("gesture", { ...gesture, x1: point.x, y1: point.y })
        return
      }
      if (gesture.type === "node") {
        gesture.ids.forEach((id) => {
          const start = gesture.start[id]
          const index = draft.nodes.findIndex((node) => node.id === id)
          if (!start || index < 0) return
          setDraft("nodes", index, "display", { x: start.x + point.x - gesture.origin.x, y: start.y + point.y - gesture.origin.y })
        })
        return
      }
      setDraft("gesture", { ...gesture, x: point.x, y: point.y })
    }
    const onUp = (event: PointerEvent) => {
      const gesture = draft.gesture
      setDraft("gesture", undefined)
      if (!gesture) return
      if (gesture.type === "box") {
        const left = Math.min(gesture.x0, gesture.x1)
        const top = Math.min(gesture.y0, gesture.y1)
        const right = Math.max(gesture.x0, gesture.x1)
        const bottom = Math.max(gesture.y0, gesture.y1)
        const hits = draft.nodes.filter((node) => {
          const size = nodeSize(node.kind)
          return node.display.x < right && node.display.x + size.w > left && node.display.y < bottom && node.display.y + size.h > top
        }).map((node) => node.id)
        setDraft("selected", event.ctrlKey || event.metaKey ? [...new Set([...draft.selected, ...hits])] : hits)
        return
      }
      if (gesture.type !== "link") return
      const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-workflow-port]")
      if (!hit) return
      connectPorts(draft, setDraft, gesture.nodeID, gesture.port, hit.getAttribute("data-node") ?? "", hit.getAttribute("data-port") as Port)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return
      if ((event.target as HTMLElement).closest("input,textarea,select")) return
      removeNodes(draft, setDraft, draft.selected)
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("keydown", onKey)
    onCleanup(() => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("keydown", onKey)
    })
  })

  const directory = createMemo(() => draft.nodes.find((node) => node.workspace?.directory)?.workspace?.directory)
  const selected = createMemo(() => draft.nodes.find((node) => node.id === draft.selected[0]))
  const selectedIndex = createMemo(() => draft.nodes.findIndex((node) => node.id === draft.selected[0]))
  const [agents] = createResource(
    () => selected()?.workspace?.directory,
    async (dir) => {
      if (!dir) return []
      const listed = await sdk().createClient({ throwOnError: true }).v2.agent.list({ location: { directory: dir } })
      return listed.data.data.filter((agent) => !agent.hidden)
    },
  )
  const [toolIds] = createResource(
    () => selected()?.workspace?.directory,
    async (dir) => {
      const listed = await sdk().createClient({ throwOnError: true }).tool.ids(dir ? { directory: dir } : {})
      return listed.data.filter((name) => !name.startsWith("workflow_"))
    },
  )
  const providers = useProviders(() => selected()?.workspace?.directory)
  const models = createMemo(() =>
    providers.connected().flatMap((provider) =>
      Object.values(provider.models).map((model) => ({
        key: `${provider.id}/${model.id}`,
        label: `${provider.name} / ${model.name}`,
        providerID: provider.id,
        modelID: model.id,
      })),
    ),
  )
  const defaultModel = createMemo(() => {
    const ref = resolveDefaultModel(providers.defaultModel(), serverSync().data.config.model)
    if (!ref) return
    return models().find((model) => model.key === `${ref.providerID}/${ref.modelID}`)?.label ?? `${ref.providerID}/${ref.modelID}`
  })
  const workspaces = createMemo(() => {
    const opened = layout.projects.list().filter((project) => project.id && project.id !== "global")
    const projects = opened.length > 0 ? opened : serverSync().data.project.filter((project) => project.id !== "global")
    return projects.flatMap((project) => {
      const name = project.name || getFilename(project.worktree)
      return [project.worktree, ...(project.sandboxes ?? [])].map((directory) => ({
        directory,
        label: directory === project.worktree ? name : `${name} / ${getFilename(directory)}`,
      }))
    })
  })
  const save = async () => {
    setDraft("saving", true)
    setDraft("invalid", false)
    try {
      await workflowClient(sdk()).template.update({
        templateID: params.templateID,
        title: draft.title.trim() || undefined,
        graph: { nodes: draft.nodes, edges: draft.edges, promptFile: draft.promptFile.trim() || undefined },
      })
    } catch {
      setDraft("invalid", true)
    } finally {
      setDraft("saving", false)
    }
  }

  return (
    <main class="relative z-0 grid h-full min-h-0 min-w-0 flex-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-v2-background-bg-base">
      <header class="relative z-30 flex h-16 min-h-0 shrink-0 items-center justify-between gap-4 border-b border-v2-border-border-weak bg-v2-background-bg-base px-5 py-2 lg:px-8">
        <div class="flex min-w-0 flex-1 items-center gap-5">
          <div class="min-w-0 shrink-0">
          <p class="text-xs font-medium uppercase tracking-[0.14em] text-v2-text-text-muted">{language.t("workflow.template.eyebrow")}</p>
          <input
            value={draft.title}
            onInput={(event) => setDraft("title", event.currentTarget.value)}
            class="mt-0.5 w-44 max-w-full bg-transparent text-base font-[560] text-v2-text-text-strong outline-none"
            aria-label={language.t("workflow.home.titlePlaceholder")}
          />
          </div>
          <input
            value={draft.promptFile}
            onInput={(event) => setDraft("promptFile", event.currentTarget.value)}
            class="min-w-0 max-w-xl flex-1 bg-transparent text-xs text-v2-text-text-muted outline-none"
            placeholder={language.t("workflow.template.promptPlaceholder")}
            aria-label={language.t("workflow.template.basePrompt")}
          />
        </div>
        <div class="flex flex-wrap gap-2">
          <ButtonV2
            variant="ghost-muted"
            size="normal"
            onClick={() =>
              addNode(draft, setDraft, directory(), language.t("workflow.template.nodeTitle"), {
                x: (180 - draft.view.x) / draft.view.zoom,
                y: (120 - draft.view.y) / draft.view.zoom,
              })
            }
          >
            {language.t("workflow.template.addNode")}
          </ButtonV2>
          <ButtonV2
            variant="ghost-muted"
            size="normal"
            onClick={() =>
              addRoot(draft, setDraft, language.t("workflow.kind.root"), {
                x: (40 - draft.view.x) / draft.view.zoom,
                y: (120 - draft.view.y) / draft.view.zoom,
              })
            }
          >
            {language.t("workflow.template.addRoot")}
          </ButtonV2>
          <ButtonV2 variant="neutral" size="normal" disabled={draft.saving} onClick={() => void save()}>
            {draft.saving ? language.t("workflow.template.saving") : language.t("workflow.template.save")}
          </ButtonV2>
          <ButtonV2 variant="ghost-muted" size="normal" onClick={() => navigate("/workflow")}>
            {language.t("workflow.home.eyebrow")}
          </ButtonV2>
        </div>
      </header>
      <div class="h-full min-h-0 min-w-0 overflow-hidden">
        <Show when={template.loading}>
          <p class="px-5 py-6 text-sm text-v2-text-text-muted">{language.t("workflow.run.loading")}</p>
        </Show>
        <Show when={template.error}>
          <p class="m-5 rounded-lg border border-icon-critical-base/30 bg-icon-critical-base/10 p-4 text-sm">{language.t("workflow.template.unavailable")}</p>
        </Show>
        <Show when={draft.invalid}>
          <p class="mx-5 mt-4 rounded-lg border border-icon-critical-base/30 bg-icon-critical-base/10 p-4 text-sm">{language.t("workflow.template.invalid")}</p>
        </Show>
        <Show when={template()}>
          <div class="grid size-full min-h-0 min-w-0 grid-cols-1 overflow-hidden lg:grid-cols-[7fr_3fr]">
          <div class="relative h-full min-h-0 min-w-0 overflow-hidden">
          <div
            ref={viewport}
            class="h-full cursor-default overflow-hidden"
            classList={{ "cursor-grabbing": draft.gesture?.type === "pan" || draft.gesture?.type === "node" }}
            style={{
              "background-image": "radial-gradient(circle, var(--color-v2-border-border-weak, #3a3a3a) 1px, transparent 1px)",
              "background-size": `${24 * draft.view.zoom}px ${24 * draft.view.zoom}px`,
              "background-position": `${draft.view.x}px ${draft.view.y}px`,
            }}
            onWheel={(event) => {
              event.preventDefault()
              if (!viewport) return
              const next = Math.min(2.5, Math.max(0.25, draft.view.zoom * (event.deltaY < 0 ? 1.08 : 1 / 1.08)))
              const box = viewport.getBoundingClientRect()
              const x = event.clientX - box.left
              const y = event.clientY - box.top
              setDraft("view", {
                zoom: next,
                x: x - ((x - draft.view.x) / draft.view.zoom) * next,
                y: y - ((y - draft.view.y) / draft.view.zoom) * next,
              })
            }}
            onPointerDown={(event) => {
              if ((event.target as HTMLElement).closest("article, aside, [data-workflow-port], textarea, path")) return
              setDraft("menu", undefined)
              if (event.button === 1) {
                event.preventDefault()
                setDraft("gesture", { type: "pan", x: event.clientX - draft.view.x, y: event.clientY - draft.view.y })
                return
              }
              if (event.button !== 0) return
              event.preventDefault()
              const point = worldPoint(event.currentTarget, draft.view, event)
              setDraft("gesture", { type: "box", x0: point.x, y0: point.y, x1: point.x, y1: point.y })
              if (!event.ctrlKey && !event.metaKey) setDraft("selected", [])
            }}
            onContextMenu={(event) => {
              event.preventDefault()
              const node = (event.target as HTMLElement).closest("[data-workflow-node]")
              const nodeID = node?.getAttribute("data-workflow-node") ?? undefined
              if (nodeID && !draft.selected.includes(nodeID)) setDraft("selected", [nodeID])
              setDraft("menu", { x: event.clientX, y: event.clientY, nodeID })
            }}
          >
            <div
              class="absolute left-0 top-0 origin-top-left"
              style={{
                transform: `translate(${draft.view.x}px, ${draft.view.y}px) scale(${draft.view.zoom})`,
              }}
            >
              <svg class="pointer-events-none absolute overflow-visible" width="8000" height="8000">
                <For each={draft.edges}>
                  {(edge) => {
                    const source = () => draft.nodes.find((node) => node.id === edge.sourceNodeID)
                    const target = () => draft.nodes.find((node) => node.id === edge.targetNodeID)
                    const path = () =>
                      source() && target()
                        ? wirePath(portX(source()!, edge.sourcePort as Port), portY(source()!, edge.sourcePort as Port), portX(target()!, edge.targetPort as Port), portY(target()!, edge.targetPort as Port))
                        : ""
                    return (
                      <Show when={source() && target()}>
                        <path
                          class="pointer-events-auto cursor-pointer fill-none stroke-transparent"
                          stroke-width="16"
                          d={path()}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation()
                            setDraft("edges", draft.edges.filter((item) => item.id !== edge.id))
                          }}
                          onContextMenu={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            setDraft("edges", draft.edges.filter((item) => item.id !== edge.id))
                          }}
                        >
                          <title>{language.t("workflow.template.deleteEdge")}</title>
                        </path>
                        <path
                          class="pointer-events-none fill-none stroke-v2-icon-icon-accent"
                          stroke-width="2"
                          stroke-dasharray={edge.sourcePort === "message" ? "6 4" : undefined}
                          d={path()}
                        />
                      </Show>
                    )
                  }}
                </For>
                <Show when={draft.gesture?.type === "link" ? draft.gesture : undefined}>
                  {(link) => {
                    const source = () => draft.nodes.find((node) => node.id === link().nodeID)
                    return (
                      <Show when={source()}>
                        <path
                          class="fill-none stroke-v2-icon-icon-accent"
                          stroke-width="2"
                          d={wirePath(portX(source()!, link().port), portY(source()!, link().port), link().x, link().y)}
                        />
                      </Show>
                    )
                  }}
                </Show>
              </svg>
              <For each={draft.nodes}>
                {(node, index) => (
                  <article
                    data-workflow-node={node.id}
                    class="absolute flex flex-col border bg-v2-background-bg-layer-02 shadow-sm"
                    classList={{ "ring-2 ring-v2-icon-icon-accent": draft.selected.includes(node.id) }}
                    style={{
                      left: `${node.display.x}px`,
                      top: `${node.display.y}px`,
                      width: `${nodeSize(node.kind).w}px`,
                      height: `${nodeSize(node).h}px`,
                      "border-color": nodeChrome(node.kind).border,
                      "border-radius": nodeChrome(node.kind).radius,
                    }}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return
                      if ((event.target as HTMLElement).closest("[data-workflow-port],textarea")) return
                      event.stopPropagation()
                      setDraft("menu", undefined)
                      const additive = event.ctrlKey || event.metaKey
                      const selected = additive
                        ? draft.selected.includes(node.id)
                          ? draft.selected
                          : [...draft.selected, node.id]
                        : draft.selected.includes(node.id)
                          ? draft.selected
                          : [node.id]
                      setDraft("selected", selected)
                      if (!viewport) return
                      event.preventDefault()
                      event.currentTarget.setPointerCapture(event.pointerId)
                      const point = worldPoint(viewport, draft.view, event)
                      setDraft("gesture", {
                        type: "node",
                        ids: selected,
                        origin: point,
                        start: Object.fromEntries(draft.nodes.filter((item) => selected.includes(item.id)).map((item) => [item.id, { ...item.display }])),
                      })
                    }}
                  >
                    <div
                      class="flex items-center justify-between gap-2 border-b px-3"
                      classList={{ "h-12 rounded-t-[inherit]": node.kind !== "root", "h-full rounded-[inherit] py-2": node.kind === "root" }}
                      style={{ "background-color": nodeChrome(node.kind).header, "border-color": nodeChrome(node.kind).border }}
                    >
                      <div class="pointer-events-none min-w-0">
                        <div class="text-[10px] font-[560] uppercase tracking-[0.12em] text-v2-text-text-muted">{language.t(`workflow.kind.${node.kind}`)}</div>
                        <div class="truncate text-sm font-semibold text-v2-text-text-strong">{node.title}</div>
                      </div>
                      <span class="pointer-events-none max-w-[48%] truncate text-right text-[10px] leading-4 text-v2-text-text-muted">{language.t(nodeDescription(node.kind))}</span>
                    </div>
                    <Show when={node.kind !== "root"}>
                      <div class="flex min-h-0 flex-1 flex-col gap-2 px-3 py-3">
                        <div class="h-5 grid grid-cols-[1fr_1fr] gap-2 text-[9px] font-semibold uppercase tracking-[0.14em] text-v2-text-text-muted">
                          <span>{language.t("workflow.template.inputPort")}</span>
                          <span class="text-right">{language.t("workflow.template.outputPort")}</span>
                        </div>
                        <div class="flex flex-col gap-1">
                          <For each={portRows(node)}>
                            {(row, rowIndex) => <div class="grid min-h-7 grid-cols-[1fr_1fr] gap-2">
                              <Show when={nodeFlag(node, "showInputs") && row.input}>
                                <div class="relative flex items-center rounded-md bg-v2-background-bg-base px-2 text-[10px] text-v2-text-text-muted"><PortButton side="input" class="absolute -left-5" style={{ top: "50%" }} active={draft.gesture?.type === "link" && draft.gesture.nodeID === node.id && draft.gesture.port === row.input} label={portLabel(row.input ?? "", language)} details={`${language.t("workflow.template.tooltip.input")}\n${portLabel(row.input ?? "", language)}\n${node.inputs[row.input!]?.mode ?? "dependency"}\n${node.inputs[row.input!]?.handoffTypes.join(", ") ?? "generic_document"}`} nodeID={node.id} port={row.input ?? ""} onLink={(name, point) => setDraft("gesture", { type: "link", nodeID: node.id, port: name, x: point.x, y: point.y })} viewport={() => viewport} view={() => draft.view} /><span class="truncate">{portLabel(row.input ?? "", language)}</span></div>
                              </Show>
                              <Show when={row.input?.startsWith("prompt") && nodeFlag(node, "showPrompt")}>
                                <div class="absolute left-1 top-8 w-36 space-y-1"><input class="w-full rounded border border-v2-border-border-weak bg-v2-background-bg-base px-1 py-1 text-[10px] text-v2-text-text-strong" value={promptTexts(node)[row.input!] ?? ""} placeholder={language.t("workflow.template.extraPrompt")} onPointerDown={(event) => event.stopPropagation()} onInput={(event) => updatePromptText(draft, setDraft, index(), row.input!, event.currentTarget.value)} /><input class="w-full rounded border border-v2-border-border-weak bg-v2-background-bg-base px-1 py-1 text-[10px] text-v2-text-text-strong" value={promptFiles(node)[row.input!] ?? ""} placeholder={language.t("workflow.template.promptFilePlaceholder")} onPointerDown={(event) => event.stopPropagation()} onInput={(event) => setPromptFile(draft, setDraft, index(), row.input!, event.currentTarget.value)} /></div>
                              </Show>
                              <Show when={nodeFlag(node, "showOutputs") && row.output}>
                                <div class="relative flex items-center justify-end rounded-md bg-v2-background-bg-base px-2 text-[10px] text-v2-text-text-muted"><span class="mr-1 truncate">{portLabel(row.output ?? "", language)}</span><PortButton side="output" class="absolute -right-5" style={{ top: "50%" }} active={draft.gesture?.type === "link" && draft.gesture.nodeID === node.id && draft.gesture.port === row.output} label={portLabel(row.output ?? "", language)} details={`${language.t("workflow.template.tooltip.output")}\n${portLabel(row.output ?? "", language)}\n${node.outputs[row.output!]?.mode ?? "artifact"}\n${node.outputs[row.output!]?.handoffType ?? "generic_document"}`} nodeID={node.id} port={row.output ?? ""} onLink={(name, point) => setDraft("gesture", { type: "link", nodeID: node.id, port: name, x: point.x, y: point.y })} viewport={() => viewport} view={() => draft.view} /></div>
                              </Show>
                            </div>}
                          </For>
                        </div>
                        <div class="grid grid-cols-[1fr_1fr] gap-2 border-y border-v2-border-border-weak/60 py-2 text-[10px] text-v2-text-text-muted">
                          <span>{language.t("workflow.template.portData")}</span>
                          <span class="text-right">{language.t("workflow.template.portData")}</span>
                        </div>
                        <div class="grid min-h-0 flex-1 grid-cols-[1fr_1fr] gap-2">
                          <div class="text-[10px] text-v2-text-text-muted">{language.t("workflow.template.connectedData")}</div>
                          <div class="text-right text-[10px] text-v2-text-text-muted">{language.t("workflow.template.connectedData")}</div>
                        </div>
                        <div class="flex flex-col gap-2 border-t border-v2-border-border-weak/60 pt-2">
                          <Show when={nodeFlag(node, "showWorkspace")}><label class="text-[10px] text-v2-text-text-muted">{language.t("workflow.template.directory")}<input class="mt-1 w-full rounded-md border border-v2-border-border-weak bg-v2-background-bg-base px-2 py-1.5 text-[10px] text-v2-text-text-strong outline-none" value={node.workspace?.directory ?? ""} placeholder={language.t("workflow.template.noDirectory")} aria-label={language.t("workflow.template.directory")} onPointerDown={(event) => event.stopPropagation()} onInput={(event) => setDraft("nodes", index(), "workspace", { mode: node.workspace?.mode ?? "write", directory: event.currentTarget.value || undefined })} /></label></Show>
                          <textarea class="min-h-16 resize-none rounded-md border border-v2-border-border-weak bg-v2-background-bg-base px-2.5 py-2 text-xs leading-5 text-v2-text-text-strong outline-none" value={node.objective} placeholder={language.t("workflow.template.notes")} aria-label={language.t("workflow.template.notes")} onPointerDown={(event) => event.stopPropagation()} onInput={(event) => setDraft("nodes", index(), "objective", event.currentTarget.value)} />
                        </div>
                      </div>
                    </Show>
                  </article>
                )}
              </For>
              <Show when={draft.gesture?.type === "box" ? draft.gesture : undefined}>
                {(box) => (
                  <div
                    class="pointer-events-none absolute border border-v2-icon-icon-accent bg-v2-icon-icon-accent/10"
                    style={{
                      left: `${Math.min(box().x0, box().x1)}px`,
                      top: `${Math.min(box().y0, box().y1)}px`,
                      width: `${Math.abs(box().x1 - box().x0)}px`,
                      height: `${Math.abs(box().y1 - box().y0)}px`,
                    }}
                  />
                )}
              </Show>
            </div>
          </div>
          <p class="pointer-events-none absolute bottom-4 left-5 text-xs text-v2-text-text-muted">{language.t("workflow.template.canvasHint")}</p>
          <Show when={draft.menu}>
            {(menu) => (
              <div
                class="fixed z-50 min-w-40 rounded-lg border border-v2-border-border-weak bg-v2-background-bg-layer-02 py-1 shadow-sm"
                style={{ left: `${menu().x}px`, top: `${menu().y}px` }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <Show when={menu().nodeID}>
                  {(nodeID) => {
                    const node = () => draft.nodes.find((item) => item.id === nodeID())
                    return (
                      <>
                        <Show when={node()?.kind !== "root"}>
                          <button
                            type="button"
                            class="block w-full px-3 py-1.5 text-left text-sm text-v2-text-text-strong hover:bg-v2-background-bg-layer-03"
                            onClick={() => {
                              toggleNodeFlag(draft, setDraft, nodeID(), "showInputs")
                              setDraft("menu", undefined)
                            }}
                          >
                            {nodeFlag(node(), "showInputs")
                              ? language.t("workflow.template.hideInputs")
                              : language.t("workflow.template.showInputs")}
                          </button>
                          <button type="button" class="block w-full px-3 py-1.5 text-left text-sm text-v2-text-text-strong hover:bg-v2-background-bg-layer-03" onClick={() => { toggleNodeFlag(draft, setDraft, nodeID(), "showWorkspace"); setDraft("menu", undefined) }}>
                            {nodeFlag(node(), "showWorkspace") ? language.t("workflow.template.hideWorkspace") : language.t("workflow.template.showWorkspace")}
                          </button>
                          <button type="button" class="block w-full px-3 py-1.5 text-left text-sm text-v2-text-text-strong hover:bg-v2-background-bg-layer-03" onClick={() => { toggleNodeFlag(draft, setDraft, nodeID(), "showPrompt"); setDraft("menu", undefined) }}>
                            {nodeFlag(node(), "showPrompt") ? language.t("workflow.template.hidePrompt") : language.t("workflow.template.showPrompt")}
                          </button>
                          <button type="button" class="block w-full px-3 py-1.5 text-left text-sm text-v2-text-text-strong hover:bg-v2-background-bg-layer-03" onClick={() => { addPrompt(draft, setDraft, draft.nodes.findIndex((item) => item.id === nodeID())); setDraft("menu", undefined) }}>
                            {language.t("workflow.template.addPrompt")}
                          </button>
                          <button type="button" class="block w-full px-3 py-1.5 text-left text-sm text-v2-text-text-strong hover:bg-v2-background-bg-layer-03" onClick={() => { addGraphPort(draft, setDraft, draft.nodes.findIndex((item) => item.id === nodeID()), "inputs"); setDraft("menu", undefined) }}>
                            {language.t("workflow.template.addInput")}
                          </button>
                          <button type="button" class="block w-full px-3 py-1.5 text-left text-sm text-v2-text-text-strong hover:bg-v2-background-bg-layer-03" onClick={() => { addGraphPort(draft, setDraft, draft.nodes.findIndex((item) => item.id === nodeID()), "outputs"); setDraft("menu", undefined) }}>
                            {language.t("workflow.template.addOutput")}
                          </button>
                          <button
                            type="button"
                            class="block w-full px-3 py-1.5 text-left text-sm text-v2-text-text-strong hover:bg-v2-background-bg-layer-03"
                            onClick={() => {
                              toggleNodeFlag(draft, setDraft, nodeID(), "showOutputs")
                              setDraft("menu", undefined)
                            }}
                          >
                            {nodeFlag(node(), "showOutputs")
                              ? language.t("workflow.template.hideOutputs")
                              : language.t("workflow.template.showOutputs")}
                          </button>
                        </Show>
                        <button
                          type="button"
                          class="block w-full px-3 py-1.5 text-left text-sm text-v2-text-text-strong hover:bg-v2-background-bg-layer-03"
                          onClick={() => {
                            removeNodes(draft, setDraft, draft.selected.length ? draft.selected : [nodeID()])
                            setDraft("menu", undefined)
                          }}
                        >
                          {language.t("workflow.template.deleteNode")}
                        </button>
                      </>
                    )
                  }}
                </Show>
                <button
                  type="button"
                  class="block w-full px-3 py-1.5 text-left text-sm text-v2-text-text-strong hover:bg-v2-background-bg-layer-03"
                  onClick={() => {
                    if (!viewport) return
                    const point = worldPoint(viewport, draft.view, { clientX: menu().x, clientY: menu().y })
                    addNode(draft, setDraft, directory(), language.t("workflow.template.nodeTitle"), point)
                    setDraft("menu", undefined)
                  }}
                >
                  {language.t("workflow.template.addNode")}
                </button>
                <button
                  type="button"
                  class="block w-full px-3 py-1.5 text-left text-sm text-v2-text-text-strong hover:bg-v2-background-bg-layer-03"
                  onClick={() => {
                    if (!viewport) return
                    const point = worldPoint(viewport, draft.view, { clientX: menu().x, clientY: menu().y })
                    addRoot(draft, setDraft, language.t("workflow.kind.root"), point)
                    setDraft("menu", undefined)
                  }}
                >
                  {language.t("workflow.template.addRoot")}
                </button>
              </div>
            )}
          </Show>
          </div>
          <aside
            class="min-h-0 min-w-0 overflow-y-auto border-t border-v2-border-border-weak bg-v2-background-bg-layer-02 p-4 shadow-sm lg:border-l lg:border-t-0"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Show when={selected()}>
              {(node) => (
                <>
                <label class="block text-xs text-v2-text-text-muted">{language.t("workflow.template.kind")}
                  <select
                    class="mt-1 w-full rounded-lg border border-v2-border-border-weak bg-v2-background-bg-base px-2 py-1.5 text-sm text-v2-text-text-strong"
                    value={node().kind}
                    onChange={(event) => setDraft("nodes", selectedIndex(), "kind", event.currentTarget.value as Node["kind"])}
                  >
                    <For each={node().kind === "root" ? (["root"] as const) : (["task", "research", "implement", "review", "test", "approval"] as const)}>
                      {(kind) => <option value={kind}>{language.t(`workflow.kind.${kind}`)}</option>}
                    </For>
                  </select>
                </label>
                <label class="mt-3 block text-xs text-v2-text-text-muted">{language.t("workflow.template.alias")}
                  <input
                    class="mt-1 w-full rounded-lg border border-v2-border-border-weak bg-v2-background-bg-base px-2 py-1.5 text-sm text-v2-text-text-strong outline-none"
                    value={node().title}
                    onInput={(event) => setDraft("nodes", selectedIndex(), "title", event.currentTarget.value)}
                  />
                </label>
                <Show when={node().kind !== "root"}>
                <label class="mt-3 block text-xs text-v2-text-text-muted">{language.t("workflow.template.notes")}
                  <textarea
                    class="mt-1 h-20 w-full resize-none rounded-lg border border-v2-border-border-weak bg-v2-background-bg-base px-2 py-1.5 text-sm text-v2-text-text-strong outline-none"
                    value={node().objective}
                    onInput={(event) => setDraft("nodes", selectedIndex(), "objective", event.currentTarget.value)}
                  />
                </label>
                </Show>
                <Show when={node().kind !== "root"}>
                <label class="mt-3 block text-xs text-v2-text-text-muted">{language.t("workflow.template.agent")}
                  <select
                    class="mt-1 w-full rounded-lg border border-v2-border-border-weak bg-v2-background-bg-base px-2 py-1.5 text-sm text-v2-text-text-strong"
                    value={node().agentProfileID ?? ""}
                    onChange={(event) => setDraft("nodes", selectedIndex(), "agentProfileID", event.currentTarget.value || undefined)}
                  >
                    <option value="">{language.t("workflow.run.defaultModel")}</option>
                    <For each={agents() ?? []}>
                      {(agent) => <option value={agent.id}>{agent.id}{agent.mode === "subagent" ? " (subagent)" : ""}</option>}
                    </For>
                  </select>
                </label>
                <label class="mt-3 block text-xs text-v2-text-text-muted">{language.t("workflow.template.model")}
                  <select
                    class="mt-1 w-full rounded-lg border border-v2-border-border-weak bg-v2-background-bg-base px-2 py-1.5 text-sm text-v2-text-text-strong"
                    value={[node().model?.providerID, node().model?.id].filter(Boolean).join("/")}
                    onChange={(event) => setDraft("nodes", selectedIndex(), "model", parseModel(event.currentTarget.value))}
                  >
                    <option value="">
                      {defaultModel()
                        ? language.t("workflow.run.defaultModelNamed", { model: defaultModel() ?? "" })
                        : language.t("workflow.run.defaultModel")}
                    </option>
                    <Show when={node().model && !models().some((model) => model.key === `${node().model?.providerID}/${node().model?.id}`)}>
                      <option value={`${node().model?.providerID}/${node().model?.id}`}>
                        {`${node().model?.providerID}/${node().model?.id}`}
                      </option>
                    </Show>
                    <For each={models()}>
                      {(model) => <option value={model.key}>{model.label}</option>}
                    </For>
                  </select>
                </label>
                <label class="mt-3 block text-xs text-v2-text-text-muted">{language.t("workflow.template.directory")}
                  <select
                    class="mt-1 w-full rounded-lg border border-v2-border-border-weak bg-v2-background-bg-base px-2 py-1.5 text-sm text-v2-text-text-strong"
                    value={node().workspace?.directory ?? ""}
                    onChange={(event) =>
                      setDraft("nodes", selectedIndex(), "workspace", {
                        mode: node().workspace?.mode ?? "write",
                        directory: event.currentTarget.value || undefined,
                      })
                    }
                  >
                    <option value="">{language.t("workflow.run.noDirectory")}</option>
                    <Show when={node().workspace?.directory && !workspaces().some((item) => item.directory === node().workspace?.directory)}>
                      <option value={node().workspace?.directory}>{node().workspace?.directory}</option>
                    </Show>
                    <For each={workspaces()}>
                      {(item) => <option value={item.directory}>{item.label}</option>}
                    </For>
                  </select>
                </label>
                <label class="mt-3 block text-xs text-v2-text-text-muted">{language.t("workflow.template.nodePrompt")}
                  <input
                    class="mt-1 w-full rounded-lg border border-v2-border-border-weak bg-v2-background-bg-base px-2 py-1.5 text-sm text-v2-text-text-strong outline-none"
                    value={node().promptFile ?? ""}
                    placeholder={language.t("workflow.template.promptPlaceholder")}
                    onInput={(event) => setDraft("nodes", selectedIndex(), "promptFile", event.currentTarget.value || undefined)}
                  />
                </label>
                <fieldset class="mt-3">
                  <legend class="text-xs text-v2-text-text-muted">{language.t("workflow.template.tools")}</legend>
                  <p class="mt-1 text-[10px] text-v2-text-text-muted">
                    {nodeTools(node()).length === 0
                      ? language.t("workflow.template.toolsAll")
                      : language.t("workflow.template.toolsSelected", { count: nodeTools(node()).length })}
                  </p>
                  <div class="mt-1 max-h-40 overflow-auto rounded-lg border border-v2-border-border-weak bg-v2-background-bg-base px-2 py-1">
                    <For each={toolIds() ?? []}>
                      {(name) => (
                        <label class="flex items-center gap-2 py-0.5 text-sm text-v2-text-text-strong">
                          <input
                            type="checkbox"
                            checked={nodeTools(node()).includes(name)}
                            onChange={() => {
                              const current = nodeTools(node())
                              const tools = current.includes(name)
                                ? current.filter((item) => item !== name)
                                : [...current, name]
                              setDraft("nodes", selectedIndex(), "config", {
                                ...node().config,
                                tools: tools.length > 0 ? tools : undefined,
                              })
                            }}
                          />
                          {name}
                        </label>
                      )}
                    </For>
                  </div>
                </fieldset>
                </Show>
                <ButtonV2
                  class="mt-4"
                  variant="ghost-muted"
                  size="small"
                  onClick={() => {
                    setDraft("nodes", draft.nodes.filter((item) => item.id !== node().id))
                    setDraft("edges", draft.edges.filter((edge) => edge.sourceNodeID !== node().id && edge.targetNodeID !== node().id))
                    setDraft("selected", [])
                  }}
                >
                  {language.t("workflow.template.deleteNode")}
                </ButtonV2>
                </>
              )}
            </Show>
          </aside>
          </div>
        </Show>
      </div>
    </main>
  )
}

function parseModel(value: string) {
  const trimmed = value.trim()
  const index = trimmed.indexOf("/")
  if (index <= 0 || index === trimmed.length - 1) return
  return { providerID: Provider.ID.make(trimmed.slice(0, index)), id: Model.ID.make(trimmed.slice(index + 1)) }
}

function PortButton(props: {
  class: string
  side: "input" | "output"
  style?: Record<string, string>
  active: boolean
  label: string
  details: string
  nodeID: string
  port: Port
  onLink: (port: Port, point: { x: number; y: number }) => void
  viewport: () => HTMLDivElement | undefined
  view: () => { x: number; y: number; zoom: number }
}) {
  return (
    <button
      type="button"
      data-workflow-port="true"
      data-node={props.nodeID}
      data-port={props.port}
      class={`${props.class} group z-20 flex size-5 -translate-y-1/2 items-center rounded-full border-2 border-white/90 shadow-[0_0_0_1px_rgba(0,0,0,0.35),0_1px_4px_rgba(0,0,0,0.55)]`}
      style={props.style}
      classList={{ "bg-v2-icon-icon-accent": props.active, "bg-[#6ca9e6]": !props.active }}
      aria-label={props.label}
      title={props.details}
      onPointerDown={(event) => {
        event.stopPropagation()
        event.preventDefault()
        const viewport = props.viewport()
        if (!viewport) return
        props.onLink(props.port, worldPoint(viewport, props.view(), event))
      }}
    >
      <span class={`pointer-events-none absolute bottom-5 z-30 hidden w-44 whitespace-pre-line rounded-lg border border-v2-border-border-weak bg-v2-background-bg-layer-03 px-2.5 py-2 text-left text-[10px] leading-4 text-v2-text-text-strong shadow-lg group-hover:block ${props.side === "input" ? "left-0" : "right-0"}`}>
        {props.details}
      </span>
    </button>
  )
}

function PortEditor(props: {
  title: string
  ports: Node["inputs"] | Node["outputs"]
  onAdd: () => void
  onRemove: (name: string) => void
}) {
  return (
    <fieldset class="mt-3">
      <legend class="text-xs text-v2-text-text-muted">{props.title}</legend>
      <div class="mt-1 space-y-1">
        <For each={Object.keys(props.ports)}>
          {(name) => (
            <div class="flex items-center justify-between gap-2 rounded-md border border-v2-border-border-weak px-2 py-1 text-xs text-v2-text-text-strong">
              <span class="truncate">{name}</span>
              <button type="button" class="text-v2-text-text-muted hover:text-icon-critical-base" onClick={() => props.onRemove(name)}>
                x
              </button>
            </div>
          )}
        </For>
        <button type="button" class="w-full rounded-md border border-dashed border-v2-border-border-weak px-2 py-1 text-xs text-v2-text-text-muted hover:text-v2-text-text-strong" onClick={props.onAdd}>
          +
        </button>
      </div>
    </fieldset>
  )
}

function updatePorts(
  draft: { nodes: Node[] },
  setDraft: (key: "nodes", value: Node[]) => void,
  index: number,
  side: "inputs" | "outputs",
  name: string,
) {
  const node = draft.nodes[index]
  if (!node || name in node[side]) return
  const ports = side === "inputs"
    ? { handoffTypes: ["generic_document"] as const, required: false, many: true, mode: "dependency" as const }
    : { handoffType: "generic_document" as const, many: true, mode: "artifact" as const }
  setDraft("nodes", draft.nodes.map((item, itemIndex) => itemIndex === index ? { ...item, [side]: { ...item[side], [name]: ports } } : item))
}

function addGraphPort(
  draft: { nodes: Node[] },
  setDraft: (key: "nodes", value: Node[]) => void,
  index: number,
  side: "inputs" | "outputs",
) {
  const node = draft.nodes[index]
  if (!node) return
  const name = `${side === "inputs" ? "input" : "output"}${Object.keys(node[side]).length + 1}`
  updatePorts(draft, setDraft, index, side, name)
}

function removePort(
  draft: { nodes: Node[]; edges: Edge[] },
  setDraft: (key: "nodes" | "edges", value: Node[] | Edge[]) => void,
  index: number,
  nodeID: string,
  side: "inputs" | "outputs",
  name: string,
) {
  const node = draft.nodes[index]
  if (!node) return
  const ports = Object.fromEntries(Object.entries(node[side]).filter(([key]) => key !== name))
  setDraft("nodes", draft.nodes.map((item, itemIndex) => itemIndex === index ? { ...item, [side]: ports } : item))
  setDraft("edges", draft.edges.filter((edge) => !(side === "inputs" ? edge.targetNodeID === nodeID && edge.targetPort === name : edge.sourceNodeID === nodeID && edge.sourcePort === name)))
}

function removeNodes(
  draft: { nodes: Node[]; edges: Edge[] },
  setDraft: (key: "nodes" | "edges" | "selected", value: Node[] | Edge[] | string[]) => void,
  ids: string[],
) {
  if (ids.length === 0) return
  setDraft("nodes", draft.nodes.filter((node) => !ids.includes(node.id)))
  setDraft("edges", draft.edges.filter((edge) => !ids.includes(edge.sourceNodeID) && !ids.includes(edge.targetNodeID)))
  setDraft("selected", [])
}

function addRoot(
  draft: { nodes: Node[] },
  setDraft: (key: "nodes", value: Node[]) => void,
  title: string,
  display: { x: number; y: number },
) {
  setDraft("nodes", [
    ...draft.nodes,
    withPorts({
      id: `root-${crypto.randomUUID()}`,
      kind: "root",
      title,
      objective: "",
      inputs: {},
      outputs: {},
      workspace: { mode: "none" },
      config: {},
      display,
    }),
  ])
}

function addNode(
  draft: { nodes: Node[] },
  setDraft: (key: "nodes", value: Node[]) => void,
  directory: string | undefined,
  title: string,
  display: { x: number; y: number },
) {
  setDraft("nodes", [
    ...draft.nodes,
    withPorts({
      id: `node-${crypto.randomUUID()}`,
      kind: "task",
      title,
      objective: "",
      inputs: {},
      outputs: {},
      workspace: { mode: "write", directory },
      config: {},
      display,
    }),
  ])
}

function connectPorts(
  draft: { nodes: Node[]; edges: Edge[] },
  setDraft: (key: "edges", value: Edge[]) => void,
  fromNode: string,
  fromPort: Port,
  toNode: string,
  toPort: Port,
) {
  if (!toNode || !toPort || fromNode === toNode) return
  const fromNodeData = draft.nodes.find((node) => node.id === fromNode)
  const toNodeData = draft.nodes.find((node) => node.id === toNode)
  if (!fromNodeData || !toNodeData) return
  const fromOutput = Boolean(fromNodeData.outputs[fromPort])
  const toInput = Boolean(toNodeData.inputs[toPort])
  const reverseOutput = Boolean(toNodeData.outputs[toPort])
  const reverseInput = Boolean(fromNodeData.inputs[fromPort])
  if (!fromOutput && !reverseOutput) return
  if (fromOutput && !toInput) return
  if (reverseOutput && !reverseInput) return
  const sourceNodeID = fromOutput ? fromNode : toNode
  const sourcePort = fromOutput ? fromPort : toPort
  const targetNodeID = fromOutput ? toNode : fromNode
  const targetPort = fromOutput ? toPort : fromPort
  if (!draft.nodes.find((node) => node.id === targetNodeID)?.inputs[targetPort]?.many && draft.edges.some((edge) => edge.targetNodeID === targetNodeID && edge.targetPort === targetPort)) return
  if (draft.edges.some((edge) => edge.sourceNodeID === sourceNodeID && edge.sourcePort === sourcePort && edge.targetNodeID === targetNodeID && edge.targetPort === targetPort)) return
  setDraft("edges", [
    ...draft.edges,
    {
      id: `edge-${crypto.randomUUID()}`,
      sourceNodeID,
      sourcePort,
      targetNodeID,
      targetPort,
      condition: sourcePort === "result" ? "success" : undefined,
    },
  ])
}

function withPorts(node: Node): Node {
  if (node.kind === "root") {
    return {
      ...node,
      workspace: { mode: "none" },
      inputs: {},
      outputs: {
        result: { handoffType: "task_spec", many: true, mode: "artifact" },
      },
    }
  }
  return {
    ...node,
    workspace: node.workspace ?? { mode: "write" },
    inputs: {
      context: { handoffTypes: ["task_spec", "summary", "research", "plan", "patch", "generic_document"], required: false, many: false, mode: "dependency" },
      inbox: { handoffTypes: ["generic_document"], required: false, many: true, mode: "queue" },
      ...node.inputs,
    },
    outputs: {
      result: { handoffType: "summary", many: false, mode: "artifact" },
      message: { handoffType: "generic_document", many: true, mode: "message" },
      ...node.outputs,
    },
  }
}

function worldPoint(viewport: HTMLElement, view: { x: number; y: number; zoom: number }, event: { clientX: number; clientY: number }) {
  const box = viewport.getBoundingClientRect()
  return {
    x: (event.clientX - box.left - view.x) / view.zoom,
    y: (event.clientY - box.top - view.y) / view.zoom,
  }
}

function fitCanvas(
  nodes: Node[],
  viewport: HTMLDivElement | undefined,
  setDraft: (key: "view", value: { x: number; y: number; zoom: number }) => void,
) {
  if (!viewport || nodes.length === 0) return
  const bounds = nodes.reduce(
    (result, node) => ({
      left: Math.min(result.left, node.display.x),
      top: Math.min(result.top, node.display.y),
      right: Math.max(result.right, node.display.x + nodeSize(node).w),
      bottom: Math.max(result.bottom, node.display.y + nodeSize(node).h),
    }),
    { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
  )
  const padding = 64
  const zoom = Math.min(
    1,
    Math.max(0.5, Math.min(
      (viewport.clientWidth - padding * 2) / (bounds.right - bounds.left),
      (viewport.clientHeight - padding * 2) / (bounds.bottom - bounds.top),
    )),
  )
  setDraft("view", {
    x: (viewport.clientWidth - (bounds.left + bounds.right) * zoom) / 2,
    y: (viewport.clientHeight - (bounds.top + bounds.bottom) * zoom) / 2,
    zoom,
  })
}

function wirePath(x1: number, y1: number, x2: number, y2: number) {
  const dx = Math.max(48, Math.abs(x2 - x1) * 0.5)
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}

function portX(node: Node, port: Port) {
  return node.inputs[port] ? node.display.x - 10 : node.display.x + nodeSize(node).w + 10
}

function portY(node: Node, port: Port) {
  const size = nodeSize(node)
  if (node.kind === "root") return node.display.y + size.h / 2
  const inputIndex = Object.keys(node.inputs).indexOf(port)
  if (inputIndex >= 0) return node.display.y + portTop(node, "input", inputIndex)
  const outputIndex = Object.keys(node.outputs).indexOf(port)
  if (outputIndex >= 0) return node.display.y + portTop(node, "output", outputIndex)
  return node.display.y + size.h / 2
}

function portTop(node: Node, side: "input" | "output", index: number) {
  if (node.kind === "root") return nodeSize(node.kind).h / 2
  return NODE_HEADER_H + 12 + PORT_HEADING_H + PORT_SECTION_GAP + index * (PORT_ROW_H + PORT_ROW_GAP) + PORT_ROW_H / 2
}

async function loadTemplate(server: ReturnType<typeof useServerSDK>, templateID: string) {
  return (await workflowClient(server).template.get({ templateID })).data.data
}

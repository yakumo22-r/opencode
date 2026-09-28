import { getFilename } from "@opencode-ai/core/util/path"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { DialogBody, DialogHeader, DialogTitle, DialogV2 } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useNavigate } from "@solidjs/router"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { ServerConnection } from "@/context/server"
import { tabKey, useTabs } from "@/context/tabs"
import { authTokenFromCredentials } from "@/utils/server"
import { sessionHref } from "@/utils/session-route"

type Member = { sessionID: string; directory: string; title: string; duty: string; admin: boolean }
type Item = { id: string; title: string; prompt: string; status: "pending" | "done" | "error"; result?: string }
type Team = {
  id: string
  title: string
  adminSessionID: string
  systemDirectory: string
  context: string
  members: Member[]
  condition: { type: "all" } | { type: "any" } | { type: "count"; count: number }
  mode: "auto" | "manual"
  items: Item[]
  createdAt?: number
  updatedAt?: number
  note?: string
  archived?: boolean
}
type Structure = {
  id: string
  name: string
  title: string
  note?: string
  context: string
  condition: Team["condition"]
  mode: Team["mode"]
  duties: string[]
}
type Result = { team?: Team; teams?: Team[]; structures?: Structure[]; error?: string; shouldWake?: boolean; ready?: boolean; text?: string }

export function DialogCoordination(props: { sessionID?: string }) {
  const tabs = useTabs()
  const global = useGlobal()
  const language = useLanguage()
  const navigate = useNavigate()
  const dialog = useDialog()
  const [result, setResult] = createSignal<Result>()
  const [selectedID, setSelectedID] = createSignal<string>()
  const [title, setTitle] = createSignal("AI Agent cooperation")
  const [joinID, setJoinID] = createSignal("")
  const [count, setCount] = createSignal(1)
  const [structureID, setStructureID] = createSignal("")
  const [sessionName, setSessionName] = createSignal("")
  const [projectDir, setProjectDir] = createSignal("")
  const [archiveView, setArchiveView] = createSignal(false)
  const [page, setPage] = createSignal(0)
  let noteEl: HTMLInputElement | undefined
  const pageSize = 5
  let contextEl: HTMLTextAreaElement | undefined
  const owner = createMemo(() => {
    const requested = props.sessionID
    return tabs.store.find((tab) => tab.type === "session" && (!requested || tab.sessionId === requested))
  })
  const directory = createMemo(() => {
    const tab = owner()
    if (!tab || tab.type !== "session") return
    const conn = global.servers.list().find((item) => ServerConnection.key(item) === tab.server)
    return tabs.info[tabKey(tab)]?.directory ?? (conn ? global.ensureServerCtx(conn).sync.session.peek(tab.sessionId)?.directory : undefined)
  })
  const connection = createMemo(() => {
    const tab = owner()
    if (!tab || tab.type !== "session") return
    return global.servers.list().find((item) => ServerConnection.key(item) === tab.server)
  })
  const teams = () => result()?.teams ?? []
  const structures = () => result()?.structures ?? []
  const projects = createMemo(() => {
    const conn = connection() ?? global.servers.list()[0]
    if (!conn) return []
    return global.ensureServerCtx(conn).projects.list().filter((project) => project.worktree)
  })
  const team = () => {
    const id = selectedID()
    return (id ? teams().find((item) => item.id === id) : undefined) ?? result()?.team
  }
  const joined = () => {
    const tab = owner()
    const current = team()
    if (!tab || tab.type !== "session" || !current) return false
    return current.members.some((member) => member.sessionID === tab.sessionId)
  }
  const request = async (path: string, init?: RequestInit) => {
    const conn = connection()
    const dir = directory()
    const tab = owner()
    if (!conn || !dir || !tab || tab.type !== "session") return
    const url = new URL(path, conn.http.url)
    url.searchParams.set("directory", dir)
    if (!init?.body) url.searchParams.set("sessionID", tab.sessionId)
    const headers = new Headers(init?.headers)
    if (conn.http.password) {
      headers.set("Authorization", `Basic ${authTokenFromCredentials({ username: conn.http.username, password: conn.http.password })}`)
    }
    if (init?.body) headers.set("content-type", "application/json")
    const response = await fetch(url, { ...init, headers })
    if (!response.ok) throw new Error(await response.text())
    return response.json() as Promise<Result>
  }

  const act = async (body: Record<string, unknown>) => {
    const tab = owner()
    if (!tab || tab.type !== "session") return
    const next = await request("/experimental/cooperate/act", {
      method: "POST",
      body: JSON.stringify({ sessionID: tab.sessionId, human: true, teamID: team()?.id, ...body }),
    })
    if (!next) return
    setResult(next)
    if (body.action === "drop" && !next.error) setSelectedID(undefined)
    if (next.team && !selectedID()) setSelectedID(next.team.id)
    if (next.shouldWake && next.text) await wake(next.text)
    if (next.ready && next.text) await wake(next.text)
  }

  const wake = async (text: string) => {
    const conn = connection()
    const tab = owner()
    const dir = directory()
    if (!conn || !tab || tab.type !== "session" || !dir || !text) return
    const url = new URL(`/session/${tab.sessionId}/prompt_async`, conn.http.url)
    url.searchParams.set("directory", dir)
    const headers = new Headers({ "content-type": "application/json", "x-opencode-directory": encodeURIComponent(dir) })
    if (conn.http.password) {
      headers.set("Authorization", `Basic ${authTokenFromCredentials({ username: conn.http.username, password: conn.http.password })}`)
    }
    await fetch(url, { method: "POST", headers, body: JSON.stringify({ parts: [{ type: "text", text }] }) })
  }

  const listed = createMemo(() => teams().filter((item) => (archiveView() ? item.archived === true : !item.archived)))
  const pageCount = createMemo(() => Math.max(1, Math.ceil(listed().length / pageSize)))
  const pageItems = createMemo(() => listed().slice(page() * pageSize, page() * pageSize + pageSize))
  const stamp = (value?: number) => (value ? new Date(value).toLocaleDateString() : "—")

  const refresh = async () => {
    const active = document.activeElement
    if (active instanceof HTMLElement && active.closest("[data-cooperate]")) return
    const next = await request("/experimental/cooperate")
    if (!next) return
    setResult(next)
    if (!selectedID() && next.team) setSelectedID(next.team.id)
  }

  const openSession = (sessionID: string) => {
    const tab = owner()
    if (!tab || tab.type !== "session") return
    const existing = tabs.store.find((item) => item.type === "session" && item.sessionId === sessionID && item.server === tab.server)
    if (existing) tabs.select(existing)
    else navigate(sessionHref(tab.server, sessionID))
    dialog.close()
  }

  const createSession = async () => {
    const conn = connection()
    const dir = projectDir()
    const name = sessionName().trim()
    const tab = owner()
    if (!conn || !dir || !name || !tab || tab.type !== "session") return
    const url = new URL("/session", conn.http.url)
    url.searchParams.set("directory", dir)
    const headers = new Headers({ "content-type": "application/json", "x-opencode-directory": encodeURIComponent(dir) })
    if (conn.http.password) {
      headers.set("Authorization", `Basic ${authTokenFromCredentials({ username: conn.http.username, password: conn.http.password })}`)
    }
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ title: name }) })
    if (!response.ok) throw new Error(await response.text())
    const created = (await response.json()) as { id: string; directory?: string }
    if (!created.id) return
    const update = new URL(`/session/${created.id}`, conn.http.url)
    update.searchParams.set("directory", dir)
    await fetch(update, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ title: name }),
    })
    const opened = tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: created.id })
    tabs.rememberSessionInfo(opened, { id: created.id, title: name, directory: dir } as never)
    if (team()) await act({ action: "invite", targetID: created.id, teamID: team()?.id })
    setSessionName("")
  }

  const createFromStructure = async () => {
    const item = structures().find((structure) => structure.id === structureID())
    await act({
      action: "create",
      title: item?.title || title(),
      systemDirectory: directory(),
      context: item?.context,
      note: item?.note,
      condition: item?.condition,
      mode: item?.mode,
      duty: item?.duties[0],
    })
  }

  const candidates = createMemo(() => {
    const ids = new Set(team()?.members.map((member) => member.sessionID) ?? [])
    return tabs.store.flatMap((tab) => {
      if (tab.type !== "session" || ids.has(tab.sessionId)) return []
      return [{ sessionID: tab.sessionId, title: tabs.info[tabKey(tab)]?.title || tab.sessionId }]
    })
  })

  createEffect(() => {
    const current = team()
    const el = contextEl
    if (!current || !el || document.activeElement === el || el.dataset.composing === "1") return
    if (el.dataset.team === current.id) return
    el.value = current.context
    el.dataset.team = current.id
  })

  createEffect(() => {
    const current = team()
    const el = noteEl
    if (!current || !el || document.activeElement === el) return
    if (el.dataset.team === current.id) return
    el.value = current.note ?? ""
    el.dataset.team = current.id
  })

  createEffect(() => {
    if (page() > pageCount() - 1) setPage(Math.max(0, pageCount() - 1))
  })

  createEffect(() => {
    owner()
    directory()
    void refresh()
    const timer = setInterval(() => void refresh(), 3000)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <DialogV2 size="x-large">
      <DialogHeader closeLabel={language.t("common.close")}>
        <DialogTitle>{language.t("peer.title")}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex min-h-0 w-full flex-1 flex-col" style={{ overflow: "hidden", "min-height": "0" }}>
        <Show when={owner() && directory()} fallback={<p class="px-4 py-3 text-sm text-v2-text-text-muted">{language.t("peer.noSession")}</p>}>
          <div
            data-cooperate
            class="flex min-h-0 w-full flex-1 flex-col gap-4 overflow-y-auto px-4 py-4"
            style={{ "max-height": "min(520px, calc(100vh - 160px))", "overflow-y": "auto", "scrollbar-width": "thin" }}
          >
            <Show when={result()?.error}>
              <p class="text-sm text-v2-text-text-critical">{result()?.error}</p>
            </Show>
            <section class="flex flex-col gap-2" aria-label={language.t("peer.records")}>
              <div class="flex flex-wrap items-center gap-2">
                <ButtonV2 size="small" variant={archiveView() ? "ghost-muted" : "neutral"} onClick={() => { setArchiveView(false); setPage(0) }}>{language.t("peer.active")}</ButtonV2>
                <ButtonV2 size="small" variant={archiveView() ? "neutral" : "ghost-muted"} onClick={() => { setArchiveView(true); setPage(0) }}>{language.t("peer.archived")}</ButtonV2>
              </div>
              <For each={pageItems()}>
                {(item) => (
                  <button
                    type="button"
                    class="grid grid-cols-[minmax(0,1.4fr)_5.5rem_5.5rem_minmax(0,1fr)] items-center gap-2 rounded-md px-2 py-1.5 text-start text-xs hover:bg-v2-overlay-simple-overlay-hover"
                    classList={{ "bg-v2-overlay-simple-overlay-hover": team()?.id === item.id }}
                    onClick={() => {
                      if (contextEl) delete contextEl.dataset.team
                      if (noteEl) delete noteEl.dataset.team
                      setSelectedID(item.id)
                    }}
                  >
                    <span class="truncate text-sm text-v2-text-text-base" dir="auto">{item.title}</span>
                    <span class="truncate text-v2-text-text-muted" title={language.t("peer.created")}>{stamp(item.createdAt)}</span>
                    <span class="truncate text-v2-text-text-muted" title={language.t("peer.updated")}>{stamp(item.updatedAt)}</span>
                    <span class="truncate text-v2-text-text-muted" dir="auto">{item.note || language.t("peer.note")}</span>
                  </button>
                )}
              </For>
              <div class="flex items-center justify-end gap-2">
                <ButtonV2 size="small" variant="ghost-muted" disabled={page() <= 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>{language.t("peer.prev")}</ButtonV2>
                <span class="text-xs text-v2-text-text-muted">{language.t("peer.page", { page: page() + 1, pages: pageCount() })}</span>
                <ButtonV2 size="small" variant="ghost-muted" disabled={page() + 1 >= pageCount()} onClick={() => setPage((value) => Math.min(pageCount() - 1, value + 1))}>{language.t("peer.next")}</ButtonV2>
              </div>
            </section>
            <Show
              when={team()}
              fallback={
                <div class="flex max-w-sm flex-col gap-2">
                  <select class="h-8 rounded-md border border-v2-border-border-weak bg-v2-background-bg-base px-2 text-sm" value={structureID()} onChange={(event) => setStructureID(event.currentTarget.value)} aria-label={language.t("peer.structure")}>
                    <option value="">{language.t("peer.structure")}</option>
                    <For each={structures()}>{(item) => <option value={item.id}>{item.name}</option>}</For>
                  </select>
                  <TextInputV2 class="!w-full" appearance="large" value={title()} onInput={(event) => setTitle(event.currentTarget.value)} aria-label={language.t("peer.create")} />
                  <ButtonV2 size="small" onClick={() => void createFromStructure()}>
                    {language.t("peer.create")}
                  </ButtonV2>
                  <TextInputV2 class="!w-full" appearance="large" value={joinID()} onInput={(event) => setJoinID(event.currentTarget.value)} placeholder={language.t("peer.joinID")} aria-label={language.t("peer.joinID")} />
                  <ButtonV2 size="small" variant="ghost-muted" onClick={() => void act({ action: "join", teamID: joinID() })}>
                    {language.t("peer.join")}
                  </ButtonV2>
                </div>
              }
            >
              {(current) => (
                <>
                  <div class="flex min-w-0 items-start justify-between gap-3">
                    <div class="min-w-0">
                      <h2 class="truncate text-sm text-v2-text-text-base" dir="auto">{current().title}</h2>
                      <p class="truncate text-xs text-v2-text-text-muted" dir="ltr" title={current().systemDirectory}>
                        {getFilename(current().systemDirectory) || current().systemDirectory}
                      </p>
                    </div>
                    <div class="flex shrink-0 flex-wrap justify-end gap-2">
                      <ButtonV2 size="small" variant="ghost-muted" onClick={() => void act({ action: "saveStructure", title: current().title })}>
                        {language.t("peer.saveStructure")}
                      </ButtonV2>
                      <Show when={structures().length > 0}>
                        <select class="h-8 max-w-36 rounded-md border border-v2-border-border-weak bg-v2-background-bg-base px-2 text-xs" value={structureID()} onChange={(event) => setStructureID(event.currentTarget.value)} aria-label={language.t("peer.structure")}>
                          <option value="">{language.t("peer.structure")}</option>
                          <For each={structures()}>{(item) => <option value={item.id}>{item.name}</option>}</For>
                        </select>
                        <ButtonV2 size="small" variant="ghost-muted" disabled={!structureID()} onClick={() => void act({ action: "removeStructure", itemID: structureID() })}>
                          {language.t("peer.removeStructure")}
                        </ButtonV2>
                      </Show>
                      <ButtonV2 size="small" variant="ghost-muted" onClick={() => void act({ action: "archive", archived: !current().archived })}>
                        {current().archived ? language.t("peer.restore") : language.t("peer.archive")}
                      </ButtonV2>
                      <ButtonV2 size="small" variant="ghost-muted" onClick={() => void act({ action: "drop" })}>
                        {language.t("peer.delete")}
                      </ButtonV2>
                    </div>
                  </div>
                  <label class="flex w-full flex-col gap-2 text-[13px] text-v2-text-text-base">
                    {language.t("peer.note")}
                    <input
                      ref={noteEl}
                      data-prevent-autofocus
                      dir="auto"
                      aria-label={language.t("peer.note")}
                      class="h-8 w-full rounded-md border border-v2-border-border-weak bg-v2-background-bg-base px-2 text-sm text-v2-text-text-base"
                      style={{ color: "var(--v2-text-text-base)", "caret-color": "var(--v2-text-text-base)" }}
                      onPointerDown={(event) => event.currentTarget.focus()}
                      onKeyDown={(event) => event.stopPropagation()}
                      onBlur={(event) => void act({ action: "note", note: event.currentTarget.value })}
                    />
                  </label>
                  <label class="flex w-full flex-col gap-2 text-[13px] text-v2-text-text-base">
                    {language.t("peer.context")}
                    <textarea
                      ref={contextEl}
                      data-prevent-autofocus
                      autofocus
                      rows={5}
                      dir="auto"
                      aria-label={language.t("peer.context")}
                      class="pointer-events-auto relative z-10 box-border min-h-28 w-full resize-y rounded-md border border-v2-border-border-weak bg-v2-background-bg-base p-2 text-sm text-v2-text-text-base caret-v2-text-text-base"
                      style={{ color: "var(--v2-text-text-base)", "caret-color": "var(--v2-text-text-base)", "user-select": "text" }}
                      onPointerDown={(event) => {
                        event.stopPropagation()
                        event.currentTarget.focus()
                      }}
                      onCompositionStart={(event) => {
                        event.currentTarget.dataset.composing = "1"
                      }}
                      onCompositionEnd={(event) => {
                        delete event.currentTarget.dataset.composing
                      }}
                      onKeyDown={(event) => event.stopPropagation()}
                    />
                  </label>
                  <div class="flex justify-end">
                    <ButtonV2 size="small" onClick={() => void act({ action: "context", context: contextEl?.value ?? "" })}>
                      {language.t("peer.saveContext")}
                    </ButtonV2>
                  </div>
                  <section class="flex flex-col gap-2" aria-label={language.t("peer.members")}>
                    <p class="text-xs text-v2-text-text-muted">{language.t("peer.members")}</p>
                    <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2">
                      <select class="h-8 rounded-md border border-v2-border-border-weak bg-v2-background-bg-base px-2 text-sm" value={projectDir()} onChange={(event) => setProjectDir(event.currentTarget.value)} aria-label={language.t("peer.project")}>
                        <option value="">{language.t("peer.project")}</option>
                        <For each={projects()}>{(project) => <option value={project.worktree}>{("name" in project && project.name) || getFilename(project.worktree)}</option>}</For>
                      </select>
                      <input class="h-8 rounded-md border border-v2-border-border-weak bg-v2-background-bg-base px-2 text-sm" value={sessionName()} onInput={(event) => setSessionName(event.currentTarget.value)} placeholder={language.t("peer.sessionName")} aria-label={language.t("peer.sessionName")} onKeyDown={(event) => event.stopPropagation()} />
                      <ButtonV2 size="small" onClick={() => void createSession()}>{language.t("peer.newSession")}</ButtonV2>
                    </div>
                    <For each={current().members}>
                      {(member) => (
                        <div class="grid grid-cols-[minmax(0,1fr)_12rem_auto] items-center gap-2">
                          <button
                            type="button"
                            class="min-w-0 rounded-md px-2 py-1 text-start transition-colors hover:bg-v2-overlay-simple-overlay-hover"
                            aria-label={language.t("peer.open")}
                            onClick={() => openSession(member.sessionID)}
                          >
                            <span class="block truncate text-sm text-v2-text-text-base" dir="auto">{member.title}</span>
                            <span class="block truncate text-xs text-v2-text-text-muted">
                              <Show when={member.admin}>{language.t("peer.admin")} · </Show>
                              <bdi dir="ltr">{getFilename(member.directory) || member.directory}</bdi>
                            </span>
                          </button>
                          <DutyField
                            duty={member.duty}
                            sessionID={member.sessionID}
                            label={language.t("peer.duty")}
                            onCommit={(duty) => void act({ action: "duty", targetID: member.sessionID, duty })}
                          />
                          <Show when={!member.admin} fallback={<span class="size-6" />}>
                            <IconButtonV2 icon={<IconV2 name="close" size="small" />} variant="ghost-muted" size="small" aria-label={language.t("peer.kick")} onClick={() => void act({ action: "kick", targetID: member.sessionID })} />
                          </Show>
                        </div>
                      )}
                    </For>
                    <Show when={candidates().length > 0}>
                      <div class="flex flex-wrap gap-2">
                        <For each={candidates()}>
                          {(tab) => (
                            <ButtonV2 size="small" variant="ghost-muted" onClick={() => void act({ action: "invite", targetID: tab.sessionID })}>
                              {language.t("peer.invite", { title: tab.title })}
                            </ButtonV2>
                          )}
                        </For>
                      </div>
                    </Show>
                    <Show when={!joined()}>
                      <ButtonV2 size="small" onClick={() => void act({ action: "join", teamID: current().id })}>
                        {language.t("peer.join")}
                      </ButtonV2>
                    </Show>
                  </section>
                  <section class="flex flex-col gap-2" aria-label={language.t("peer.condition")}>
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="text-xs text-v2-text-text-muted">{language.t("peer.condition")}</span>
                      <ButtonV2 variant={current().condition.type === "all" ? "neutral" : "ghost-muted"} size="small" onClick={() => void act({ action: "configure", condition: { type: "all" } })}>{language.t("peer.condition.all")}</ButtonV2>
                      <ButtonV2 variant={current().condition.type === "any" ? "neutral" : "ghost-muted"} size="small" onClick={() => void act({ action: "configure", condition: { type: "any" } })}>{language.t("peer.condition.any")}</ButtonV2>
                      <ButtonV2 variant={current().condition.type === "count" ? "neutral" : "ghost-muted"} size="small" onClick={() => void act({ action: "configure", condition: { type: "count", count: count() } })}>{language.t("peer.condition.count")}</ButtonV2>
                      <TextInputV2 class="!w-16" type="number" min="1" value={String(count())} onInput={(event) => setCount(Number(event.currentTarget.value) || 1)} aria-label={language.t("peer.condition.count")} />
                    </div>
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="text-xs text-v2-text-text-muted">{language.t("peer.mode")}</span>
                      <ButtonV2 variant={current().mode === "auto" ? "neutral" : "ghost-muted"} size="small" onClick={() => void act({ action: "configure", mode: "auto" })}>{language.t("peer.mode.auto")}</ButtonV2>
                      <ButtonV2 variant={current().mode === "manual" ? "neutral" : "ghost-muted"} size="small" onClick={() => void act({ action: "configure", mode: "manual" })}>{language.t("peer.mode.manual")}</ButtonV2>
                      <Show when={current().mode === "manual"}>
                        <ButtonV2 size="small" onClick={() => void act({ action: "receive" })}>{language.t("peer.receive")}</ButtonV2>
                      </Show>
                    </div>
                  </section>
                  <Show when={current().items.length > 0} fallback={<p class="text-xs text-v2-text-text-muted">{language.t("peer.empty")}</p>}>
                    <For each={current().items}>
                      {(item) => (
                        <article class="flex flex-col gap-1">
                          <div class="flex items-center justify-between gap-2">
                            <span class="truncate text-sm" dir="auto">{item.title}</span>
                            <span class="text-xs text-v2-text-text-muted">{item.status}</span>
                            <IconButtonV2 icon={<IconV2 name="close" size="small" />} variant="ghost-muted" size="small" aria-label={language.t("peer.remove")} onClick={() => void act({ action: "remove", itemID: item.id })} />
                          </div>
                          <p class="line-clamp-2 text-sm text-v2-text-text-muted" dir="auto">{item.result || item.prompt}</p>
                        </article>
                      )}
                    </For>
                  </Show>
                </>
              )}
            </Show>
          </div>
        </Show>
      </DialogBody>
    </DialogV2>
  )
}

function DutyField(props: { duty: string; sessionID: string; label: string; onCommit: (value: string) => void }) {
  let el: HTMLInputElement | undefined
  createEffect(() => {
    const duty = props.duty
    if (!el || document.activeElement === el || el.dataset.touched === "1") return
    if (el.dataset.session !== props.sessionID) {
      el.value = duty
      el.dataset.session = props.sessionID
      return
    }
    if (el.value !== duty) el.value = duty
  })
  return (
    <input
      ref={el}
      data-prevent-autofocus
      aria-label={props.label}
      class="h-8 w-full rounded-md border border-v2-border-border-weak bg-v2-background-bg-base px-2 text-sm text-v2-text-text-base"
      style={{ color: "var(--v2-text-text-base)", "caret-color": "var(--v2-text-text-base)" }}
      onPointerDown={(event) => event.currentTarget.focus()}
      onInput={(event) => {
        event.currentTarget.dataset.touched = "1"
      }}
      onKeyDown={(event) => event.stopPropagation()}
      onBlur={(event) => {
        delete event.currentTarget.dataset.touched
        props.onCommit(event.currentTarget.value)
      }}
    />
  )
}

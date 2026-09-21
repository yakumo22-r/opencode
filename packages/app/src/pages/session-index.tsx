import { getFilename } from "@opencode-ai/core/util/path"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { useNavigate } from "@solidjs/router"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { type LocalProject, useLayout } from "@/context/layout"
import { useNotification } from "@/context/notification"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { tabKey, useTabs } from "@/context/tabs"
import { ProjectIcon } from "@/pages/layout/sidebar-items"
import { pathKey } from "@/utils/path-key"
import { sessionTitle } from "@/utils/session-title"

type SessionIndexRecord = {
  key: string
  sessionID: string
  directory: string
  title: string
  project: LocalProject | undefined
  projectName: string
  status: "working" | "permission" | "error" | "unread" | "open"
}

export function SessionIndexPage() {
  const tabs = useTabs()
  const layout = useLayout()
  const server = useServer()
  const serverSync = useServerSync()
  const notification = useNotification()
  const language = useLanguage()
  const navigate = useNavigate()
  const [selectedProject, setSelectedProject] = createSignal<string>()
  const [newGroupName, setNewGroupName] = createSignal("")

  const pendingPermissions = createMemo(() => {
    const ids = new Set<string>()
    for (const request of Object.values(serverSync().session.data.permission)) {
      if (request.sessionID) ids.add(request.sessionID)
    }
    return ids
  })

  const records = createMemo<SessionIndexRecord[]>(() =>
    (tabs.visible() ?? []).flatMap((tab) => {
      if (tab.type !== "session") return []
      const info = tabs.info[tabKey(tab)]
      const session = tab.server === server.key ? serverSync().session.peek(tab.sessionId) : undefined
      const sessionDirectory = session?.directory ?? info?.directory
      const project = layout.projects.list().find((item) => {
        if (!sessionDirectory) return false
        const directory = pathKey(sessionDirectory)
        return pathKey(item.worktree) === directory || item.sandboxes?.some((sandbox) => pathKey(sandbox) === directory)
      })
      const directory = sessionDirectory ?? project?.worktree ?? `${tab.server}\n${tab.sessionId}`
      const status = (() => {
        if (tab.server !== server.key) return "open" as const
        if (serverSync().session.data.session_working(tab.sessionId)) return "working" as const
        if (pendingPermissions().has(tab.sessionId)) return "permission" as const
        if (notification.session.unseenHasError(tab.sessionId)) return "error" as const
        if (notification.session.unseenCount(tab.sessionId) > 0) return "unread" as const
        return "open" as const
      })()
      return {
        key: tabKey(tab),
        sessionID: tab.sessionId,
        directory,
        title: sessionTitle(session?.title ?? info?.title) ?? tab.sessionId,
        project,
        projectName: project?.name || (sessionDirectory ? getFilename(project?.worktree ?? directory) : language.t("session.index.unknownProject")),
        status,
      }
    }),
  )
  const projects = createMemo(() =>
    [...new Map((records() ?? []).map((record) => [record.directory, record] as const)).values()].sort((a, b) =>
      a.projectName.localeCompare(b.projectName),
    ),
  )
  const filtered = createMemo(() =>
    (records() ?? []).filter((record) => !selectedProject() || record.directory === selectedProject()),
  )
  const activeGroup = createMemo(() => tabs.groups.groups.find((group) => group.id === tabs.groups.active) ?? tabs.groups.groups[0])

  return (
    <main class="fixed inset-0 z-50 flex min-h-0 flex-col bg-v2-background-bg-base px-5 py-6 lg:px-12 lg:py-10">
      <div class="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col gap-6">
        <header class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 class="text-xl font-[560] text-v2-text-text-strong">{language.t("session.index.title")}</h1>
            <p class="mt-1 text-sm text-v2-text-text-muted">{language.t("session.index.description")}</p>
          </div>
          <ButtonV2 variant="ghost-muted" size="normal" icon="close" onClick={() => navigate("/")}>
            {language.t("common.close")}
          </ButtonV2>
        </header>

          <nav class="flex flex-wrap gap-2" aria-label={language.t("session.index.projectFilter")}>
          <ButtonV2
            variant={selectedProject() ? "ghost-muted" : "neutral"}
            size="small"
            onClick={() => setSelectedProject()}
          >
            {language.t("session.index.allProjects")}
          </ButtonV2>
          <For each={projects()}>
            {(record) => (
              <ButtonV2
                variant={selectedProject() === record.directory ? "neutral" : "ghost-muted"}
                size="small"
                onClick={() => setSelectedProject(record.directory)}
              >
                {record.projectName}
              </ButtonV2>
            )}
          </For>
          </nav>

          <section class="flex flex-wrap items-center gap-2 border-y border-v2-border-border-weak py-3" aria-label={language.t("session.index.groups")}>
            <For each={tabs.groups.groups}>
              {(group) => (
                <ButtonV2
                  variant={activeGroup()?.id === group.id ? "neutral" : "ghost-muted"}
                  size="small"
                  onClick={() => tabs.selectGroup(group.id)}
                >
                  {group.name}
                </ButtonV2>
              )}
            </For>
            <form
              class="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                const name = newGroupName().trim()
                if (!name) return
                tabs.createGroup(name)
                setNewGroupName("")
              }}
            >
              <input
                class="h-8 w-36 rounded border border-v2-border-border-weak bg-v2-background-bg-layer-02 px-2 text-sm text-v2-text-text-base outline-none focus:border-v2-border-border-accent"
                value={newGroupName()}
                onInput={(event) => setNewGroupName(event.currentTarget.value)}
                placeholder={language.t("session.index.newGroup")}
                aria-label={language.t("session.index.newGroup")}
              />
              <ButtonV2 type="submit" variant="ghost-muted" size="small">
                {language.t("session.index.createGroup")}
              </ButtonV2>
            </form>
          </section>

        <Show
          when={filtered().length > 0}
          fallback={<p class="py-16 text-center text-v2-text-text-muted">{language.t("session.index.empty")}</p>}
        >
          <section class="min-h-0 flex-1 overflow-auto grid grid-cols-1 gap-3 content-start md:grid-cols-2 xl:grid-cols-3" aria-label={language.t("session.index.title")}>
            <For each={filtered()}>
              {(record) => (
                <article class="group flex min-h-36 flex-col rounded-xl border border-v2-border-border-weak bg-v2-background-bg-layer-02 p-4 transition-colors hover:bg-v2-background-bg-layer-03">
                  <button
                    type="button"
                    class="flex min-w-0 flex-1 flex-col text-left outline-none focus-visible:ring-2 focus-visible:ring-v2-icon-icon-accent"
                     onClick={() => {
                       const tab = tabs.store.find((item) => tabKey(item) === record.key)
                       if (tab) tabs.select(tab)
                     }}
                  >
                    <div class="flex items-center gap-2 text-sm text-v2-text-text-muted">
                      <Show
                        when={record.project}
                        fallback={<div class="size-6 rounded bg-v2-background-bg-layer-03" />}
                      >
                        {(project) => <ProjectIcon project={project()} class="size-6" />}
                      </Show>
                      <span class="truncate">{record.projectName}</span>
                    </div>
                    <h2 class="mt-4 line-clamp-2 text-base font-[560] text-v2-text-text-base">{record.title}</h2>
                  </button>
                    <div class="mt-4 flex items-center justify-between gap-3">
                      <SessionStatus status={record.status} />
                      <select
                        class="max-w-32 truncate rounded border border-v2-border-border-weak bg-v2-background-bg-layer-02 px-1.5 py-1 text-xs text-v2-text-text-muted"
                        value={activeGroup()?.id}
                        aria-label={language.t("session.index.moveToGroup")}
                         onChange={(event) => tabs.moveToGroup(record.key, event.currentTarget.value)}
                      >
                        <For each={tabs.groups.groups}>{(group) => <option value={group.id}>{group.name}</option>}</For>
                      </select>
                      <IconButtonV2
                      icon={<IconV2 name="close" size="small" />}
                      variant="ghost-muted"
                      size="small"
                      aria-label={language.t("common.closeTab")}
                       onClick={() => {
                         const index = tabs.store.findIndex((item) => tabKey(item) === record.key)
                         if (index !== -1) tabs.closeTab(index)
                       }}
                      />
                  </div>
                </article>
              )}
            </For>
          </section>
        </Show>
      </div>
    </main>
  )
}

function SessionStatus(props: { status: SessionIndexRecord["status"] }) {
  const language = useLanguage()
  const label = () => language.t(`session.index.status.${props.status}`)
  return (
    <span class="flex items-center gap-1.5 text-xs text-v2-text-text-muted">
      <span
        class="size-1.5 rounded-full"
        classList={{
          "bg-v2-icon-icon-accent": props.status === "working" || props.status === "unread",
          "bg-icon-warning-base": props.status === "permission",
          "bg-icon-critical-base": props.status === "error",
          "bg-v2-icon-icon-muted": props.status === "open",
        }}
      />
      {label()}
    </span>
  )
}

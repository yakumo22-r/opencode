import { getFilename } from "@opencode-ai/core/util/path"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { useNavigate } from "@solidjs/router"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { type LocalProject, useLayout } from "@/context/layout"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { tabKey, useTabs } from "@/context/tabs"
import { ProjectIcon } from "@/pages/layout/sidebar-items"
import { pathKey } from "@/utils/path-key"
import { sessionTitle } from "@/utils/session-title"

type SessionIndexRecord = {
  index: number
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
  const permission = usePermission()
  const language = useLanguage()
  const navigate = useNavigate()
  const [selectedProject, setSelectedProject] = createSignal<string>()
  const [resolved, setResolved] = createStore<Record<string, { title: string; directory: string }>>({})
  const resolving = new Set<string>()

  createEffect(() => {
    for (const tab of tabs.store ?? []) {
      if (tab.type !== "session" || tab.server !== server.key) continue
      const key = tabKey(tab)
      if (resolved[key] || tabs.info[key]?.title || resolving.has(key)) continue
      resolving.add(key)
      void serverSync()
        .session.resolve(tab.sessionId)
        .then((session) => {
          if (!session) return
          setResolved(key, { title: session.title, directory: session.directory })
          tabs.rememberSessionInfo(tab, session)
        })
        .catch(() => {})
        .finally(() => resolving.delete(key))
    }
  })

  const records = createMemo<SessionIndexRecord[]>(() =>
    (tabs.store ?? []).flatMap((tab, index) => {
      if (tab.type !== "session") return []
      const info = tabs.info[tabKey(tab)]
      const loaded = resolved[tabKey(tab)]
      const session = tab.server === server.key ? serverSync().session.peek(tab.sessionId) : undefined
      const sessionDirectory = session?.directory ?? loaded?.directory ?? info?.directory
      const project = layout.projects.list().find((item) => {
        if (!sessionDirectory) return false
        const directory = pathKey(sessionDirectory)
        return pathKey(item.worktree) === directory || item.sandboxes?.some((sandbox) => pathKey(sandbox) === directory)
      })
      const directory = sessionDirectory ?? project?.worktree ?? `${tab.server}\n${tab.sessionId}`
      const status = (() => {
        if (tab.server !== server.key) return "open" as const
        if (serverSync().session.data.session_working(tab.sessionId)) return "working" as const
        if (
          Object.values(serverSync().session.data.permission).some(
            (request) => request.sessionID === tab.sessionId && !permission.autoResponds(request, directory),
          )
        ) {
          return "permission" as const
        }
        if (notification.session.unseenHasError(tab.sessionId)) return "error" as const
        if (notification.session.unseenCount(tab.sessionId) > 0) return "unread" as const
        return "open" as const
      })()
      return {
        index,
        sessionID: tab.sessionId,
        directory,
        title: sessionTitle(session?.title ?? loaded?.title ?? info?.title) ?? tab.sessionId,
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
                    onClick={() => tabs.select(tabs.store[record.index]!)}
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
                    <IconButtonV2
                      icon={<IconV2 name="close" size="small" />}
                      variant="ghost-muted"
                      size="small"
                      aria-label={language.t("common.closeTab")}
                      onClick={() => tabs.closeTab(record.index)}
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

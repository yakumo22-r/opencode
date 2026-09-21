import type { Session } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createStore, produce } from "solid-js/store"
import { Persist, persisted, removePersisted, draftPersistedKeys } from "@/utils/persist"
import { ServerConnection, useServer } from "./server"
import { createEffect, createMemo, getOwner, onCleanup, runWithOwner, startTransition, untrack } from "solid-js"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { usePlatform } from "./platform"
import { uuid } from "@/utils/uuid"
import { SessionTabsRemovedDetail } from "@/components/titlebar-session-events"
import { sessionHref } from "@/utils/session-route"
import { createTabMemory } from "./tab-memory"
import { pushClosedTab, removeClosedTabs, takeClosedTab, type ClosedTab } from "./closed-tabs"
import { createDraftPromptSession, type PromptModel } from "./prompt-state"
import { migrateTabs } from "./tab-migration"

export type SessionTab = {
  type: "session"
  server: ServerConnection.Key
  sessionId: string
}

export type DraftTab = {
  type: "draft"
  draftID: string
  server: ServerConnection.Key
  directory: string
  worktree?: string
}

export type Tab = SessionTab | DraftTab

export type TabInfo = {
  title?: string
  directory?: string
}

type RecentTab = {
  key?: string
}

export type TabGroup = {
  id: string
  name: string
  keys: string[]
}

type TabGroups = {
  active: string
  groups: TabGroup[]
}

export const draftHref = (draftID: string) => `/new-session?draftId=${encodeURIComponent(draftID)}`

export const tabHref = (tab: Tab) =>
  tab.type === "draft" ? draftHref(tab.draftID) : sessionHref(tab.server, tab.sessionId)

export const tabKey = (tab: Tab) => (tab.type === "draft" ? `draft:${tab.draftID}` : `${tab.server}\n${tabHref(tab)}`)

function debugTabs(event: string, extra?: Record<string, unknown>) {
  console.warn("[tabs-debug]", { t: Date.now(), event, ...extra })
}

export function sessionHasOpenTab(tabs: Tab[], server: ServerConnection.Key, session: Session) {
  return tabs.some((tab) => tab.type === "session" && tab.server === server && tab.sessionId === session.id)
}

export const { use: useTabs, provider: TabsProvider } = createSimpleContext({
  name: "Tabs",
  gate: false,
  init: () => {
    const server = useServer()
    const platform = usePlatform()
    const fallback = server.key
    const [store, setStore, _, ready] = persisted(
      {
        ...Persist.window("tabs"),
        migrate: (value: unknown) => migrateTabs(value, fallback),
      },
      createStore<Tab[]>([]),
    )
    const [recent, setRecent, , recentReady] = persisted(Persist.window("tabs.recent"), createStore<RecentTab>({}))
    const [info, setInfo] = persisted(Persist.window("tabs.info"), createStore<Record<string, TabInfo>>({}))
    const [groups, setGroups, , groupsReady] = persisted(
      {
        ...Persist.window("tabs.groups"),
        migrate: (value: unknown): TabGroups => {
          if (!value || typeof value !== "object") return { active: "default", groups: [{ id: "default", name: "Default", keys: [] }] }
          const input = value as Partial<TabGroups>
          const valid = Array.isArray(input.groups)
            ? input.groups.filter((group): group is TabGroup => !!group && typeof group === "object" && typeof group.id === "string" && typeof group.name === "string" && Array.isArray(group.keys))
            : []
          return valid.length ? { active: typeof input.active === "string" ? input.active : valid[0].id, groups: valid } : { active: "default", groups: [{ id: "default", name: "Default", keys: [] }] }
        },
      },
      createStore<TabGroups>({ active: "default", groups: [{ id: "default", name: "Default", keys: [] }] }),
    )
    const [closed, setClosed, , closedReady] = persisted(Persist.window("tabs.closed"), createStore<ClosedTab[]>([]))

    const params = useParams()
    const navigate = useNavigate()
    const location = useLocation()
    const memory = createTabMemory(getOwner())

    let recentWrite = 0
    let recentValue: string | undefined

    const recentKey = () => (recentWrite ? recentValue : recent.key)

    const setRecentKey = (key: string | undefined) => {
      const write = ++recentWrite
      recentValue = key
      if (recentReady()) {
        setRecent("key", key)
        return
      }
      void recentReady.promise?.then(() => {
        if (write === recentWrite) setRecent("key", key)
      })
    }

    const updateClosed = (update: (stack: ClosedTab[]) => ClosedTab[]) => {
      const apply = () => setClosed((stack) => update(stack))
      if (closedReady()) {
        apply()
        return
      }
      void closedReady.promise?.then(apply)
    }

    const removeDraftPersisted = (draftID: string) => {
      for (const key of draftPersistedKeys()) {
        const target = Persist.draft(draftID, key)
        removePersisted(key === "prompt" ? Persist.prompt(target) : target, platform)
      }
    }

    const removeInfo = (key: string) => {
      if (!info[key]) return
      setInfo(
        produce((draft) => {
          delete draft[key]
        }),
      )
    }

    onCleanup(memory.dispose)

    createEffect(() => {
      if (!ready() || !recentReady()) return
      const servers = new Set(server.list.map(ServerConnection.key))
      const next = store.filter((tab) => servers.has(tab.server))
      if (next.length !== store.length) {
        for (const tab of store) {
          if (!servers.has(tab.server)) {
            const key = tabKey(tab)
            memory.remove(key)
            removeInfo(key)
          }
        }
        setStore(() => next)
      }
      if (recent.key && !next.some((tab) => tabKey(tab) === recent.key)) setRecentKey(undefined)
      const keys = new Set(next.map(tabKey))
      for (const key of Object.keys(info)) {
        if (!keys.has(key)) removeInfo(key)
      }
    })

    createEffect(() => {
      if (!closedReady()) return
      const servers = new Set(server.list.map(ServerConnection.key))
      const next = closed.filter((entry) => servers.has(entry.tab.server))
      if (next.length !== closed.length) setClosed(() => next)
    })

    let hydratedGroups = false
    createEffect(() => {
      if (hydratedGroups || !ready() || !groupsReady()) return
      hydratedGroups = true
      debugTabs("groups.hydrate.scheduled", { tabs: store.length, groups: groups.groups.length })
      queueMicrotask(() => {
        runWithOwner(undefined, () => {
          untrack(() => {
            const keys = store.map(tabKey)
            const present = new Set(keys)
            const known = new Set(groups.groups.flatMap((group) => group.keys))
            const missing = keys.filter((key) => !known.has(key))
            const nextGroups = groups.groups.map((group) => ({ ...group, keys: group.keys.filter((key) => present.has(key)) }))
            if (missing.length) nextGroups[0].keys.push(...missing)
            const active = nextGroups.some((group) => group.id === groups.active) ? groups.active : nextGroups[0].id
            const changed =
              active !== groups.active ||
              nextGroups.length !== groups.groups.length ||
              nextGroups.some((group, index) => {
                const current = groups.groups[index]
                return !current || current.id !== group.id || current.name !== group.name || current.keys.length !== group.keys.length || group.keys.some((key, keyIndex) => key !== current.keys[keyIndex])
              })
            debugTabs("groups.hydrate", { tabs: keys.length, missing: missing.length, changed })
            if (changed) setGroups({ active, groups: nextGroups })
          })
        })
      })
    })

    const activeGroup = createMemo(() => groups.groups.find((group) => group.id === groups.active) ?? groups.groups[0])
    const visible = createMemo((prev: Tab[] = []) => {
      const ordered = (activeGroup()?.keys ?? []).flatMap((key) => {
        const tab = store.find((item) => tabKey(item) === key)
        return tab ? [tab] : []
      })
      if (prev.length === ordered.length && prev.every((tab, index) => tab === ordered[index])) return prev
      return ordered
    })

    const navigateTab = (tab: Tab) => {
      const href = tabHref(tab)
      debugTabs("navigate", { key: tabKey(tab), href, path: location.pathname })
      setRecentKey(tabKey(tab))
      navigate(href)
    }

    const addGroupKey = (key: string) => {
      const id = untrack(() => activeGroup()?.id)
      if (!id) return
      debugTabs("groups.add", { key, id })
      setGroups("groups", (items) =>
        items.map((group) => (group.id === id && !group.keys.includes(key) ? { ...group, keys: [...group.keys, key] } : group)),
      )
    }

    const dropGroupKeys = (keys: string[]) => {
      if (!keys.length) return
      debugTabs("groups.drop", { keys })
      const remove = new Set(keys)
      setGroups("groups", (items) => items.map((group) => ({ ...group, keys: group.keys.filter((key) => !remove.has(key)) })))
    }

    const replaceGroupKey = (from: string, to: string) => {
      setGroups("groups", (items) =>
        items.map((group) => ({
          ...group,
          keys: group.keys.map((key) => (key === from ? to : key)).filter((key, index, list) => key !== to || list.indexOf(key) === index),
        })),
      )
    }

    const nextVisibleAfterClose = (key: string) => {
      const keys = activeGroup()?.keys ?? []
      const index = keys.indexOf(key)
      const nextKey = index === -1 ? undefined : (keys[index + 1] ?? keys[index - 1])
      if (!nextKey) return null
      return store.find((tab) => tabKey(tab) === nextKey) ?? null
    }

    const removeTab = (index: number) => {
      const tab = store[index]
      if (!tab) return
      const key = tabKey(tab)
      const draftID = tab.type === "draft" ? tab.draftID : undefined
      const onIndex = location.pathname === "/session-index"
      const closingCurrent = recentKey() === key && location.pathname !== "/" && !onIndex
      const nextTab = closingCurrent ? nextVisibleAfterClose(key) : undefined
      debugTabs("tab.remove", { key, index, closingCurrent, onIndex, next: nextTab ? tabKey(nextTab) : nextTab })
      if (nextTab === null) {
        setRecentKey(undefined)
        navigate("/")
      } else if (nextTab) navigateTab(nextTab)
      void startTransition(() => {
        setStore(
          produce((tabs) => {
            const current = tabs.findIndex((item) => tabKey(item) === key)
            if (current !== -1) tabs.splice(current, 1)
          }),
        )
        dropGroupKeys([key])
      })
      memory.remove(key)
      removeInfo(key)
      if (draftID) removeDraftPersisted(draftID)
    }

    const actions = {
      addSessionTab: (tab: Omit<SessionTab, "type">) => {
        const next = { type: "session" as const, ...tab }
        const existing = store.find((item) => tabKey(item) === tabKey(next))
        if (existing) return existing
        void startTransition(() => {
          setStore(
            produce((tabs) => {
              if (tabs.some((item) => tabKey(item) === tabKey(next))) return
              tabs.push(next)
            }),
          )
          addGroupKey(tabKey(next))
        })
        return next
      },
      reorder(keys: string[]) {
        const current = activeGroup()
        if (!current || keys.length !== current.keys.length) return
        setGroups("groups", (items) => items.map((group) => group.id === current.id ? { ...group, keys } : group))
      },
      visible,
      groups,
      groupsReady,
      createGroup(name: string) {
        const id = uuid()
        setGroups("groups", (items) => [...items, { id, name, keys: [] }])
        setGroups("active", id)
        return id
      },
      selectGroup(id: string) {
        if (!groups.groups.some((group) => group.id === id)) return
        const next = groups.groups.find((group) => group.id === id)
        const current = recentKey()
        setGroups("active", id)
        if (current && !next?.keys.includes(current) && location.pathname !== "/session-index") navigate("/session-index")
      },
      renameGroup(id: string, name: string) {
        setGroups("groups", (items) => items.map((group) => group.id === id ? { ...group, name } : group))
      },
      moveToGroup(key: string, id: string) {
        if (!groups.groups.some((group) => group.id === id)) return
        setGroups("groups", (items) => items.map((group) => ({ ...group, keys: group.id === id ? [...group.keys.filter((item) => item !== key), key] : group.keys.filter((item) => item !== key) })))
      },
      draft(draftID: string) {
        const tab = store.find((item) => item.type === "draft" && item.draftID === draftID)
        if (!tab || tab.type !== "draft") throw new Error(`Draft not found: ${draftID}`)
        return tab
      },
      async newDraft(draft: Omit<DraftTab, "type" | "draftID">, prompt?: string, model?: PromptModel) {
        const draftID = uuid()
        const tab = { type: "draft" as const, draftID, ...draft }
        debugTabs("tab.newDraft", { draftID, directory: draft.directory })
        memory.ensure(tabKey(tab), "prompt", () => createDraftPromptSession(draftID, { prompt, model }))
        await startTransition(() => {
          setStore(
            produce((tabs) => {
              tabs.push(tab)
            }),
          )
          addGroupKey(tabKey(tab))
          navigate(draftHref(draftID))
        })
        return tab
      },
      updateDraft(draftID: string, draft: Partial<Omit<DraftTab, "type" | "draftID">>) {
        void startTransition(() => {
          setStore(
            (tab) => tab.type === "draft" && tab.draftID === draftID,
            produce((tab) => Object.assign(tab, draft)),
          )
        })
      },
      promoteDraft(draftID: string, session: Omit<SessionTab, "type">) {
        // Keep the replacement and navigation atomic so /new-session never renders
        // after its backing draft tab has been removed from the store.
        const active = location.pathname === "/new-session" && location.query.draftId === draftID
        const next = { type: "session" as const, ...session }
        void startTransition(() => {
          setStore(
            produce((tabs) => {
              const index = tabs.findIndex((tab) => tab.type === "draft" && tab.draftID === draftID)
              if (index !== -1) tabs[index] = next
            }),
          )
          replaceGroupKey(`draft:${draftID}`, tabKey(next))
          if (recent.key === `draft:${draftID}`) setRecentKey(tabKey(next))
          if (active) navigateTab(next)
        })
        memory.remove(`draft:${draftID}`)
        removeDraftPersisted(draftID)
      },
      removeTab,
      // User-initiated close: records the tab so it can be reopened.
      // Cleanup paths (missing sessions, archive, server removal) go through
      // removeTab and friends directly and are not recorded.
      closeTab(index: number) {
        const tab = store[index]
        if (!tab) return
        if (tab.type === "session") updateClosed((stack) => pushClosedTab(stack, tab, index))
        removeTab(index)
      },
      reopenClosedTab() {
        if (!closedReady()) {
          void closedReady.promise?.then(() => actions.reopenClosedTab())
          return
        }
        const result = takeClosedTab(closed, store)
        if (result.stack.length === closed.length) return
        setClosed(() => result.stack)
        const entry = result.entry
        if (!entry) return
        const index = Math.min(entry.index, store.length)
        void startTransition(() => {
          setStore(
            produce((tabs) => {
              if (tabs.some((item) => tabKey(item) === tabKey(entry.tab))) return
              tabs.splice(index, 0, entry.tab)
            }),
          )
          addGroupKey(tabKey(entry.tab))
          navigateTab(entry.tab)
        })
      },
      removeSessionTab(input: Omit<SessionTab, "type">) {
        updateClosed((stack) => removeClosedTabs(stack, input.server, [input.sessionId]))
        const index = store.findIndex(
          (tab) => tab.type === "session" && tab.server === input.server && tab.sessionId === input.sessionId,
        )
        if (index !== -1) removeTab(index)
      },
      removeServer(key: ServerConnection.Key) {
        updateClosed((stack) => stack.filter((entry) => entry.tab.server !== key))
        const drafts = store.flatMap((tab) => (tab.type === "draft" && tab.server === key ? [tab.draftID] : []))
        const removed = store.filter((tab) => tab.server === key).map(tabKey)
        setStore((tabs) => tabs.filter((tab) => tab.server !== key))
        dropGroupKeys(removed)
        for (const key of removed) memory.remove(key)
        for (const key of removed) removeInfo(key)
        if (recent.key && removed.includes(recent.key)) setRecentKey(undefined)
        for (const draftID of drafts) removeDraftPersisted(draftID)
        if (server.key === key) navigate("/")
      },
      removeSessions: (input: SessionTabsRemovedDetail) => {
        const targetServer = input.server ?? server.key
        updateClosed((stack) => removeClosedTabs(stack, targetServer, input.sessionIDs))
        const removed = store
          .filter(
            (tab) => tab.type === "session" && tab.server === targetServer && input.sessionIDs.includes(tab.sessionId),
          )
          .map(tabKey)
        void startTransition(() => {
          setStore(
            produce((tabs) => {
              const sessionIDs = new Set(input.sessionIDs)
              const currentHref =
                targetServer === server.key && params.dir && params.id
                  ? tabHref({
                      type: "session",
                      server: targetServer,
                      sessionId: params.id,
                    })
                  : undefined
              const currentIndex = currentHref
                ? tabs.findIndex(
                    (tab) => tab.type === "session" && tab.server === targetServer && tabHref(tab) === currentHref,
                  )
                : -1
              const currentTab = tabs[currentIndex]
              const removedCurrent =
                currentTab?.type === "session" &&
                currentTab.server === targetServer &&
                sessionIDs.has(currentTab.sessionId)

              for (let i = tabs.length - 1; i >= 0; i--) {
                const tab = tabs[i]
                if (!tab || tab.type !== "session") continue
                if (tab.server !== targetServer) continue
                if (!sessionIDs.has(tab.sessionId)) continue
                tabs.splice(i, 1)
              }

              if (!removedCurrent) return
              const nextTab =
                tabs.slice(currentIndex).find((tab) => tab.type === "session") ??
                tabs.slice(0, currentIndex).findLast((tab) => tab.type === "session")
              if (nextTab) navigateTab(nextTab)
              else navigate("/")
            }),
          )
          dropGroupKeys(removed)
          if (recent.key && removed.includes(recent.key)) setRecentKey(undefined)
        })
        for (const key of removed) memory.remove(key)
        for (const key of removed) removeInfo(key)
      },
      rememberSessionInfo(tab: SessionTab, session: Session) {
        const key = tabKey(tab)
        const next = { title: session.title, directory: session.directory }
        const current = info[key]
        if (current?.title === next.title && current.directory === next.directory) return
        setInfo(key, next)
      },
      select: navigateTab,
      remember(tab: Tab) {
        const key = tabKey(tab)
        if (recentKey() !== key) setRecentKey(key)
      },
      toggleHome(input: { home: boolean; current?: Tab }) {
        if (input.home) {
          const tab = store.find((tab) => tabKey(tab) === recentKey())
          if (tab) navigateTab(tab)
          return
        }
        if (input.current) {
          setRecentKey(tabKey(input.current))
          navigate("/")
          return
        }
        navigate("/")
      },
      state<T>(tab: Tab, name: string, init: () => T) {
        return memory.ensure(tabKey(tab), name, init)
      },
      stateValue<T>(tab: Tab, name: string) {
        return memory.get<T>(tabKey(tab), name)
      },
    }

    return { ...actions, store, info, ready, recentReady }
  },
})

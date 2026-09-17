import { app, dialog, shell } from "electron"
import { UPDATER_ENABLED, UPSTREAM_MERGE_URL, UPSTREAM_RELEASES_URL } from "./constants"
import { createUpdaterController, type UpdaterReadyRecord } from "./updater-controller"
import { getLogger } from "./logging"
import { getStore } from "./store"
import { nativeT } from "./native-translations"

const key = "ready"

function normalizeVersion(value: string) {
  return value.trim().replace(/^v/i, "")
}

function isNewerVersion(latest: string, current: string) {
  const left = normalizeVersion(latest).split(".").map((part) => Number.parseInt(part, 10) || 0)
  const right = normalizeVersion(current).split(".").map((part) => Number.parseInt(part, 10) || 0)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index++) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a > b) return true
    if (a < b) return false
  }
  return false
}

async function checkUpstreamRelease(currentVersion: string) {
  const response = await fetch(UPSTREAM_RELEASES_URL, {
    headers: { Accept: "application/vnd.github+json" },
  })
  if (!response.ok) throw new Error(`Upstream release check failed (${response.status})`)
  const payload = (await response.json()) as { tag_name?: string }
  const version = payload.tag_name ? normalizeVersion(payload.tag_name) : undefined
  if (!version) return { isUpdateAvailable: false, updateInfo: { version: currentVersion } }
  return {
    isUpdateAvailable: isNewerVersion(version, currentVersion),
    updateInfo: { version },
  }
}

export function setupAutoUpdater(_stop: () => Promise<void>) {
  const logger = getLogger()
  logger.log("auto updater configured", {
    mode: "upstream-merge",
    currentVersion: app.getVersion(),
  })

  const store = getStore("opencode.updater")
  return createUpdaterController({
    enabled: UPDATER_ENABLED,
    currentVersion: app.getVersion(),
    skipDownload: true,
    backend: {
      checkForUpdates: () => checkUpstreamRelease(app.getVersion()),
      downloadUpdate: async () => undefined,
      quitAndInstall: () => {
        void shell.openExternal(UPSTREAM_MERGE_URL)
      },
    },
    persistence: {
      get() {
        const value = store.get(key)
        if (!value || typeof value !== "object" || !("version" in value) || typeof value.version !== "string") return
        return { version: value.version } satisfies UpdaterReadyRecord
      },
      set: (value) => store.set(key, value),
      clear: () => store.delete(key),
    },
    stop: async () => undefined,
    log: (message, data) => logger.log(message, data),
  })
}

export async function showUpdaterDialog(controller: ReturnType<typeof setupAutoUpdater>, alertOnFail: boolean) {
  const state = await controller.check()
  if (state.status === "error") {
    if (!alertOnFail) return
    await dialog.showMessageBox({
      type: "error",
      message: nativeT("desktop.updater.dialog.checkFailed.message"),
      title: nativeT("desktop.updater.dialog.checkFailed.title"),
    })
    return
  }
  if (state.status === "up-to-date") {
    if (!alertOnFail) return
    await dialog.showMessageBox({
      type: "info",
      message: nativeT("desktop.updater.dialog.upToDate.message"),
      title: nativeT("desktop.updater.dialog.upToDate.title"),
    })
    return
  }
  if (state.status !== "ready") return

  const response = await dialog.showMessageBox({
    type: "info",
    message: nativeT("desktop.updater.dialog.merge.message", { version: state.version }),
    title: nativeT("desktop.updater.dialog.merge.title"),
    buttons: [nativeT("desktop.updater.dialog.merge.open"), nativeT("desktop.updater.dialog.later")],
    defaultId: 0,
    cancelId: 1,
  })
  if (response.response === 0) void shell.openExternal(UPSTREAM_MERGE_URL)
}

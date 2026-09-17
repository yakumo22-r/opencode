type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"
export const DESKTOP_APP_ID = "ai.opencode.desktop"
export const DESKTOP_APP_NAME = "OpenCode"

export const UPDATER_ENABLED = true
export const UPSTREAM_RELEASES_URL = "https://api.github.com/repos/anomalyco/opencode/releases/latest"
export const UPSTREAM_MERGE_URL = "https://github.com/yakumo22-r/opencode/compare/dev...anomalyco:opencode:dev"

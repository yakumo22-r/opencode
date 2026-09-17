import type { useServerSDK } from "@/context/server-sdk"
import type { Workflow } from "@opencode-ai/sdk/v2/client"

export function workflowClient(sdk: ReturnType<ReturnType<typeof useServerSDK>>): Workflow {
  return sdk.createClient({ throwOnError: true }).v2.workflow
}

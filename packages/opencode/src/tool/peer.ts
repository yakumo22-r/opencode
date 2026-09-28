import { Effect, Schema, Scope } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./peer.txt"
import { Peer } from "@/session/peer"
import { SessionID } from "@/session/schema"
import { InstanceState } from "@/effect/instance-state"
import { InstanceStore } from "@/project/instance-store"
import type { TaskPromptOps } from "./task"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

const id = "cooperate"

const Parameters = Schema.Struct({
  action: Schema.Literals(["create", "join", "kick", "context", "duty", "list", "send", "status", "receive", "configure"]).annotate({
    description: "create, join, kick, edit context, set duty, list members, send a task, read status, receive replies, or configure waiting",
  }),
  sessionID: Schema.optional(Schema.String).annotate({ description: "Member session for kick, duty, or send" }),
  teamID: Schema.optional(Schema.String).annotate({ description: "Cooperation id for join" }),
  title: Schema.optional(Schema.String).annotate({ description: "Cooperation title for create" }),
  systemDirectory: Schema.optional(Schema.String).annotate({ description: "Shared system directory. Defaults to this session's directory." }),
  context: Schema.optional(Schema.String).annotate({ description: "Shared task context" }),
  duty: Schema.optional(Schema.String).annotate({ description: "Responsibility to assign" }),
  prompt: Schema.optional(Schema.String).annotate({ description: "Task to assign" }),
  condition: Schema.optional(Schema.Literals(["all", "any", "count"])),
  count: Schema.optional(Schema.Number),
  mode: Schema.optional(Schema.Literals(["auto", "manual"])),
})

function textOf(result: SessionV1.WithParts) {
  if (result.info.role === "assistant" && result.info.error) {
    return "message" in result.info.error.data && typeof result.info.error.data.message === "string"
      ? result.info.error.data.message
      : result.info.error.name
  }
  return result.parts.findLast((item) => item.type === "text")?.text ?? ""
}

function output(result: Peer.Result) {
  if (result.error) return result.error
  return result.team ? Peer.renderTeam(result.team) : "No cooperation"
}

export const PeerTool = Tool.define(
  id,
  Effect.gen(function* () {
    const peers = yield* Peer.Service
    const instances = yield* InstanceStore.Service
    const scope = yield* Scope.Scope

    const run = Effect.fn("CooperateTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      if (params.action === "create") {
        const directory = params.systemDirectory || (yield* InstanceState.directory)
        const result = yield* peers.create({ sessionID: ctx.sessionID, title: params.title ?? "AI Agent cooperation", systemDirectory: directory, context: params.context })
        if (result.error) return yield* Effect.fail(new Error(result.error))
        return { title: "Cooperation created", metadata: {}, output: output(result) }
      }
      if (params.action === "join") {
        if (!params.teamID) return yield* Effect.fail(new Error("join requires teamID"))
        const result = yield* peers.join({ sessionID: ctx.sessionID, teamID: params.teamID })
        if (result.error) return yield* Effect.fail(new Error(result.error))
        return { title: "Joined cooperation", metadata: {}, output: output(result) }
      }
      if (params.action === "kick") {
        if (!params.sessionID) return yield* Effect.fail(new Error("kick requires sessionID"))
        const result = yield* peers.kick({ actorID: ctx.sessionID, sessionID: SessionID.make(params.sessionID) })
        if (result.error) return yield* Effect.fail(new Error(result.error))
        return { title: "Member removed", metadata: {}, output: output(result) }
      }
      if (params.action === "context") {
        const result = yield* peers.setContext({ actorID: ctx.sessionID, context: params.context ?? "" })
        if (result.error) return yield* Effect.fail(new Error(result.error))
        return { title: "Context updated", metadata: {}, output: output(result) }
      }
      if (params.action === "duty") {
        if (!params.sessionID) return yield* Effect.fail(new Error("duty requires sessionID"))
        const result = yield* peers.setDuty({ actorID: ctx.sessionID, sessionID: SessionID.make(params.sessionID), duty: params.duty ?? "" })
        if (result.error) return yield* Effect.fail(new Error(result.error))
        return { title: "Duty updated", metadata: {}, output: output(result) }
      }
      if (params.action === "list" || params.action === "status") {
        const result = yield* peers.current(ctx.sessionID)
        return { title: "Cooperation", metadata: {}, output: output(result) }
      }
      if (params.action === "configure") {
        const condition = params.condition === "count" ? { type: "count" as const, count: params.count ?? 1 } : params.condition ? { type: params.condition } : undefined
        const result = yield* peers.configure({ actorID: ctx.sessionID, condition, mode: params.mode })
        if (result.error) return yield* Effect.fail(new Error(result.error))
        return { title: "Wait updated", metadata: {}, output: output(result) }
      }
      if (params.action === "receive") {
        const result = yield* peers.receive(ctx.sessionID)
        if (result.error) return yield* Effect.fail(new Error(result.error))
        return { title: result.ready ? "Replies ready" : "Still waiting", metadata: {}, output: result.text ?? output(result) }
      }
      if (!params.sessionID || !params.prompt) return yield* Effect.fail(new Error("send requires sessionID and prompt"))
      yield* ctx.ask({ permission: id, patterns: [params.sessionID], always: ["*"], metadata: {} })
      const added = yield* peers.add({ actorID: ctx.sessionID, sessionID: SessionID.make(params.sessionID), prompt: params.prompt })
      if (added.error || !added.item || !added.team) return yield* Effect.fail(new Error(added.error ?? "Cannot assign task"))
      const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
      if (!ops) return yield* Effect.fail(new Error("cooperate requires promptOps"))
      const item = added.item
      const team = added.team
      const member = team.members.find((entry) => entry.sessionID === item.sessionID)
      const ownerDirectory = yield* InstanceState.directory
      yield* Effect.gen(function* () {
        const result = yield* instances.provide(
          { directory: item.directory },
          ops.prompt({
            sessionID: item.sessionID,
            parts: [{
              type: "text",
              text: [
                `[cooperate] You are in "${team.title}".`,
                `Duty: ${member?.duty || "unspecified"}`,
                `Your project directory: ${item.directory}`,
                `Shared system directory: ${team.systemDirectory}`,
                `Shared task context:\n${team.context || "(empty)"}`,
                "",
                `Assigned task:\n${item.prompt}`,
                "",
                "Reply in this session. Do not call cooperate.",
              ].join("\n"),
            }],
          }),
        )
        const failed = result.info.role === "assistant" && result.info.error
        const finished = yield* instances.provide(
          { directory: ownerDirectory },
          peers.finish({ teamID: team.id, itemID: item.id, status: failed ? "error" : "done", result: textOf(result) }),
        )
        if (!finished.shouldWake || !finished.text) return
        yield* instances.provide(
          { directory: ownerDirectory },
          ops.prompt({ sessionID: ctx.sessionID, parts: [{ type: "text", synthetic: true, text: finished.text }] }),
        )
      }).pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      return { title: `Assigned ${item.title}`, metadata: {}, output: `Queued ${item.id}. Do not poll.\n${Peer.renderTeam(team)}` }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

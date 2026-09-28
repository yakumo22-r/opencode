import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Layer, Context, Option, Schema } from "effect"
import { Session } from "./session"
import { SessionID } from "./schema"

const file = path.join(Global.Path.data, "cooperate.json")

export const Condition = Schema.Union([
  Schema.Struct({ type: Schema.Literal("all") }),
  Schema.Struct({ type: Schema.Literal("any") }),
  Schema.Struct({ type: Schema.Literal("count"), count: Schema.Number }),
]).annotate({ identifier: "PeerCondition" })
export type Condition = Schema.Schema.Type<typeof Condition>

export const Mode = Schema.Literals(["auto", "manual"]).annotate({ identifier: "PeerMode" })
export type Mode = Schema.Schema.Type<typeof Mode>

export const Member = Schema.Struct({
  sessionID: SessionID,
  directory: Schema.String,
  title: Schema.String,
  duty: Schema.String,
  admin: Schema.Boolean,
}).annotate({ identifier: "CooperateMember" })
export type Member = Schema.Schema.Type<typeof Member>

export const Item = Schema.Struct({
  id: Schema.String,
  sessionID: SessionID,
  directory: Schema.String,
  title: Schema.String,
  prompt: Schema.String,
  status: Schema.Literals(["pending", "done", "error"]),
  result: Schema.optional(Schema.String),
}).annotate({ identifier: "PeerItem" })
export type Item = Schema.Schema.Type<typeof Item>

export const Team = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  adminSessionID: SessionID,
  systemDirectory: Schema.String,
  context: Schema.String,
  members: Schema.Array(Member),
  condition: Condition,
  mode: Mode,
  locks: Schema.Struct({ condition: Schema.Boolean, mode: Schema.Boolean }),
  items: Schema.Array(Item),
  delivered: Schema.Boolean,
  createdAt: Schema.optional(Schema.Number),
  updatedAt: Schema.optional(Schema.Number),
  note: Schema.optional(Schema.String),
  archived: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "CooperateTeam" })
export type Team = Schema.Schema.Type<typeof Team>

export const Structure = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  title: Schema.String,
  note: Schema.optional(Schema.String),
  context: Schema.String,
  condition: Condition,
  mode: Mode,
  duties: Schema.Array(Schema.String),
  createdAt: Schema.Number,
}).annotate({ identifier: "CooperateStructure" })
export type Structure = Schema.Schema.Type<typeof Structure>

export const Result = Schema.Struct({
  team: Schema.optional(Team),
  teams: Schema.optional(Schema.Array(Team)),
  structures: Schema.optional(Schema.Array(Structure)),
  error: Schema.optional(Schema.String),
  shouldWake: Schema.Boolean,
  ready: Schema.optional(Schema.Boolean),
  text: Schema.optional(Schema.String),
}).annotate({ identifier: "CooperateResult" })
export type Result = Schema.Schema.Type<typeof Result>

const teams = new Map<string, Team>()
const structures = new Map<string, Structure>()
const membership = new Map<string, string>()

function blank(partial?: { shouldWake?: boolean; ready?: boolean; text?: string; error?: string; team?: Team; teams?: Team[]; structures?: Structure[] }): Result {
  return {
    shouldWake: partial?.shouldWake ?? false,
    teams: partial?.teams ?? [...teams.values()],
    structures: partial?.structures ?? [...structures.values()],
    ...(partial?.team ? { team: partial.team } : {}),
    ...(partial?.error ? { error: partial.error } : {}),
    ...(partial?.ready !== undefined ? { ready: partial.ready } : {}),
    ...(partial?.text ? { text: partial.text } : {}),
  }
}

export function satisfied(team: Team) {
  if (!team.items.length) return false
  const finished = team.items.filter((item) => item.status !== "pending").length
  if (team.condition.type === "any") return finished > 0
  if (team.condition.type === "count") return finished >= team.condition.count
  return team.items.every((item) => item.status !== "pending")
}

export function renderTeam(team: Team) {
  const members = team.members.map((member) => `- ${member.admin ? "admin" : "member"} ${member.title} duty=${member.duty || "-"} project=${member.directory} session=${member.sessionID}`)
  const items = team.items.map((item) => `- ${item.title} [${item.status}] ${item.result?.trim() || item.prompt}`)
  return [
    `Cooperation ${team.title} (${team.id})`,
    `Admin: ${team.adminSessionID}`,
    `System directory: ${team.systemDirectory}`,
    `Context:\n${team.context || "(empty)"}`,
    "Members:",
    ...members,
    `Wait ${team.mode} ${team.condition.type}${team.condition.type === "count" ? ` ${team.condition.count}` : ""}`,
    ...items,
  ].join("\n")
}

function save(team: Team) {
  const now = Date.now()
  const next = { ...team, createdAt: team.createdAt ?? now, updatedAt: now }
  teams.set(next.id, next)
  for (const member of next.members) membership.set(member.sessionID, next.id)
  return next
}

function teamFor(input: { actorID: string; teamID?: string }) {
  if (input.teamID) return teams.get(input.teamID)
  return teamOf(input.actorID)
}

function denied(team: Team, input: { actorID: string; human?: boolean }) {
  if (input.human) return false
  return team.adminSessionID !== input.actorID
}

function teamOf(sessionID: string) {
  const id = membership.get(sessionID)
  return id ? teams.get(id) : undefined
}

function claim(team: Team) {
  if (!satisfied(team) || team.delivered) return { team, shouldWake: false as const }
  const next = { ...team, delivered: true }
  return { team: next, shouldWake: true as const, text: renderTeam(next) }
}

export interface Interface {
  readonly current: (sessionID: SessionID) => Effect.Effect<Result>
  readonly invite: (input: { actorID: SessionID; sessionID: SessionID }) => Effect.Effect<Result>
  readonly create: (input: { sessionID: SessionID; title: string; systemDirectory: string; context?: string; note?: string; condition?: Condition; mode?: Mode; duty?: string }) => Effect.Effect<Result>
  readonly join: (input: { sessionID: SessionID; teamID: string }) => Effect.Effect<Result>
  readonly kick: (input: { actorID: SessionID; sessionID: SessionID; teamID?: string; human?: boolean }) => Effect.Effect<Result>
  readonly drop: (input: { actorID: SessionID; teamID?: string; human?: boolean }) => Effect.Effect<Result>
  readonly setNote: (input: { actorID: SessionID; teamID?: string; human?: boolean; note: string }) => Effect.Effect<Result>
  readonly archive: (input: { actorID: SessionID; teamID?: string; human?: boolean; archived: boolean }) => Effect.Effect<Result>
  readonly setContext: (input: { actorID: SessionID; context: string; teamID?: string; human?: boolean }) => Effect.Effect<Result>
  readonly setDuty: (input: { actorID: SessionID; sessionID: SessionID; duty: string; teamID?: string; human?: boolean }) => Effect.Effect<Result>
  readonly configure: (input: { actorID: SessionID; condition?: Condition; mode?: Mode; lock?: boolean; teamID?: string; human?: boolean }) => Effect.Effect<Result>
  readonly add: (input: { actorID: SessionID; sessionID: SessionID; prompt: string }) => Effect.Effect<Result & { item?: Item }>
  readonly finish: (input: { teamID: string; itemID: string; status: "done" | "error"; result: string }) => Effect.Effect<Result>
  readonly receive: (sessionID: SessionID) => Effect.Effect<Result>
  readonly remove: (input: { actorID: SessionID; itemID: string; teamID?: string; human?: boolean }) => Effect.Effect<Result>
  readonly saveStructure: (input: { actorID: SessionID; teamID?: string; human?: boolean; name?: string }) => Effect.Effect<Result>
  readonly removeStructure: (id: string) => Effect.Effect<Result>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Peer") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const fs = yield* FSUtil.Service
    const decodeStored = Schema.decodeUnknownOption(
      Schema.Union([
        Schema.Array(Team),
        Schema.Struct({
          teams: Schema.Array(Team),
          structures: Schema.optional(Schema.Array(Structure)),
        }),
      ]),
    )

    const load = Effect.fn("Cooperate.load")(function* () {
      const data = yield* fs.readJson(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const stored = data ? Option.getOrUndefined(decodeStored(data)) : undefined
      const storedTeams = Array.isArray(stored) ? stored : (stored?.teams ?? [])
      const storedStructures = Array.isArray(stored) ? [] : (stored?.structures ?? [])
      teams.clear()
      structures.clear()
      membership.clear()
      for (const team of storedTeams) save(team)
      for (const structure of storedStructures) structures.set(structure.id, structure)
    })

    const persist = Effect.fn("Cooperate.persist")(function* () {
      yield* fs.writeJson(file, { teams: [...teams.values()], structures: [...structures.values()] }).pipe(Effect.orDie)
    })

    yield* load()

    const memberFrom = Effect.fn("Cooperate.member")(function* (sessionID: SessionID, admin: boolean, duty = "") {
      const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
      return { sessionID: session.id, directory: session.directory, title: session.title, duty, admin }
    })

    const current = Effect.fn("Cooperate.current")(function* (sessionID: SessionID) {
      return blank({ team: teamOf(sessionID) })
    })

    const create = Effect.fn("Cooperate.create")(function* (input: { sessionID: SessionID; title: string; systemDirectory: string; context?: string; note?: string; condition?: Condition; mode?: Mode; duty?: string }) {
      if (teamOf(input.sessionID)) return blank({ error: "This session is already in a cooperation", team: teamOf(input.sessionID) })
      const admin = yield* memberFrom(input.sessionID, true, input.duty || "统筹分配任务")
      const team: Team = {
        id: crypto.randomUUID(),
        title: input.title || "AI Agent cooperation",
        adminSessionID: admin.sessionID,
        systemDirectory: input.systemDirectory || admin.directory,
        context: input.context ?? "",
        note: input.note,
        members: [admin],
        condition: input.condition ?? { type: "all" },
        mode: input.mode ?? "manual",
        locks: { condition: false, mode: false },
        items: [],
        delivered: false,
      }
      const saved = save(team)
      yield* persist()
      return blank({ team: saved })
    })

    const join = Effect.fn("Cooperate.join")(function* (input: { sessionID: SessionID; teamID: string }) {
      const team = teams.get(input.teamID)
      if (!team) return blank({ error: "Cooperation not found" })
      if (team.members.some((member) => member.sessionID === input.sessionID)) return blank({ team })
      if (teamOf(input.sessionID)) return blank({ error: "This session is already in another cooperation" })
      const member = yield* memberFrom(input.sessionID, false)
      const next = save({ ...team, members: [...team.members, member] })
      yield* persist()
      return blank({ team: next })
    })

    const invite = Effect.fn("Cooperate.invite")(function* (input: { actorID: SessionID; sessionID: SessionID; teamID?: string; human?: boolean }) {
      const team = teamFor(input)
      if (!team) return blank({ error: "No cooperation" })
      if (denied(team, input)) return blank({ error: "Only the admin session can add a member", team })
      if (team.members.some((member) => member.sessionID === input.sessionID)) return blank({ team })
      if (teamOf(input.sessionID)) return blank({ error: "That session is already in a cooperation", team })
      const member = yield* memberFrom(input.sessionID, false)
      const next = save({ ...team, members: [...team.members, member] })
      yield* persist()
      return blank({ team: next })
    })

    const kick = Effect.fn("Cooperate.kick")(function* (input: { actorID: SessionID; sessionID: SessionID; teamID?: string; human?: boolean }) {
      const team = teamFor(input)
      if (!team) return blank({ error: "No cooperation" })
      if (denied(team, input)) return blank({ error: "Only the admin session can remove a member", team })
      if (input.sessionID === team.adminSessionID) return blank({ error: "Cannot remove the admin session", team })
      membership.delete(input.sessionID)
      const next = save({ ...team, members: team.members.filter((member) => member.sessionID !== input.sessionID) })
      yield* persist()
      return blank({ team: next })
    })

    const drop = Effect.fn("Cooperate.drop")(function* (input: { actorID: SessionID; teamID?: string; human?: boolean }) {
      const team = teamFor(input)
      if (!team) return blank({ error: "No cooperation" })
      if (denied(team, input)) return blank({ error: "Only the admin session can delete this cooperation", team })
      for (const member of team.members) membership.delete(member.sessionID)
      teams.delete(team.id)
      yield* persist()
      return blank()
    })

    const setNote = Effect.fn("Cooperate.note")(function* (input: { actorID: SessionID; teamID?: string; human?: boolean; note: string }) {
      const team = teamFor(input)
      if (!team) return blank({ error: "No cooperation" })
      if (denied(team, input)) return blank({ error: "Only the admin session can edit the note", team })
      const next = save({ ...team, note: input.note })
      yield* persist()
      return blank({ team: next })
    })

    const archive = Effect.fn("Cooperate.archive")(function* (input: { actorID: SessionID; teamID?: string; human?: boolean; archived: boolean }) {
      const team = teamFor(input)
      if (!team) return blank({ error: "No cooperation" })
      if (denied(team, input)) return blank({ error: "Only the admin session can archive this cooperation", team })
      const next = save({ ...team, archived: input.archived })
      yield* persist()
      return blank({ team: next })
    })

    const setContext = Effect.fn("Cooperate.context")(function* (input: { actorID: SessionID; context: string; teamID?: string; human?: boolean }) {
      const team = teamFor(input)
      if (!team) return blank({ error: "No cooperation" })
      if (denied(team, input)) return blank({ error: "Only the admin session can edit the task context", team })
      const next = save({ ...team, context: input.context })
      yield* persist()
      return blank({ team: next })
    })

    const setDuty = Effect.fn("Cooperate.duty")(function* (input: { actorID: SessionID; sessionID: SessionID; duty: string; teamID?: string; human?: boolean }) {
      const team = teamFor(input)
      if (!team) return blank({ error: "No cooperation" })
      if (denied(team, input)) return blank({ error: "Only the admin session can assign duties", team })
      const next = save({
        ...team,
        members: team.members.map((member) => (member.sessionID === input.sessionID ? { ...member, duty: input.duty } : member)),
      })
      yield* persist()
      return blank({ team: next })
    })

    const configure = Effect.fn("Cooperate.configure")(function* (input: { actorID: SessionID; condition?: Condition; mode?: Mode; lock?: boolean; teamID?: string; human?: boolean }) {
      const team = teamFor(input)
      if (!team) return blank({ error: "No cooperation" })
      const condition = !input.condition || (input.lock !== true && team.locks.condition) ? team.condition : input.condition
      const mode = !input.mode || (input.lock !== true && team.locks.mode) ? team.mode : input.mode
      const next = {
        ...team,
        condition,
        mode,
        locks: input.lock
          ? { condition: input.condition ? true : team.locks.condition, mode: input.mode ? true : team.locks.mode }
          : team.locks,
      }
      const claimed = next.mode === "auto" ? claim(next) : { team: next, shouldWake: false as const }
      save(claimed.team)
      yield* persist()
      return blank(claimed)
    })

    const add = Effect.fn("Cooperate.add")(function* (input: { actorID: SessionID; sessionID: SessionID; prompt: string }) {
      const team = teamOf(input.actorID)
      if (!team) return blank({ error: "No cooperation" })
      if (team.adminSessionID !== input.actorID) return blank({ error: "Only the admin session can assign tasks", team })
      const target = team.members.find((member) => member.sessionID === input.sessionID)
      if (!target) return blank({ error: "Target session is not in this cooperation", team })
      const item: Item = {
        id: crypto.randomUUID(),
        sessionID: target.sessionID,
        directory: target.directory,
        title: target.title,
        prompt: input.prompt,
        status: "pending",
      }
      const next = save({ ...team, delivered: false, items: [...team.items, item] })
      yield* persist()
      return { ...blank({ team: next }), item }
    })

    const finish = Effect.fn("Cooperate.finish")(function* (input: { teamID: string; itemID: string; status: "done" | "error"; result: string }) {
      const team = teams.get(input.teamID)
      if (!team) return blank({ error: "Cooperation not found" })
      const items = team.items.map((item) => (item.id === input.itemID ? { ...item, status: input.status, result: input.result } : item))
      const claimed = claim({ ...team, items })
      if (claimed.team.mode !== "auto") {
        const next = save({ ...team, items })
        yield* persist()
        return blank({ team: next })
      }
      save(claimed.team)
      yield* persist()
      return blank(claimed)
    })

    const receive = Effect.fn("Cooperate.receive")(function* (sessionID: SessionID) {
      const team = teamOf(sessionID)
      if (!team) return blank({ error: "No cooperation" })
      if (!satisfied(team)) return blank({ team, ready: false })
      const text = renderTeam(team)
      if (!team.delivered) {
        save({ ...team, delivered: true })
        yield* persist()
      }
      return blank({ team: { ...team, delivered: true }, ready: true, text })
    })

    const remove = Effect.fn("Cooperate.remove")(function* (input: { actorID: SessionID; itemID: string; teamID?: string; human?: boolean }) {
      const team = teamFor(input)
      if (!team) return blank({ error: "No cooperation" })
      const next = save({ ...team, items: team.items.filter((item) => item.id !== input.itemID) })
      yield* persist()
      return blank({ team: next })
    })

    const saveStructure = Effect.fn("Cooperate.saveStructure")(function* (input: { actorID: SessionID; teamID?: string; human?: boolean; name?: string }) {
      const team = teamFor(input)
      if (!team) return blank({ error: "No cooperation" })
      const structure: Structure = {
        id: crypto.randomUUID(),
        name: input.name || team.title,
        title: team.title,
        note: team.note,
        context: team.context,
        condition: team.condition,
        mode: team.mode,
        duties: team.members.map((member) => member.duty).filter((duty) => duty.length > 0),
        createdAt: Date.now(),
      }
      structures.set(structure.id, structure)
      yield* persist()
      return blank({ team })
    })

    const removeStructure = Effect.fn("Cooperate.removeStructure")(function* (id: string) {
      structures.delete(id)
      yield* persist()
      return blank()
    })

    return Service.of({ current, create, join, invite, kick, drop, setNote, archive, setContext, setDuty, configure, add, finish, receive, remove, saveStructure, removeStructure })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Session.node, FSUtil.node],
})

export * as Peer from "./peer"

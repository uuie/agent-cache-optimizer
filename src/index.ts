/**
 * agent-cache-optimizer — OpenCode Plugin Entry Point
 *
 * Content-agnostic KV cache optimizer.  Reorders system prompt blocks so
 * that stable content comes FIRST and dynamic content comes LAST,
 * maximizing prefix-match cache reuse across sessions.
 *
 * @license MIT
 */

const VERSION = "0.6.0"

import type { Plugin } from "@opencode-ai/plugin"
import { join } from "node:path"
import { homedir } from "node:os"
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import {
  emptyDB,
  updateDB,
  updateContentDB,
  extractWarmHashes,
  estimateSavings,
  hashContent,
  lookupContentScore,
} from "./core"
import { classify } from "./heuristics"
import { splitAll } from "./splitting"
import type { StabilityDB } from "./types"

// ── Persistence ──────────────────────────────────────────────────────

const STATE_DIR = join(
  process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
  "opencode",
  "agent-cache-optimizer",
)

interface ModelIdentity {
  id?: string
  modelID?: string
  providerID?: string
  name?: string
}

function scopePart(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : fallback
}

function modelScope(model: ModelIdentity | undefined, agent?: string): string {
  const provider = scopePart(model?.providerID, "unknown-provider")
  const modelID = scopePart(model?.id ?? model?.modelID ?? model?.name, "unknown-model")
  if (provider === "unknown-provider" && modelID === "unknown-model") return "default"
  const normalizedAgent = agent?.trim()
  return normalizedAgent ? `${provider}__${modelID}__${normalizedAgent}` : `${provider}__${modelID}`
}

function dbPath(scope: string): string {
  const safe = scope.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "default"
  return join(STATE_DIR, `stability-${safe}.json`)
}

function warmCachePath(): string {
  return join(STATE_DIR, "warm-cache.json")
}

function cacheMetricsPath(): string {
  return join(STATE_DIR, "cache-metrics.json")
}

function eventsPath(): string {
  return join(STATE_DIR, "events.jsonl")
}

function loadDB(scope: string): StabilityDB {
  try {
    const raw = readFileSync(dbPath(scope), "utf-8")
    const db = JSON.parse(raw) as StabilityDB
    // Migrate from pre-0.5.0: rebuild contentIndex from position data
    // Migrate from pre-0.5.x: ensure contentObservations exists
    if (db.contentObservations === undefined || db.contentObservations === null) {
      // Reset contentIndex — old position-based counts don't map cleanly
      db.contentIndex = {}
      db.contentScores = {}
      db.contentObservations = 0
      saveDB(scope, db)
    }
    return db
  } catch {
    return emptyDB()
  }
}

function saveDB(scope: string, db: StabilityDB): void {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
    db.updated = Date.now()
    writeFileSync(dbPath(scope), JSON.stringify(db, null, 2))
  } catch (error) {
    logError(scope, "save_db", error)
  }
}

// ── Session scope tracking ───────────────────────────────────────────

interface ScopeContext {
  scope: string
  familyScope: string
}

const sessionScopes = new Map<string, ScopeContext>()

function familyScope(model: ModelIdentity | undefined): string {
  return modelScope(model)
}

function scopeContext(model: ModelIdentity | undefined, agent?: string): ScopeContext {
  const scope = modelScope(model, agent)
  const modelFamily = familyScope(model)
  return {
    scope,
    familyScope: modelFamily === "default" ? scope : modelFamily,
  }
}

function rememberSessionScope(
  sessionID: string | undefined,
  model: ModelIdentity | undefined,
  agent?: string,
): string {
  const context = scopeContext(model, agent)
  if (sessionID) sessionScopes.set(sessionID, context)
  return context.scope
}

function scopeForSession(sessionID: string | undefined, model: ModelIdentity | undefined): string {
  if (sessionID) {
    const known = sessionScopes.get(sessionID)
    if (known) return known.scope
  }
  return scopeContext(model).scope
}

function familyScopeForSession(
  sessionID: string | undefined,
  model: ModelIdentity | undefined,
): string {
  if (sessionID) {
    const known = sessionScopes.get(sessionID)
    if (known) return known.familyScope
  }
  return scopeContext(model).familyScope
}

// ── Cache warming ────────────────────────────────────────────────────

interface WarmCacheStore {
  version: 2
  global: string[]
  scopes: Record<string, string[]>
}

interface WarmCacheMemory {
  global: Set<string>
  scopes: Map<string, Set<string>>
}

let warmCache: WarmCacheMemory = { global: new Set(), scopes: new Map() }
let warmHashesLoaded = false

function loadWarmCache(): WarmCacheMemory {
  if (warmHashesLoaded) return warmCache
  warmHashesLoaded = true
  try {
    const raw = readFileSync(warmCachePath(), "utf-8")
    const parsed = JSON.parse(raw) as string[] | WarmCacheStore
    if (Array.isArray(parsed)) {
      warmCache = { global: new Set(parsed), scopes: new Map() }
    } else {
      warmCache = {
        global: new Set(parsed.global ?? []),
        scopes: new Map(
          Object.entries(parsed.scopes ?? {}).map(([scope, hashes]) => [scope, new Set(hashes)]),
        ),
      }
    }
    return warmCache
  } catch {
    return warmCache
  }
}

function warmHashesForScope(scope: string): Set<string> | undefined {
  const scoped = warmCache.scopes.get(scope)
  const hashes = new Set<string>(warmCache.global)
  for (const hash of scoped ?? []) hashes.add(hash)
  return hashes.size > 0 ? hashes : undefined
}

function saveWarmCache(scope: string, db: StabilityDB): void {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
    warmCache.scopes.set(scope, extractWarmHashes(db))

    const counts = new Map<string, number>()
    for (const hashes of warmCache.scopes.values()) {
      for (const hash of hashes) counts.set(hash, (counts.get(hash) ?? 0) + 1)
    }
    warmCache.global = new Set(
      [...counts.entries()].filter(([, count]) => count >= 2).map(([hash]) => hash),
    )

    const store: WarmCacheStore = {
      version: 2,
      global: [...warmCache.global].sort(),
      scopes: Object.fromEntries(
        [...warmCache.scopes.entries()]
          .filter(([, hashes]) => hashes.size > 0)
          .map(([scopeName, hashes]) => [scopeName, [...hashes].sort()]),
      ),
    }
    writeFileSync(warmCachePath(), JSON.stringify(store, null, 2))
    eventLog("warm_cache_update", scope, {
      scopedHashCount: store.scopes[scope]?.length ?? 0,
      globalHashCount: store.global.length,
      scopeCount: Object.keys(store.scopes).length,
      observations: db.observations,
    })
  } catch (error) {
    logError(scope, "save_warm_cache", error)
  }
}

// ── Savings tracking ────────────────────────────────────────────────

function savingsPath(): string {
  return join(STATE_DIR, "savings.json")
}

interface SavingsData {
  totalStableBytes: number
  totalObservations: number
  estimatedSavingsUSD: number
  updated: number
}

function loadSavings(): SavingsData {
  try {
    return JSON.parse(readFileSync(savingsPath(), "utf-8")) as SavingsData
  } catch {
    return { totalStableBytes: 0, totalObservations: 0, estimatedSavingsUSD: 0, updated: 0 }
  }
}

function saveSavings(data: SavingsData): void {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
    data.updated = Date.now()
    writeFileSync(savingsPath(), JSON.stringify(data, null, 2))
  } catch (error) {
    logError("global", "save_savings", error)
  }
}

// ── Provider cache metrics ───────────────────────────────────────────

interface CacheMetricSnapshot {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUSD: number
}

interface CacheMetricTotals extends CacheMetricSnapshot {
  events: number
  cacheHitRate: number
}

interface CacheMetricsData {
  total: CacheMetricTotals
  scopes: Record<string, CacheMetricTotals>
  snapshots: Record<string, CacheMetricSnapshot>
  updated: number
}

function isMetricSnapshotIDSafe(value: string): boolean {
  return value === "unknown" || /^[a-f0-9]{16}$/.test(value)
}

function metricSnapshotPart(value: unknown): string {
  return hashID(value) ?? "unknown"
}

function metricSnapshotKey(
  source: "message" | "step",
  sessionID: unknown,
  itemID: unknown,
): string {
  return `${source}:${metricSnapshotPart(sessionID)}:${metricSnapshotPart(itemID)}`
}

function normalizeMetricSnapshotKey(key: string): string {
  const match = /^(message|step):([^:]+):([^:]+)$/.exec(key)
  if (!match) return key
  const source = match[1] as "message" | "step"
  const sessionID = match[2]!
  const itemID = match[3]!
  const safeSessionID = isMetricSnapshotIDSafe(sessionID) ? sessionID : hashContent(sessionID)
  const safeItemID = isMetricSnapshotIDSafe(itemID) ? itemID : hashContent(itemID)
  return `${source}:${safeSessionID}:${safeItemID}`
}

function normalizeMetricSnapshots(
  snapshots: Record<string, CacheMetricSnapshot> | undefined,
): Record<string, CacheMetricSnapshot> {
  const normalized: Record<string, CacheMetricSnapshot> = {}
  for (const [key, snapshot] of Object.entries(snapshots ?? {})) {
    normalized[normalizeMetricSnapshotKey(key)] = snapshot
  }
  return normalized
}

function sameKeys(
  left: Record<string, CacheMetricSnapshot> | undefined,
  right: Record<string, CacheMetricSnapshot>,
): boolean {
  const leftKeys = Object.keys(left ?? {}).sort()
  const rightKeys = Object.keys(right).sort()
  return (
    leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index])
  )
}

function emptyMetricTotals(): CacheMetricTotals {
  return {
    events: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUSD: 0,
    cacheHitRate: 0,
  }
}

function computeCacheHitRate(inputTokens: number, cacheReadTokens: number): number {
  const promptTokens = inputTokens + cacheReadTokens
  return promptTokens > 0 ? cacheReadTokens / promptTokens : 0
}

function refreshCacheHitRate(total: CacheMetricTotals): boolean {
  const next = computeCacheHitRate(total.inputTokens, total.cacheReadTokens)
  const changed = total.cacheHitRate !== next
  total.cacheHitRate = next
  return changed
}

function loadCacheMetrics(): CacheMetricsData {
  try {
    const parsed = JSON.parse(readFileSync(cacheMetricsPath(), "utf-8")) as CacheMetricsData
    const snapshots = normalizeMetricSnapshots(parsed.snapshots)
    const data: CacheMetricsData = {
      total: parsed.total ?? emptyMetricTotals(),
      scopes: parsed.scopes ?? {},
      snapshots,
      updated: parsed.updated ?? 0,
    }
    let changed = !sameKeys(parsed.snapshots, snapshots)
    changed = refreshCacheHitRate(data.total) || changed
    for (const total of Object.values(data.scopes)) {
      changed = refreshCacheHitRate(total) || changed
    }
    if (changed) {
      data.updated = Date.now()
      writeFileSync(cacheMetricsPath(), JSON.stringify(data, null, 2))
    }
    return data
  } catch {
    return { total: emptyMetricTotals(), scopes: {}, snapshots: {}, updated: 0 }
  }
}

function applyMetricDelta(total: CacheMetricTotals, delta: CacheMetricSnapshot): void {
  total.events++
  total.inputTokens += delta.inputTokens
  total.outputTokens += delta.outputTokens
  total.cacheReadTokens += delta.cacheReadTokens
  total.cacheWriteTokens += delta.cacheWriteTokens
  total.costUSD += delta.costUSD
  refreshCacheHitRate(total)
}

function positiveDelta(current: number, previous: number | undefined): number {
  return Math.max(0, current - (previous ?? 0))
}

function saveCacheMetrics(
  scope: string,
  key: string,
  current: CacheMetricSnapshot,
): CacheMetricsData {
  const data = loadCacheMetrics()
  const previous = data.snapshots[key]
  const delta: CacheMetricSnapshot = {
    inputTokens: positiveDelta(current.inputTokens, previous?.inputTokens),
    outputTokens: positiveDelta(current.outputTokens, previous?.outputTokens),
    cacheReadTokens: positiveDelta(current.cacheReadTokens, previous?.cacheReadTokens),
    cacheWriteTokens: positiveDelta(current.cacheWriteTokens, previous?.cacheWriteTokens),
    costUSD: positiveDelta(current.costUSD, previous?.costUSD),
  }

  if (
    delta.inputTokens === 0 &&
    delta.outputTokens === 0 &&
    delta.cacheReadTokens === 0 &&
    delta.cacheWriteTokens === 0 &&
    delta.costUSD === 0
  ) {
    return data
  }

  data.snapshots[key] = current
  applyMetricDelta(data.total, delta)
  data.scopes[scope] ??= emptyMetricTotals()
  applyMetricDelta(data.scopes[scope], delta)
  data.updated = Date.now()

  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(cacheMetricsPath(), JSON.stringify(data, null, 2))
  } catch (error) {
    logError(scope, "save_cache_metrics", error)
  }
  return data
}

function metricSnapshotFromTokens(tokens: any, cost: unknown): CacheMetricSnapshot | null {
  if (!tokens || typeof tokens !== "object") return null
  const inputTokens = Number(tokens.input ?? 0)
  const outputTokens = Number(tokens.output ?? 0)
  const cacheReadTokens = Number(tokens.cache?.read ?? 0)
  const cacheWriteTokens = Number(tokens.cache?.write ?? 0)
  const costUSD = Number(cost ?? 0)
  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    cacheReadTokens === 0 &&
    cacheWriteTokens === 0 &&
    costUSD === 0
  ) {
    return null
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUSD }
}

function recordCacheMetricFromEvent(event: any): void {
  if (event?.type === "session.next.step.started") {
    const props = event.properties
    rememberSessionScope(props?.sessionID, props?.model, props?.agent)
    return
  }

  if (event?.type === "message.updated") {
    const info = event.properties?.info
    if (info?.role !== "assistant") return
    const snapshot = metricSnapshotFromTokens(info.tokens, info.cost)
    if (!snapshot) return
    const scope =
      info.agent && info.providerID && info.modelID
        ? modelScope({ providerID: info.providerID, modelID: info.modelID }, info.agent)
        : scopeForSession(info.sessionID, { providerID: info.providerID, modelID: info.modelID })
    const key = metricSnapshotKey("message", info.sessionID, info.id)
    const previous = loadCacheMetrics().snapshots[key]
    const data = saveCacheMetrics(scope, key, snapshot)
    const delta = metricDelta(snapshot, previous)
    if (isZeroMetricDelta(delta)) return
    diag(
      scope,
      `metrics input:${data.scopes[scope]?.inputTokens ?? 0} ` +
        `cacheRead:${data.scopes[scope]?.cacheReadTokens ?? 0} ` +
        `cacheWrite:${data.scopes[scope]?.cacheWriteTokens ?? 0} ` +
        `hitRate:${((data.scopes[scope]?.cacheHitRate ?? 0) * 100).toFixed(1)}%`,
    )
    eventLog("metrics", scope, {
      sessionHash: hashID(info.sessionID),
      messageHash: hashID(info.id),
      source: "message.updated",
      delta,
      totals: data.scopes[scope] ?? emptyMetricTotals(),
    })
    return
  }

  if (event?.type === "session.next.step.ended") {
    const props = event.properties
    const snapshot = metricSnapshotFromTokens(props?.tokens, props?.cost)
    if (!snapshot) return
    const scope = scopeForSession(props?.sessionID, undefined)
    const key = metricSnapshotKey("step", props?.sessionID, props?.assistantMessageID ?? event.id)
    const previous = loadCacheMetrics().snapshots[key]
    const data = saveCacheMetrics(scope, key, snapshot)
    const delta = metricDelta(snapshot, previous)
    if (isZeroMetricDelta(delta)) return
    diag(
      scope,
      `metrics input:${data.scopes[scope]?.inputTokens ?? 0} ` +
        `cacheRead:${data.scopes[scope]?.cacheReadTokens ?? 0} ` +
        `cacheWrite:${data.scopes[scope]?.cacheWriteTokens ?? 0} ` +
        `hitRate:${((data.scopes[scope]?.cacheHitRate ?? 0) * 100).toFixed(1)}%`,
    )
    eventLog("metrics", scope, {
      sessionHash: hashID(props?.sessionID),
      messageHash: hashID(props?.assistantMessageID ?? event.id),
      source: "session.next.step.ended",
      delta,
      totals: data.scopes[scope] ?? emptyMetricTotals(),
    })
  }
}

function metricDelta(
  current: CacheMetricSnapshot,
  previous: CacheMetricSnapshot | undefined,
): CacheMetricSnapshot {
  return {
    inputTokens: positiveDelta(current.inputTokens, previous?.inputTokens),
    outputTokens: positiveDelta(current.outputTokens, previous?.outputTokens),
    cacheReadTokens: positiveDelta(current.cacheReadTokens, previous?.cacheReadTokens),
    cacheWriteTokens: positiveDelta(current.cacheWriteTokens, previous?.cacheWriteTokens),
    costUSD: positiveDelta(current.costUSD, previous?.costUSD),
  }
}

function isZeroMetricDelta(delta: CacheMetricSnapshot): boolean {
  return (
    delta.inputTokens === 0 &&
    delta.outputTokens === 0 &&
    delta.cacheReadTokens === 0 &&
    delta.cacheWriteTokens === 0 &&
    delta.costUSD === 0
  )
}

// ── Diagnostics ──────────────────────────────────────────────────────

const MAX_DIAG_LINES = 1000
const MAX_DIAG_BYTES = 50 * 1024 // 50KB
const MAX_EVENT_LINES = 5000
const MAX_EVENT_BYTES = 512 * 1024 // 512KB
const DB_PRUNE_INTERVAL = 100 // prune every N observations
const DB_STALE_DAYS = 7

const loadedScopes = new Set<string>()

function diag(scope: string, msg: string): void {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
    const ts = new Date().toISOString()
    writeFileSync(join(STATE_DIR, "diag.log"), `[${ts}] [${scope}] ${msg}\n`, { flag: "a" })
  } catch {
    /* silent */
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function logError(scope: string, operation: string, error: unknown): void {
  eventLog("error", scope, {
    operation,
    message: errorMessage(error),
  })
}

function hashID(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined
  return hashContent(value)
}

function eventLog(type: string, scope: string, data: Record<string, unknown> = {}): void {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
    rotateLineLog(eventsPath(), MAX_EVENT_BYTES, MAX_EVENT_LINES)
    const event = {
      ts: new Date().toISOString(),
      version: VERSION,
      type,
      scope,
      ...data,
    }
    writeFileSync(eventsPath(), `${JSON.stringify(event)}\n`, { flag: "a" })
  } catch {
    /* best-effort */
  }
}

// ── Disk management ──────────────────────────────────────────────────

function rotateLineLog(path: string, maxBytes: number, maxLines: number): void {
  try {
    if (!existsSync(path)) return
    const content = readFileSync(path, "utf-8")
    if (content.length < maxBytes) return
    const lines = content.split("\n").filter(Boolean)
    if (lines.length <= maxLines) return
    writeFileSync(path, lines.slice(-maxLines).join("\n") + "\n")
  } catch {
    /* best-effort */
  }
}

function rotateDiagLog(): void {
  rotateLineLog(join(STATE_DIR, "diag.log"), MAX_DIAG_BYTES, MAX_DIAG_LINES)
}

function pruneStaleHashes(db: StabilityDB): void {
  const now = Date.now()
  const staleMs = DB_STALE_DAYS * 24 * 60 * 60 * 1000
  // Prune contentIndex: remove hashes not seen in STALE_DAYS with low count
  for (const [hash, fp] of Object.entries(db.contentIndex)) {
    if (now - fp.lastSeen > staleMs && fp.count <= 2) {
      delete db.contentIndex[hash]
      delete db.contentScores[hash]
    }
  }
  // Prune position hashes similarly
  for (const fps of Object.values(db.positions)) {
    for (let i = fps.length - 1; i >= 0; i--) {
      const fp = fps[i]!
      if (now - fp.lastSeen > staleMs && fp.count <= 2) {
        delete db.scores[fp.hash]
        fps.splice(i, 1)
      }
    }
  }
}

// ── Cross-agent stable prefix ranking ────────────────────────────────

interface WarmHashMembership {
  global: Set<string>
  scoped: Set<string>
  family: Set<string>
}

interface StableRanking {
  sharedStable: string[]
  scopedStable: string[]
  coldStable: string[]
  dynamic: string[]
}

function classificationWarmHashes(membership: WarmHashMembership): Set<string> {
  const hashes = new Set<string>(membership.global)
  for (const hash of membership.scoped) hashes.add(hash)
  return hashes
}

function warmMembershipForScope(scope: string, familyDB: StabilityDB): WarmHashMembership {
  const cache = loadWarmCache()
  return {
    global: cache.global,
    scoped: cache.scopes.get(scope) ?? new Set(),
    family: extractWarmHashes(familyDB),
  }
}

function hasStableContentScore(db: StabilityDB, hash: string): boolean {
  const score = lookupContentScore(db, hash)
  return db.contentObservations >= 2 && score !== null && score >= 0.7
}

function rankStableBlocks(
  stableBlocks: string[],
  dynamicBlocks: string[],
  scopeDB: StabilityDB,
  familyDB: StabilityDB,
  warmMembership: WarmHashMembership,
): StableRanking {
  const ranking: StableRanking = {
    sharedStable: [],
    scopedStable: [],
    coldStable: [],
    dynamic: dynamicBlocks,
  }

  for (const block of stableBlocks) {
    const hash = hashContent(block)
    if (
      warmMembership.global.has(hash) ||
      warmMembership.family.has(hash) ||
      hasStableContentScore(familyDB, hash)
    ) {
      ranking.sharedStable.push(block)
      continue
    }

    if (warmMembership.scoped.has(hash) || hasStableContentScore(scopeDB, hash)) {
      ranking.scopedStable.push(block)
      continue
    }

    ranking.coldStable.push(block)
  }

  return ranking
}

// ── Plugin ───────────────────────────────────────────────────────────

export const CacheOptimizerPlugin: Plugin = async () => {
  // Load cache warming data on plugin init
  loadWarmCache()

  return {
    // ── Primary hook: system prompt reordering ─────────────────────

    "experimental.chat.system.transform": async (input, output) => {
      const rawBlocks = output.system
      const rawBlockCount = rawBlocks?.length ?? 0
      const scope = scopeForSession(input.sessionID, input.model)
      const splitBlocks = rawBlocks ? splitAll(rawBlocks) : []
      const splitBlockCount = splitBlocks.length
      if (splitBlockCount <= 1) {
        eventLog("transform_seen", scope, {
          sessionHash: hashID(input.sessionID),
          rawBlockCount,
          splitBlockCount,
          status: "skipped",
          reason: "insufficient_system_blocks",
        })
        return
      }
      eventLog("transform_seen", scope, {
        sessionHash: hashID(input.sessionID),
        rawBlockCount,
        splitBlockCount,
        status: "received",
      })

      const family = familyScopeForSession(input.sessionID, input.model)
      const db = loadDB(scope)
      const familyDB = family === scope ? db : loadDB(family)
      const warmMembership = warmMembershipForScope(scope, familyDB)

      const classified = classify(splitBlocks, db, {
        splitThreshold: Number.MAX_SAFE_INTEGER,
        warmHashes: classificationWarmHashes(warmMembership),
      })

      const ranked = rankStableBlocks(
        classified.stable,
        [...classified.unknown, ...classified.dynamic],
        db,
        familyDB,
        warmMembership,
      )

      output.system = [
        ...ranked.sharedStable,
        ...ranked.scopedStable,
        ...ranked.coldStable,
        ...ranked.dynamic,
      ]

      // Persist position-based + content-addressed
      updateDB(db, output.system)
      updateContentDB(db, output.system)
      if (family !== scope) {
        updateDB(familyDB, output.system)
        updateContentDB(familyDB, output.system)
      }

      // Periodic maintenance
      if (db.observations % DB_PRUNE_INTERVAL === 0) {
        pruneStaleHashes(db)
      }
      if (family !== scope && familyDB.observations % DB_PRUNE_INTERVAL === 0) {
        pruneStaleHashes(familyDB)
      }

      saveDB(scope, db)
      if (family !== scope) saveDB(family, familyDB)
      rotateDiagLog()

      // Update warm cache every 10 observations
      if (db.observations % 10 === 0) {
        saveWarmCache(scope, db)
      }

      // Track savings
      const stableBytes = classified.stable.reduce((s, b) => s + b.length, 0)
      const savings = loadSavings()
      savings.totalStableBytes += stableBytes
      savings.totalObservations++
      savings.estimatedSavingsUSD = estimateSavings(savings.totalStableBytes, 1)
      saveSavings(savings)
      const sharedPrefixBytes = ranked.sharedStable.reduce((s, b) => s + b.length, 0)

      // Diagnostic log with savings
      const estCallSaving = estimateSavings(stableBytes, 1)
      const warmCount = warmHashesForScope(scope)?.size ?? 0
      diag(
        scope,
        `S:${classified.stable.length} U:${classified.unknown.length} ` +
          `D:${classified.dynamic.length} T:${output.system.length} ` +
          `SH:${ranked.sharedStable.length} SC:${ranked.scopedStable.length} ` +
          `CS:${ranked.coldStable.length} ` +
          `obs:${db.observations} ` +
          `stableKB:${(stableBytes / 1024).toFixed(1)} ` +
          `sharedKB:${(sharedPrefixBytes / 1024).toFixed(1)} ` +
          `saved:$${estCallSaving.toFixed(6)} ` +
          `total:$${savings.estimatedSavingsUSD.toFixed(4)}`,
      )
      eventLog("transform", scope, {
        sessionHash: hashID(input.sessionID),
        family,
        counts: {
          stable: classified.stable.length,
          unknown: classified.unknown.length,
          dynamic: classified.dynamic.length,
          total: output.system.length,
        },
        classifier: {
          unknown: classified.unknown.length,
          warmHashes: warmCount,
        },
        ranking: {
          sharedStable: ranked.sharedStable.length,
          scopedStable: ranked.scopedStable.length,
          coldStable: ranked.coldStable.length,
          dynamic: ranked.dynamic.length,
          sharedPrefixBytes,
        },
        stableBytes,
        estimatedCallSavingsUSD: estCallSaving,
        totalEstimatedSavingsUSD: savings.estimatedSavingsUSD,
        observations: db.observations,
      })
    },

    // ── Diagnostic: chat.params (confirms plugin loaded) ──────────

    "chat.params": async (input, _output) => {
      const scope = rememberSessionScope(input.sessionID, input.model, input.agent)
      if (!loadedScopes.has(scope)) {
        loadedScopes.add(scope)
        const warmCount = warmHashesForScope(scope)?.size ?? 0
        diag(
          scope,
          `v${VERSION} loaded agent=${input.agent ?? "unknown"} ` +
            `provider=${input.model?.providerID ?? "?"} model=${input.model?.id ?? "?"} ` +
            `warm=${warmCount}`,
        )
        eventLog("loaded", scope, {
          sessionHash: hashID(input.sessionID),
          provider: input.model?.providerID ?? "unknown-provider",
          model: input.model?.id ?? "unknown-model",
          agent: input.agent ?? "unknown",
          warmCount,
        })
      }
    },

    "chat.message": async (input, _output) => {
      rememberSessionScope(input.sessionID, input.model, input.agent)
    },

    event: async (input) => {
      recordCacheMetricFromEvent(input.event)
    },

    // ── Provider cache headers ────────────────────────────────────

    "chat.headers": async (input, output) => {
      if (input.provider?.info?.name?.toLowerCase().includes("anthropic")) {
        if (!output.headers["anthropic-beta"]) {
          output.headers["anthropic-beta"] = "prompt-caching-2024-07-31"
        }
      }
    },
  }
}

// Re-exports
export {
  emptyDB,
  updateDB,
  updateContentDB,
  hashContent,
  lookupScore,
  lookupContentScore,
  isWarm,
  extractWarmHashes,
  isWarmHash,
  estimateSavings,
} from "./core"
export { coldStartScore, classify } from "./heuristics"
export { splitBlock, splitAll } from "./splitting"
export type { StabilityDB, Classified, BlockFingerprint, CacheOptimizerOptions } from "./types"

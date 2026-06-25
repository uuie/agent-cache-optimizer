/**
 * agent-cache-optimizer — OpenCode Plugin Entry Point
 *
 * Content-agnostic KV cache optimizer.  Reorders system prompt blocks so
 * that stable content comes FIRST and dynamic content comes LAST,
 * maximizing prefix-match cache reuse across sessions.
 *
 * @license MIT
 */

const VERSION = "0.5.3"

import type { Plugin } from "@opencode-ai/plugin"
import { join } from "node:path"
import { homedir } from "node:os"
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { emptyDB, updateDB, updateContentDB, extractWarmHashes, estimateSavings } from "./core"
import { classify } from "./heuristics"
import type { StabilityDB } from "./types"

// ── Persistence ──────────────────────────────────────────────────────

const STATE_DIR = join(
  process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
  "opencode",
  "agent-cache-optimizer",
)

function dbPath(agent: string): string {
  const safe = agent.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "default"
  return join(STATE_DIR, `stability-${safe}.json`)
}

function warmCachePath(): string {
  return join(STATE_DIR, "warm-cache.json")
}

function loadDB(agent: string): StabilityDB {
  try {
    const raw = readFileSync(dbPath(agent), "utf-8")
    const db = JSON.parse(raw) as StabilityDB
    // Migrate from pre-0.5.0: rebuild contentIndex from position data
    // Migrate from pre-0.5.x: ensure contentObservations exists
    if (db.contentObservations === undefined || db.contentObservations === null) {
      // Reset contentIndex — old position-based counts don't map cleanly
      db.contentIndex = {}
      db.contentScores = {}
      db.contentObservations = 0
      saveDB(agent, db)
    }
    return db
  } catch {
    return emptyDB()
  }
}

function saveDB(agent: string, db: StabilityDB): void {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
    db.updated = Date.now()
    writeFileSync(dbPath(agent), JSON.stringify(db, null, 2))
  } catch {
    /* best-effort */
  }
}

// ── Cache warming ────────────────────────────────────────────────────

let warmHashes: Set<string> | null = null
let warmHashesLoaded = false

function loadWarmCache(): Set<string> | null {
  if (warmHashesLoaded) return warmHashes
  warmHashesLoaded = true
  try {
    const raw = readFileSync(warmCachePath(), "utf-8")
    const hashes = JSON.parse(raw) as string[]
    warmHashes = new Set(hashes)
    return warmHashes
  } catch {
    return null
  }
}

function saveWarmCache(db: StabilityDB): void {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
    const hashes = [...extractWarmHashes(db)]
    if (hashes.length > 0) {
      writeFileSync(warmCachePath(), JSON.stringify(hashes))
    }
  } catch {
    /* best-effort */
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
  } catch {
    /* best-effort */
  }
}

// ── Diagnostics ──────────────────────────────────────────────────────

let firstCallLogged = false

function diag(agent: string, msg: string): void {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
    const ts = new Date().toISOString()
    writeFileSync(join(STATE_DIR, "diag.log"), `[${ts}] [${agent}] ${msg}\n`, { flag: "a" })
  } catch {
    /* silent */
  }
}

// ── Plugin ───────────────────────────────────────────────────────────

export const CacheOptimizerPlugin: Plugin = async () => {
  // Load cache warming data on plugin init
  loadWarmCache()

  return {
    // ── Primary hook: system prompt reordering ─────────────────────

    "experimental.chat.system.transform": async (input, output) => {
      const rawBlocks = output.system
      if (!rawBlocks || rawBlocks.length <= 1) return

      const agent = input.model?.id ?? "default"
      const db = loadDB(agent)

      // Pass warm hashes to classifier for cache warming
      const classified = classify(rawBlocks, db, { warmHashes: warmHashes ?? undefined })

      // Reorder: stable → unknown → dynamic
      output.system = [...classified.stable, ...classified.unknown, ...classified.dynamic]

      // Persist position-based + content-addressed
      updateDB(db, output.system)
      updateContentDB(db, output.system)
      saveDB(agent, db)

      // Update warm cache every 10 observations
      if (db.observations % 10 === 0) {
        saveWarmCache(db)
      }

      // Track savings
      const stableBytes = classified.stable.reduce((s, b) => s + b.length, 0)
      const savings = loadSavings()
      savings.totalStableBytes += stableBytes
      savings.totalObservations++
      savings.estimatedSavingsUSD = estimateSavings(savings.totalStableBytes, savings.totalObservations)
      saveSavings(savings)

      // Diagnostic log with savings
      const estCallSaving = estimateSavings(stableBytes, 1)
      diag(
        agent,
        `S:${classified.stable.length} U:${classified.unknown.length} ` +
          `D:${classified.dynamic.length} T:${output.system.length} ` +
          `obs:${db.observations} ` +
          `stableKB:${(stableBytes / 1024).toFixed(1)} ` +
          `saved:$${estCallSaving.toFixed(6)} ` +
          `total:$${savings.estimatedSavingsUSD.toFixed(4)}`,
      )
    },

    // ── Diagnostic: chat.params (confirms plugin loaded) ──────────

    "chat.params": async (input, _output) => {
      if (!firstCallLogged) {
        firstCallLogged = true
        const agent = input.agent ?? "unknown"
        const warmCount = warmHashes?.size ?? 0
        diag(
          agent,
          `v${VERSION} loaded agent=${agent} model=${input.model?.id ?? "?"} ` +
            `warm=${warmCount}`,
        )
      }
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
export { emptyDB, updateDB, updateContentDB, hashContent, lookupScore, lookupContentScore, isWarm, extractWarmHashes, isWarmHash, estimateSavings } from "./core"
export { coldStartScore, classify } from "./heuristics"
export { splitBlock, splitAll } from "./splitting"
export type { StabilityDB, Classified, BlockFingerprint, CacheOptimizerOptions } from "./types"

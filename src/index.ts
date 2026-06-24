/**
 * agent-cache-optimizer — OpenCode Plugin Entry Point
 *
 * Content-agnostic KV cache optimizer.  Reorders system prompt blocks so
 * that stable content (config, agent definitions, tool schemas) comes
 * FIRST and dynamic content (session handoff, memory injections, dates)
 * comes LAST.  This maximizes prefix-match cache reuse across sessions.
 *
 * Installation:
 *   1. Add to opencode.json plugins: "agent-cache-optimizer"
 *   2. Or use file:// path for local development
 *   3. Restart OpenCode
 *
 * @license MIT
 */

import type { Plugin } from "@opencode-ai/plugin"
import { join } from "node:path"
import { homedir } from "node:os"
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { emptyDB, updateDB } from "./core"
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

function loadDB(agent: string): StabilityDB {
  try {
    return JSON.parse(readFileSync(dbPath(agent), "utf-8")) as StabilityDB
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
  return {
    // ── Primary hook: system prompt reordering ─────────────────────

    "experimental.chat.system.transform": async (input, output) => {
      const rawBlocks = output.system
      if (!rawBlocks || rawBlocks.length <= 1) return

      const agent = input.model?.id ?? "default"
      const db = loadDB(agent)
      const classified = classify(rawBlocks, db)

      // Reorder: stable → unknown → dynamic
      output.system = [...classified.stable, ...classified.unknown, ...classified.dynamic]

      // Persist for next call
      const updated = updateDB(db, output.system)
      saveDB(agent, updated)

      diag(
        agent,
        `S:${classified.stable.length} U:${classified.unknown.length} ` +
          `D:${classified.dynamic.length} T:${output.system.length} ` +
          `obs:${updated.observations}`,
      )
    },

    // ── Diagnostic: chat.params (confirms plugin loaded) ──────────

    "chat.params": async (input, _output) => {
      if (!firstCallLogged) {
        firstCallLogged = true
        diag(
          input.agent ?? "unknown",
          `plugin-loaded agent=${input.agent ?? "?"} model=${input.model?.id ?? "?"}`,
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

// Re-export core for standalone usage
export { emptyDB, updateDB, hashContent, lookupScore, isWarm } from "./core"
export { coldStartScore, classify } from "./heuristics"
export { splitBlock, splitAll } from "./splitting"
export type { StabilityDB, Classified, BlockFingerprint, CacheOptimizerOptions } from "./types"

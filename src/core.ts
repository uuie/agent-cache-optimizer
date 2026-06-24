import { createHash } from "node:crypto"
import type { StabilityDB } from "./types"

/**
 * Core hash-tracking engine — fully CLI-agnostic.
 *
 * Input:  string[] of system prompt blocks
 * Output: updated StabilityDB with per-position fingerprints and scores
 *
 * This module has ZERO external dependencies and can be used by any
 * CLI agent adapter (OpenCode, Claude Code, Codex, etc.).
 */

// ── Hashing ──────────────────────────────────────────────────────────

/** SHA-256 truncated to 16 hex chars — collision-safe for ~10⁵ blocks */
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16)
}

// ── DB persistence ───────────────────────────────────────────────────

export function emptyDB(): StabilityDB {
  return { positions: {}, scores: {}, observations: 0, updated: 0 }
}

// ── Stability scoring ────────────────────────────────────────────────

/**
 * Look up the current stability score for a block hash.
 * Returns null if this hash has never been seen.
 */
export function lookupScore(db: StabilityDB, hash: string): number | null {
  const val = db.scores[hash]
  return val !== undefined ? val : null
}

/**
 * Update the stability database with a new observation.
 *
 * For each block position, records the hash fingerprint.  Then recomputes
 * stability scores for all known hashes:
 *
 *   score = positionalFidelity × recency × varietyPenalty
 *
 * - positionalFidelity: how often this hash appears at this position
 * - recency: 1.0 if seen in the last 24h, 0.7 otherwise
 * - varietyPenalty: penalizes positions where many different hashes appear
 *
 * All scores are clamped to [0, 1].
 */
export function updateDB(db: StabilityDB, blocks: string[]): StabilityDB {
  const now = Date.now()
  const hashes = blocks.map(hashContent)

  // Record fingerprints at each position
  for (let i = 0; i < hashes.length; i++) {
    const h = hashes[i]
    if (h === undefined) continue
    if (!db.positions[i]) db.positions[i] = []
    const fps = db.positions[i]
    if (!fps) continue
    const existing = fps.find((f) => f.hash === h)
    if (existing) {
      existing.lastSeen = now
      existing.count++
    } else {
      fps.push({ hash: h, firstSeen: now, lastSeen: now, count: 1 })
    }
  }

  // Recompute stability scores
  for (const [posStr, fps] of Object.entries(db.positions)) {
    const pos = Number(posStr)
    for (const fp of fps) {
      const fidelity = fp.count / Math.max(1, db.observations)
      const recency = now - fp.lastSeen < 24 * 60 * 60 * 1000 ? 1.0 : 0.7
      const varietyCount = db.positions[pos]?.length || 1
      const varietyPenalty = 1 / Math.max(1, varietyCount)

      db.scores[fp.hash] = Math.min(
        1.0,
        Math.max(0.0, fidelity * recency * (0.5 + 0.5 * varietyPenalty)),
      )
    }
  }

  db.observations++
  return db
}

/**
 * Check whether the database has enough observations for hash-based
 * (warm) decisions.  Below this threshold, cold-start heuristics are used.
 */
export function isWarm(db: StabilityDB, threshold = 2): boolean {
  return db.observations >= threshold
}

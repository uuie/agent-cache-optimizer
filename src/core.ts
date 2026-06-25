import { createHash } from "node:crypto"
import type { StabilityDB } from "./types"

/**
 * Core hash-tracking engine — fully CLI-agnostic.
 */

// ── Hashing ──────────────────────────────────────────────────────────

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16)
}

// ── DB operations ────────────────────────────────────────────────────

export function emptyDB(): StabilityDB {
  return { positions: {}, scores: {}, observations: 0, updated: 0 }
}

export function lookupScore(db: StabilityDB, hash: string): number | null {
  const val = db.scores[hash]
  return val !== undefined ? val : null
}

// ── Stability scoring ────────────────────────────────────────────────

export function updateDB(db: StabilityDB, blocks: string[]): StabilityDB {
  const now = Date.now()
  const hashes = blocks.map(hashContent)

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

export function isWarm(db: StabilityDB, threshold = 2): boolean {
  return db.observations >= threshold
}

// ── Cache warming ────────────────────────────────────────────────────

/**
 * Extract stable hashes from a DB for cache warming.
 * A hash is "warmable" if its score >= 0.8 and it has been observed
 * at least 3 times at the same position.
 */
export function extractWarmHashes(db: StabilityDB): Set<string> {
  const warm = new Set<string>()
  for (const fps of Object.values(db.positions)) {
    for (const fp of fps) {
      const score = db.scores[fp.hash]
      if (score !== undefined && score >= 0.8 && fp.count >= 3) {
        warm.add(fp.hash)
      }
    }
  }
  return warm
}

/**
 * Check if a block hash is known-stable from cache warming data.
 */
export function isWarmHash(warmHashes: Set<string> | null, hash: string): boolean {
  return warmHashes !== null && warmHashes.has(hash)
}

// ── Cost estimation ──────────────────────────────────────────────────

/**
 * Estimate cache cost savings based on classification.
 *
 * DeepSeek v4-pro pricing (per 1M tokens):
 *   Cache miss (input): $0.435
 *   Cache hit  (input): $0.003625
 *   Savings: ~$0.431 per 1M cached tokens
 *
 * Rough estimate: 1 token ≈ 4 chars for English text.
 */
export function estimateSavings(
  stableBytes: number,
  observations: number,
  tokenRatio = 0.25,
  costPerM = 0.431,
): number {
  const tokens = Math.round(stableBytes * tokenRatio)
  const perCall = (tokens / 1_000_000) * costPerM
  return perCall * observations
}

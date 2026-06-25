import { createHash } from "node:crypto"
import type { StabilityDB } from "./types"

/**
 * Core engine — content-addressed hash tracking (CLI-agnostic).
 *
 * v0.5: Added content-addressed tracking.  Instead of tracking which hash
 * appears at which POSITION (which breaks when block count changes across
 * calls), we track by CONTENT identity.  The same CLAUDE.md block hash
 * gets counted regardless of whether it appears at index 1, 2, or 3.
 */

// ── Hashing ──────────────────────────────────────────────────────────

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16)
}

// ── DB operations ────────────────────────────────────────────────────

export function emptyDB(): StabilityDB {
  return {
    positions: {},
    scores: {},
    contentIndex: {},
    contentScores: {},
    contentObservations: 0,
    observations: 0,
    updated: 0,
  }
}

export function lookupScore(db: StabilityDB, hash: string): number | null {
  const val = db.scores[hash]
  return val !== undefined ? val : null
}

// ── Content-addressed scoring (primary) ──────────────────────────────

/**
 * Look up content-addressed stability score for a block hash.
 * This is position-independent — the same block gets the same score
 * regardless of where it appears in the system prompt.
 */
export function lookupContentScore(db: StabilityDB, hash: string): number | null {
  const val = db.contentScores[hash]
  return val !== undefined ? val : null
}

/**
 * Update content-addressed tracking.
 *
 * For each block, records its hash in the content index regardless of
 * position.  Then recomputes content scores:
 *
 *   score = count / observations
 *
 * A block that appears in every call → score → 1.0 (stable)
 * A block that appears once → score → 1/observations (dynamic)
 */
export function updateContentDB(db: StabilityDB, blocks: string[]): StabilityDB {
  const now = Date.now()

  for (const block of blocks) {
    const h = hashContent(block)
    const existing = db.contentIndex[h]
    if (existing) {
      existing.lastSeen = now
      existing.count++
    } else {
      db.contentIndex[h] = { hash: h, firstSeen: now, lastSeen: now, count: 1 }
    }
  }

  // Recompute content scores using contentObservations (not observations)
  db.contentObservations++
  const obs = Math.max(1, db.contentObservations)
  for (const fp of Object.values(db.contentIndex)) {
    db.contentScores[fp.hash] = Math.min(1.0, fp.count / obs)
  }

  return db
}

// ── Position-based scoring (legacy fallback) ─────────────────────────

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

export function extractWarmHashes(db: StabilityDB): Set<string> {
  const warm = new Set<string>()
  // Primary: content-addressed stable hashes
  for (const [hash, score] of Object.entries(db.contentScores)) {
    if (score >= 0.8) warm.add(hash)
  }
  // Fallback: position-based stable hashes
  for (const [hash, score] of Object.entries(db.scores)) {
    if (score >= 0.8) warm.add(hash)
  }
  return warm
}

export function isWarmHash(warmHashes: Set<string> | null, hash: string): boolean {
  return warmHashes !== null && warmHashes.has(hash)
}

// ── Cost estimation ──────────────────────────────────────────────────

/**
 * Estimate cache cost savings. DeepSeek v4-pro: $0.435/M miss → $0.003625/M hit.
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

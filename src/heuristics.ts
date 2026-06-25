import type { StabilityDB, Classified } from "./types"
import { splitAll } from "./splitting"
import { hashContent, lookupScore, lookupContentScore, isWarm } from "./core"

/**
 * Cold-start heuristics — universal position/size/structure signals.
 *
 * v0.5: Content-addressed classification.  When content scores are
 * available, they take priority over position-based scores, fixing the
 * "position shift" problem where block count changes bust tracking.
 */

export function coldStartScore(block: string, index: number, total: number): number {
  let score = 0.5

  if (index === 0) score = 0.15
  if (index >= 1 && index <= 7 && block.length > 200) score = 0.8

  const isStructured = /^[<\{\[]/.test(block.trim())
  if (index >= total - 2 && !isStructured) score = Math.min(score, 0.25)

  if (block.length > 3000) score = Math.max(score, 0.85)
  if (block.length < 100) score = Math.min(score, 0.2)

  const dateCount = (block.match(/\d{4}-\d{2}-\d{2}/g) || []).length
  if (dateCount >= 3) score = Math.min(score, 0.25)

  const trimmed = block.trim()
  if (/^[<\{\[]|^```/.test(trimmed) && index < total - 2) {
    score = Math.max(score, 0.8)
  }

  if (/^(You are|Your (job|role|task)|As an? )/m.test(block)) {
    score = Math.max(score, 0.8)
  }

  const lines = block.split("\n")
  const avgLineLen = block.length / Math.max(1, lines.length)
  if (lines.length > 15 && avgLineLen < 30) score = Math.min(score, 0.3)

  return score
}

// ── Classification ───────────────────────────────────────────────────

/**
 * Classify blocks into stable / unknown / dynamic.
 *
 * Scoring priority:
 *   1. Cache warm hash → score 0.85 (instant stable)
 *   2. Content-addressed score → score from contentScores (position-independent)
 *   3. Position-based score → score from scores (legacy fallback)
 *   4. Cold-start heuristic → position/size signals
 */
export function classify(
  blocks: string[],
  db: StabilityDB,
  opts?: { warmThreshold?: number; splitThreshold?: number; warmHashes?: Set<string> },
): Classified {
  const items = splitAll(blocks, opts?.splitThreshold)

  const result: Classified = { stable: [], unknown: [], dynamic: [] }
  const warm = isWarm(db, opts?.warmThreshold ?? 2)
  const warmSet = opts?.warmHashes
  const total = items.length

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item === undefined) continue

    const hash = hashContent(item)

    // Priority 1: cache-warmed hash
    if (warmSet?.has(hash)) {
      result.stable.push(item)
      continue
    }

    // Priority 2: content-addressed score (primary)
    const contentScore = lookupContentScore(db, hash)
    if (contentScore !== null && db.observations >= 2) {
      if (contentScore >= 0.7) { result.stable.push(item); continue }
      if (contentScore <= 0.2) { result.dynamic.push(item); continue }
    }

    // Priority 3: position-based score (fallback)
    const known = lookupScore(db, hash)
    let score: number
    if (known !== null && warm) {
      score = known
    } else {
      score = coldStartScore(item, i, total)
    }

    if (score >= 0.7) result.stable.push(item)
    else if (score <= 0.3) result.dynamic.push(item)
    else result.unknown.push(item)
  }

  return result
}

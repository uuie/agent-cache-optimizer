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

  const cap = volatileMetadataCap(block)
  if (cap !== null) score = Math.min(score, cap)

  return score
}

/**
 * Dynamic meta-info / structural patterns.
 *
 * Run this as a final cap so structured boosts cannot move volatile metadata
 * back into the stable prefix.
 */
function volatileMetadataCap(block: string): number | null {
  const dynamicPatterns = [
    { re: /(^|\n)\s*["']?(currentDate|current date)["']?\s*[:=]/i, cap: 0.15 },
    { re: /["'](currentDate|current date)["']\s*[:=]/i, cap: 0.15 },
    { re: /(^|\n)\s*today is\b/i, cap: 0.15 },
    {
      re: /(^|\n)\s*["']?(session\s*id|session|timestamp|last updated|iso timestamp)["']?\s*[:=]/i,
      cap: 0.25,
    },
    {
      re: /["'](session\s*id|session|timestamp|last updated|iso timestamp)["']\s*[:=]/i,
      cap: 0.25,
    },
  ]
  let cap: number | null = null
  for (const { re, cap: nextCap } of dynamicPatterns) {
    if (re.test(block)) cap = cap === null ? nextCap : Math.min(cap, nextCap)
  }
  return cap
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
    if (contentScore !== null && db.contentObservations >= 2) {
      if (contentScore >= 0.7) {
        result.stable.push(item)
        continue
      }
      if (contentScore <= 0.2) {
        result.dynamic.push(item)
        continue
      }
      // Middle range (0.2–0.7): fall through to cold-start for tiered classification
    }

    // Priority 3: position-based score (fallback) or cold-start heuristic
    const known = lookupScore(db, hash)
    let score: number
    if (known !== null && warm) {
      score = known
    } else {
      score = coldStartScore(item, i, total)
    }

    // Tiered classification: 0.5 threshold reduces unknown to near-empty
    if (score >= 0.5) result.stable.push(item)
    else result.dynamic.push(item)
  }

  return result
}

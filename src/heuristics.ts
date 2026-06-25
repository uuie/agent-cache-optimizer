import type { StabilityDB, Classified } from "./types"
import { splitAll } from "./splitting"
import { hashContent, lookupScore, isWarm } from "./core"

/**
 * Cold-start heuristics — universal position/size/structure signals.
 *
 * These work across ANY agent framework, skill set, or config without
 * any content-specific patterns.  Principles:
 *
 *   - Position 0 is almost always status/handoff → dynamic
 *   - Positions 1-7 with substantial content are config → stable
 *   - Very large blocks (>3KB) are config/definitions → stable
 *   - Very small blocks (<100B) are status/date → dynamic
 *   - High date density signals log/diary content → dynamic
 *   - Structural delimiters ({, [, <, ```) signal config → stable
 *   - Second-person role assignment → agent prompt → stable
 *   - Short-line documents (avg < 30 chars) → log/diary → dynamic
 *   - Tail blocks (last 2) are dynamic UNLESS they look structural
 */

export function coldStartScore(block: string, index: number, total: number): number {
  let score = 0.5

  // ── Position signals ──────────────────────────────────────────

  // Block 0 is status/handoff in virtually every agent framework
  if (index === 0) score = 0.15

  // Blocks at positions 1-7 with non-trivial content are stable config
  if (index >= 1 && index <= 7 && block.length > 200) score = 0.8

  // Last 2 blocks are usually dynamic, but structured blocks ({, [, <)
  // at the tail are probably split artifacts, not real injections.
  const isStructured = /^[<\{\[]/.test(block.trim())
  if (index >= total - 2 && !isStructured) score = Math.min(score, 0.25)

  // ── Size signals ──────────────────────────────────────────────

  if (block.length > 3000) score = Math.max(score, 0.85)
  if (block.length < 100) score = Math.min(score, 0.2)

  // ── Structure signals ─────────────────────────────────────────

  // High density of date stamps → log/diary → dynamic
  const dateCount = (block.match(/\d{4}-\d{2}-\d{2}/g) || []).length
  if (dateCount >= 3) score = Math.min(score, 0.25)

  // Starts with structural delimiter → JSON, XML, or code fence → config.
  // Skip the boost for tail blocks (they're likely <memory> injections).
  const trimmed = block.trim()
  if (/^[<\{\[]|^```/.test(trimmed) && index < total - 2) {
    score = Math.max(score, 0.8)
  }

  // Second-person role assignment → agent system prompt → stable
  if (/^(You are|Your (job|role|task)|As an? )/m.test(block)) {
    score = Math.max(score, 0.8)
  }

  // Many very short lines (avg < 30 chars) suggests log/diary → dynamic
  const lines = block.split("\n")
  const avgLineLen = block.length / Math.max(1, lines.length)
  if (lines.length > 15 && avgLineLen < 30) score = Math.min(score, 0.3)

  return score
}

// ── Classification ───────────────────────────────────────────────────

/**
 * Classify blocks into stable / unknown / dynamic.
 *
 * In warm mode (hash-based), uses historical stability scores.
 * In cold mode (first few calls per agent), uses position/size heuristics.
 */
export function classify(
  blocks: string[],
  db: StabilityDB,
  opts?: { warmThreshold?: number; splitThreshold?: number; warmHashes?: Set<string> },
): Classified {
  // Split large blocks first
  const items = splitAll(blocks, opts?.splitThreshold)

  const result: Classified = { stable: [], unknown: [], dynamic: [] }
  const warm = isWarm(db, opts?.warmThreshold ?? 2)
  const warmSet = opts?.warmHashes
  const total = items.length

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item === undefined) continue

    const hash = hashContent(item)
    const known = lookupScore(db, hash)
    // Cache warming: if hash is in the warm set, treat as stable immediately
    const cached = warmSet?.has(hash) ?? false

    let score: number
    if (cached) {
      score = 0.85 // warmed: treat as stable even on cold DB
    } else if (known !== null && warm) {
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

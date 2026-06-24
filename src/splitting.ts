/**
 * Block splitting — split large prompt blocks at natural boundaries.
 *
 * Large blocks (>4KB) like tool definition arrays or long agent prompts
 * can contain multiple independent items.  Splitting them allows individual
 * sub-blocks to be classified independently:
 *
 *   - JSON arrays of tool definitions → individual tool objects
 *   - Markdown files with ## sections → individual sections
 *   - XML/HTML blocks → individual elements
 *   - Otherwise → paragraph boundaries (double newline)
 *
 * This is fully content-agnostic: it only looks at structural delimiters,
 * never at specific keywords or names.
 */

const DEFAULT_SPLIT_THRESHOLD = 4000

/**
 * Split a block into sub-blocks at natural structural boundaries.
 * Returns [block] unchanged if no split is needed or possible.
 */
export function splitBlock(block: string, threshold = DEFAULT_SPLIT_THRESHOLD): string[] {
  if (block.length <= threshold) return [block]

  const trimmed = block.trim()

  // ── JSON object array: {"name": "A", ...}, {"name": "B", ...} ──
  if (trimmed.startsWith("{")) {
    const objects = block.match(/\{[^}{]*"name"\s*:\s*"[^"]+"[^}]*\}/g)
    if (objects && objects.length >= 2) return objects
  }

  // ── Markdown: split at ## section headers ──────────────────────
  if (block.includes("\n## ")) {
    const sections = block.split(/\n(?=## )/)
    if (sections.length >= 2) return sections
  }

  // ── XML/HTML: split at top-level closing tags ──────────────────
  if (/^<(\w+)[^>]*>/.test(trimmed)) {
    const tagMatch = trimmed.match(/^<(\w+)[^>]*>/)
    if (tagMatch) {
      const tag = tagMatch[1]
      const parts = block.split(new RegExp(`(?=</?${tag}[>\\s])`))
      if (parts.length >= 2) return parts
    }
  }

  // ── Fallback: paragraph boundaries ─────────────────────────────
  const paragraphs = block.split(/\n\n+/)
  if (paragraphs.length >= 3) return paragraphs

  return [block]
}

/**
 * Apply splitting to an array of blocks, returning a flat array.
 */
export function splitAll(blocks: string[], threshold?: number): string[] {
  const result: string[] = []
  for (const b of blocks) {
    result.push(...splitBlock(b, threshold))
  }
  return result
}

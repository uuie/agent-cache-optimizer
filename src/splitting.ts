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

  // ── JSON: brace-depth parser ───────────────────────────────────
  // Handles JSON arrays [{...}, {...}, ...] and consecutive objects
  // without external dependencies or brittle regex.
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const items = splitJSONItems(trimmed.slice(1, -1))
    if (items && items.length >= 2) return items
  }
  if (trimmed.startsWith("{")) {
    const items = splitJSONItems(trimmed)
    if (items && items.length >= 2) return items
  }

  // ── Markdown: split at section headers outside fenced code ─────
  const markdownSections = splitMarkdownSections(block)
  if (markdownSections) return markdownSections

  // ── Markdown: split long top-level lists ───────────────────────
  const markdownListItems = splitMarkdownListItems(block)
  if (markdownListItems) return markdownListItems

  // ── XML/HTML: split top-level sibling elements ─────────────────
  if (/^<(\w+)[^>]*>/.test(trimmed)) {
    const parts = splitXMLTopLevelElements(trimmed)
    if (parts) return parts
  }

  // ── Fallback: paragraph boundaries ─────────────────────────────
  const paragraphs = block.split(/\n\n+/)
  if (paragraphs.length >= 3) return paragraphs

  return [block]
}

/**
 * Lightweight brace-depth parser that extracts top-level JSON objects
 * from an array body or consecutive-object body.
 *
 * Handles arbitrary nesting depth, escaped quotes inside strings, and
 * whitespace/commas between items. Returns null when fewer than 2 items
 * are found.
 */
function splitJSONItems(text: string): string[] | null {
  const items: string[] = []
  let depth = 0
  let start = -1
  let inString = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === "\\")
        i++ // skip escaped char
      else if (ch === '"') inString = false
    } else {
      if (ch === '"') inString = true
      else if (ch === "{") {
        if (depth === 0) start = i
        depth++
      } else if (ch === "}") {
        depth--
        if (depth === 0 && start >= 0) {
          items.push(text.slice(start, i + 1))
          start = -1
        }
      }
    }
  }

  return items.length >= 2 ? items : null
}

function splitMarkdownSections(block: string): string[] | null {
  const lines = block.split("\n")
  const candidates: Record<1 | 2 | 3, number[]> = { 1: [], 2: [], 3: [] }
  let inFence = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    const match = line.match(/^(#{1,3})\s+\S/)
    if (!match) continue
    const level = match[1]?.length
    if (level === 1 || level === 2 || level === 3) candidates[level].push(i)
  }

  const level = ([1, 2, 3] as const).find((candidate) => candidates[candidate].length >= 2)
  if (!level) return null

  const starts = candidates[level]
  const firstStart = starts[0]
  if (firstStart === undefined) return null
  const sections: string[] = []
  if (firstStart !== 0) sections.push(lines.slice(0, firstStart).join("\n").trimEnd())
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!
    const end = starts[i + 1] ?? lines.length
    sections.push(lines.slice(start, end).join("\n").trimEnd())
  }

  const filtered = sections.filter((section) => section.trim().length > 0)
  return filtered.length >= 2 ? filtered : null
}

function splitMarkdownListItems(block: string): string[] | null {
  const lines = block.split("\n")
  const starts: number[] = []
  let inFence = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (/^([-*+]|\d+[.)])\s+\S/.test(line)) starts.push(i)
  }

  if (starts.length < 3) return null

  const items: string[] = []
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!
    const end = starts[i + 1] ?? lines.length
    items.push(lines.slice(start, end).join("\n").trimEnd())
  }

  return items.length >= 3 ? items : null
}

function splitXMLTopLevelElements(text: string): string[] | null {
  const items: string[] = []
  const tagRe = /<\/?([A-Za-z][\w:.-]*)(?:\s[^<>]*)?>/g
  let depth = 0
  let start = -1
  let match: RegExpExecArray | null

  while ((match = tagRe.exec(text)) !== null) {
    const tag = match[0]
    const closing = tag.startsWith("</")
    const selfClosing = /\/>$/.test(tag)

    if (!closing) {
      if (depth === 0) start = match.index
      if (selfClosing && depth === 0 && start >= 0) {
        items.push(text.slice(start, tagRe.lastIndex).trim())
        start = -1
      } else if (!selfClosing) {
        depth++
      }
      continue
    }

    depth--
    if (depth < 0) return null
    if (depth === 0 && start >= 0) {
      items.push(text.slice(start, tagRe.lastIndex).trim())
      start = -1
    }
  }

  return depth === 0 && items.length >= 2 ? items : null
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

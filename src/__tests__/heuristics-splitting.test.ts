import { describe, it, expect } from "vitest"
import { coldStartScore, classify } from "../heuristics"
import { splitBlock } from "../splitting"
import { emptyDB } from "../core"

// ── coldStartScore ─────────────────────────────────────────────────────

describe("coldStartScore", () => {
  it("returns <=0.15 for currentDate-like line", () => {
    const score = coldStartScore("currentDate: 2025-06-25", 5, 10)
    expect(score).toBeLessThanOrEqual(0.15)
  })

  it("returns <=0.25 for 'Current date:' line", () => {
    const score = coldStartScore("Current date: Tuesday, June 25th 2026", 3, 10)
    expect(score).toBeLessThanOrEqual(0.25)
  })

  it("returns <=0.25 for 'Today is' line", () => {
    const score = coldStartScore("Today is a great day to build", 4, 10)
    expect(score).toBeLessThanOrEqual(0.25)
  })

  it("returns <=0.25 for 'Session:' line", () => {
    const score = coldStartScore("Session: abc-123-def", 2, 10)
    expect(score).toBeLessThanOrEqual(0.25)
  })

  it("returns <=0.25 for 'session id' line", () => {
    const score = coldStartScore("session id: xyz-987", 6, 10)
    expect(score).toBeLessThanOrEqual(0.25)
  })

  it("returns <=0.25 for 'timestamp' line", () => {
    const score = coldStartScore("timestamp: 1719300000", 3, 10)
    expect(score).toBeLessThanOrEqual(0.25)
  })

  it("returns <=0.25 for 'Last updated' line", () => {
    const score = coldStartScore("Last updated: 2026-06-25 13:00:00", 5, 10)
    expect(score).toBeLessThanOrEqual(0.25)
  })

  it("returns <=0.25 for 'ISO timestamp' line", () => {
    const score = coldStartScore("ISO timestamp: 2026-06-25T13:00:00Z", 4, 10)
    expect(score).toBeLessThanOrEqual(0.25)
  })

  it("matches dynamic metadata labels case-insensitively", () => {
    const filler = " stable-looking content".repeat(20)
    expect(coldStartScore(`Timestamp: 1719300000${filler}`, 3, 10)).toBeLessThanOrEqual(0.25)
    expect(coldStartScore(`Session ID: xyz-987${filler}`, 3, 10)).toBeLessThanOrEqual(0.25)
    expect(coldStartScore(`LAST UPDATED: 2026-06-25${filler}`, 3, 10)).toBeLessThanOrEqual(0.25)
  })
})

// ── classify unknown tiering ───────────────────────────────────────────

describe("classify", () => {
  it("routes coldStart=0.5 blocks to stable instead of unknown", () => {
    // 150-200 char block at index 2 with total ~8 → baseline score 0.5
    // With new 0.5 threshold → stable (was unknown with old 0.7)
    const db = emptyDB()
    const block =
      "A moderate length prompt block that does not trigger any special heuristic in coldStartScore and gets the baseline of 0.5 which is now our stable threshold."
    const blocks = ["a", "b", block, "c", "d", "e", "f", "g"]
    const result = classify(blocks, db, { warmThreshold: 0 })
    expect(result.stable).toContain(block)
    expect(result.unknown).toHaveLength(0)
  })

  it("routes short/metadata blocks to dynamic instead of unknown", () => {
    const db = emptyDB()
    const block = "Short meta block" // <100 chars → score ≤0.2 → dynamic
    const result = classify(["prefix", block, "suffix"], db, { warmThreshold: 0 })
    expect(result.dynamic).toContain(block)
    expect(result.unknown).toHaveLength(0)
  })

  it("reduces unknown bucket size with tiered classification", () => {
    const db = emptyDB()
    const blocks = [
      '{"role": "system", "content": "You are a helpful assistant."}', // structured, ~0.8 → stable
      "currentDate: 2026-06-25", // dynamic pattern, ≤0.15 → dynamic
      "50 char block that sits right in our heuristics", // short (< 100) → ≤0.2 → dynamic
    ]
    const result = classify(blocks, db, { warmThreshold: 0 })
    expect(result.unknown.length).toBeLessThan(blocks.length)
  })

  it("lets contentScore 0.2-0.7 range fall through to coldStartScore tiering", () => {
    // When contentScore is in the middle range, it should fall through
    // to coldStartScore which uses the new thresholds
    const db = emptyDB()
    const block = "A short-ish block that would have mid content score"
    const result = classify(["p1", block, "p2"], db, { warmThreshold: 0 })
    // All 3 blocks should be classified (none stuck in unknown limbo)
    expect(result.dynamic.length + result.stable.length).toBe(3)
  })

  it("passes through structured stable blocks correctly", () => {
    const db = emptyDB()
    // JSON block at index 0 with total=3 → structured boost max(0.15, 0.8) = 0.8
    const stable = '{"key": "value", "nested": {"a": 1}}'
    const result = classify([stable, "p1", "p2"], db, { warmThreshold: 0 })
    expect(result.stable).toContain(stable)
  })

  it("keeps structured currentDate metadata dynamic after structural boosts", () => {
    const db = emptyDB()
    const volatile = '{"currentDate": "2026-06-25", "instructions": "You are stable."}'
    const result = classify([volatile, "p1", "p2"], db, { warmThreshold: 0 })
    expect(result.dynamic).toContain(volatile)
    expect(result.stable).not.toContain(volatile)
  })
})

// ── splitBlock Markdown ### ────────────────────────────────────────────

describe("splitBlock Markdown ###", () => {
  it("splits long blocks at top-level # section headers", () => {
    const block = `# Setup
Install the package

# Usage
Run the command

# Troubleshooting
Inspect logs`
    const result = splitBlock(block, 50)
    expect(result).toHaveLength(3)
    expect(result[0]).toContain("# Setup")
    expect(result[1]).toContain("# Usage")
    expect(result[2]).toContain("# Troubleshooting")
  })

  it("splits long blocks at ### section headers", () => {
    const block = `# Overview
Some intro text

### Installation
Install via npm

### Configuration
Configure the tool

### Usage
Run the command`
    const result = splitBlock(block, 50) // low threshold forces splitting
    expect(result.length).toBeGreaterThanOrEqual(3)
    expect(result[0]).toContain("# Overview")
    expect(result[1]).toContain("### Installation")
    expect(result[2]).toContain("### Configuration")
  })

  it("does not split at ### when block is small enough", () => {
    const block = `### Small
Content`
    const result = splitBlock(block, 4000)
    expect(result).toEqual([block])
  })

  it("splits at ### when no ## exist and block exceeds threshold", () => {
    // Has ### but no ## (exactly two hashes)
    const block = `# Title
Some text

### Section One
Content here

### Section Two
More content here`
    const result = splitBlock(block, 20)
    expect(result.length).toBeGreaterThanOrEqual(2)
  })

  it("does not split headings inside fenced code blocks", () => {
    const block = `# Real Section
Content

\`\`\`md
# Not A Section
## Still Code
\`\`\`

# Next Section
More content`
    const result = splitBlock(block, 50)
    expect(result).toHaveLength(2)
    expect(result[0]).toContain("# Not A Section")
    expect(result[1]).toContain("# Next Section")
  })

  it("splits long markdown lists by top-level list items", () => {
    const block = `- Alpha item
  continued alpha
- Beta item
  continued beta
- Gamma item
  continued gamma`
    const result = splitBlock(block, 30)
    expect(result).toEqual([
      "- Alpha item\n  continued alpha",
      "- Beta item\n  continued beta",
      "- Gamma item\n  continued gamma",
    ])
  })
})

// ── splitBlock JSON tool schema ────────────────────────────────────────

describe("splitBlock JSON arrays", () => {
  it("splits a JSON array of tool definitions", () => {
    const block = JSON.stringify(
      [
        { name: "tool_a", description: "Tool A", parameters: { type: "object", properties: {} } },
        { name: "tool_b", description: "Tool B", parameters: { type: "object", properties: {} } },
        { name: "tool_c", description: "Tool C", parameters: { type: "object", properties: {} } },
      ],
      null,
      2,
    )
    const result = splitBlock(block, 100)
    expect(result.length).toBeGreaterThanOrEqual(3)
    expect(result[0]).toContain("tool_a")
    expect(result[1]).toContain("tool_b")
  })

  it("splits consecutive JSON objects not in an array", () => {
    const block = `{"name": "tool_a", "description": "First tool"}
{"name": "tool_b", "description": "Second tool"}
{"name": "tool_c", "description": "Third tool"}`
    const result = splitBlock(block, 50)
    expect(result.length).toBeGreaterThanOrEqual(3)
    expect(result[0]).toContain("tool_a")
    expect(result[1]).toContain("tool_b")
  })

  it("splits deeply nested JSON objects in an array", () => {
    const block = JSON.stringify(
      [
        {
          name: "complex_tool",
          parameters: {
            type: "object",
            properties: {
              field1: { type: "string", description: "A field" },
              field2: { type: "number", description: "Another field" },
            },
            required: ["field1"],
          },
        },
        {
          name: "another_tool",
          parameters: {
            type: "object",
            properties: {
              param_a: { type: "string" },
            },
          },
        },
      ],
      null,
      2,
    )
    const result = splitBlock(block, 200)
    expect(result.length).toBeGreaterThanOrEqual(2)
    expect(result[0]).toContain("complex_tool")
    expect(result[1]).toContain("another_tool")
  })
})

// ── splitBlock XML siblings ───────────────────────────────────────────

describe("splitBlock XML siblings", () => {
  it("splits top-level XML sibling elements", () => {
    const block = `<tool><name>a</name><description>first</description></tool>
<tool><name>b</name><description>second</description></tool>
<tool><name>c</name><description>third</description></tool>`
    const result = splitBlock(block, 50)
    expect(result).toEqual([
      "<tool><name>a</name><description>first</description></tool>",
      "<tool><name>b</name><description>second</description></tool>",
      "<tool><name>c</name><description>third</description></tool>",
    ])
  })
})

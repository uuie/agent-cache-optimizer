import { describe, it, expect } from "vitest"
import { hashContent, emptyDB, updateDB, lookupScore, isWarm } from "../core"

describe("hashContent", () => {
  it("produces consistent hashes", () => {
    const a = hashContent("hello")
    const b = hashContent("hello")
    expect(a).toBe(b)
    expect(a.length).toBe(16)
  })

  it("produces different hashes for different content", () => {
    expect(hashContent("hello")).not.toBe(hashContent("world"))
  })
})

describe("emptyDB", () => {
  it("returns a fresh database", () => {
    const db = emptyDB()
    expect(db.observations).toBe(0)
    expect(db.updated).toBe(0)
    expect(Object.keys(db.positions)).toHaveLength(0)
    expect(Object.keys(db.scores)).toHaveLength(0)
  })
})

describe("updateDB", () => {
  it("tracks fingerprints at positions", () => {
    let db = emptyDB()
    db = updateDB(db, ["block-a", "block-b", "block-c"])

    expect(db.observations).toBe(1)
    expect(db.positions[0]).toHaveLength(1)
    expect(db.positions[1]).toHaveLength(1)
    expect(db.positions[2]).toHaveLength(1)
  })

  it("counts repeated hashes at the same position", () => {
    let db = emptyDB()

    // Session 1
    db = updateDB(db, ["HANDOFF-v1", "CLAUDE-stable", "MEMORY-v1"])

    // Session 2: same CLAUDE, different HANDOFF and MEMORY
    db = updateDB(db, ["HANDOFF-v2", "CLAUDE-stable", "MEMORY-v2"])

    // Position 0 has 2 distinct hashes (HANDOFF changed)
    expect(db.positions[0]).toHaveLength(2)
    // Position 1 has 1 hash, count=2 (CLAUDE stable)
    expect(db.positions[1]).toHaveLength(1)
    expect(db.positions[1]?.[0]?.count).toBe(2)
    // Position 2 has 2 distinct hashes (MEMORY changed)
    expect(db.positions[2]).toHaveLength(2)
  })

  it("assigns high scores to stable blocks", () => {
    let db = emptyDB()

    // 4 sessions with stable CLAUDE, changing HANDOFF
    for (const v of ["v1", "v2", "v3", "v4"]) {
      db = updateDB(db, [`HANDOFF-${v}`, "CLAUDE-stable"])
    }

    const claudeHash = hashContent("CLAUDE-stable")
    const claudeScore = lookupScore(db, claudeHash)
    expect(claudeScore).toBeGreaterThan(0.7)

    const handoffHash = hashContent("HANDOFF-v4")
    const handoffScore = lookupScore(db, handoffHash)
    expect(handoffScore).toBeLessThan(0.5)
  })

  it("clamps scores to [0, 1]", () => {
    let db = emptyDB()
    for (let i = 0; i < 10; i++) {
      db = updateDB(db, ["stable-block"])
    }
    const hash = hashContent("stable-block")
    const score = lookupScore(db, hash)
    expect(score).not.toBeNull()
    expect(score!).toBeGreaterThanOrEqual(0)
    expect(score!).toBeLessThanOrEqual(1)
  })
})

describe("isWarm", () => {
  it("returns false below threshold", () => {
    const db = emptyDB()
    expect(isWarm(db, 2)).toBe(false)
  })

  it("returns true at or above threshold", () => {
    let db = emptyDB()
    db.observations = 3
    expect(isWarm(db, 2)).toBe(true)
  })
})

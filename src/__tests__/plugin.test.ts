import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { hashContent } from "../core"

const stateDir = (cacheRoot: string) => join(cacheRoot, "opencode", "agent-cache-optimizer")

const model = (providerID: string, id = "deepseek-chat") =>
  ({
    id,
    providerID,
    name: id,
  }) as any

async function withPlugin<T>(fn: (hooks: any, cacheRoot: string) => Promise<T>): Promise<T> {
  const originalCacheHome = process.env.XDG_CACHE_HOME
  const cacheRoot = mkdtempSync(join(tmpdir(), "aco-test-"))
  process.env.XDG_CACHE_HOME = cacheRoot
  vi.resetModules()

  try {
    const { CacheOptimizerPlugin } = await import("../index")
    const hooks = await CacheOptimizerPlugin({} as any)
    return await fn(hooks, cacheRoot)
  } finally {
    if (originalCacheHome === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = originalCacheHome
    rmSync(cacheRoot, { recursive: true, force: true })
    vi.resetModules()
  }
}

describe("CacheOptimizerPlugin provider/model scope", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("tracks the same model id separately for different providers", async () => {
    await withPlugin(async (hooks, cacheRoot) => {
      const system = [
        "currentDate: 2026-06-25",
        "You are a provider scoped cache optimizer. ".repeat(8),
      ]

      await hooks["experimental.chat.system.transform"](
        { sessionID: "s1", model: model("deepseek") },
        { system: [...system] },
      )
      await hooks["experimental.chat.system.transform"](
        { sessionID: "s2", model: model("openrouter") },
        { system: [...system] },
      )

      const files = readdirSync(stateDir(cacheRoot))
        .filter((file) => file.startsWith("stability-"))
        .sort()
      expect(files).toEqual([
        "stability-deepseek__deepseek-chat.json",
        "stability-openrouter__deepseek-chat.json",
      ])
    })
  })

  it("writes loaded diagnostics once per provider/model scope", async () => {
    await withPlugin(async (hooks, cacheRoot) => {
      await hooks["chat.params"]({ agent: "build", model: model("deepseek") }, {})
      await hooks["chat.params"]({ agent: "build", model: model("openrouter") }, {})

      const log = readFileSync(join(stateDir(cacheRoot), "diag.log"), "utf-8")
      expect(log).toContain("[deepseek__deepseek-chat__build] v0.6.0 loaded")
      expect(log).toContain("[openrouter__deepseek-chat__build] v0.6.0 loaded")
    })
  })

  it("does not multiply cumulative savings by the observation count twice", async () => {
    await withPlugin(async (hooks, cacheRoot) => {
      const stable = "You are a stable cacheable system prompt block. ".repeat(8)
      const dynamic = "currentDate: 2026-06-25"

      await hooks["experimental.chat.system.transform"](
        { sessionID: "s1", model: model("openrouter") },
        { system: [dynamic, stable] },
      )
      await hooks["experimental.chat.system.transform"](
        { sessionID: "s2", model: model("openrouter") },
        { system: [dynamic, stable] },
      )

      const savings = JSON.parse(readFileSync(join(stateDir(cacheRoot), "savings.json"), "utf-8"))
      const expected = (Math.round(stable.length * 2 * 0.25) / 1_000_000) * 0.431
      expect(savings.totalStableBytes).toBe(stable.length * 2)
      expect(savings.totalObservations).toBe(2)
      expect(savings.estimatedSavingsUSD).toBeCloseTo(expected, 12)
    })
  })

  it("uses session agent context when system transform only has provider/model", async () => {
    await withPlugin(async (hooks, cacheRoot) => {
      const system = [
        "currentDate: 2026-06-25",
        "You are a stable cacheable system prompt block. ".repeat(8),
      ]

      await hooks["chat.params"](
        { sessionID: "s-build", agent: "build", model: model("deepseek") },
        {},
      )
      await hooks["chat.params"](
        { sessionID: "s-review", agent: "review", model: model("deepseek") },
        {},
      )
      await hooks["experimental.chat.system.transform"](
        { sessionID: "s-build", model: model("deepseek") },
        { system: [...system] },
      )
      await hooks["experimental.chat.system.transform"](
        { sessionID: "s-review", model: model("deepseek") },
        { system: [...system] },
      )

      const files = readdirSync(stateDir(cacheRoot))
        .filter((file) => file.startsWith("stability-"))
        .sort()
      expect(files).toEqual([
        "stability-deepseek__deepseek-chat__build.json",
        "stability-deepseek__deepseek-chat__review.json",
      ])
    })
  })

  it("records provider cache metrics from message events without double-counting updates", async () => {
    await withPlugin(async (hooks, cacheRoot) => {
      await hooks["chat.params"](
        { sessionID: "s-build", agent: "build", model: model("openrouter") },
        {},
      )

      await hooks.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              id: "assistant-1",
              sessionID: "s-build",
              role: "assistant",
              providerID: "openrouter",
              modelID: "deepseek-chat",
              agent: "build",
              cost: 0.01,
              tokens: {
                input: 100,
                output: 20,
                reasoning: 0,
                cache: { read: 40, write: 10 },
              },
            },
          },
        },
      })
      await hooks.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              id: "assistant-1",
              sessionID: "s-build",
              role: "assistant",
              providerID: "openrouter",
              modelID: "deepseek-chat",
              agent: "build",
              cost: 0.015,
              tokens: {
                input: 150,
                output: 25,
                reasoning: 0,
                cache: { read: 70, write: 10 },
              },
            },
          },
        },
      })

      const metrics = JSON.parse(
        readFileSync(join(stateDir(cacheRoot), "cache-metrics.json"), "utf-8"),
      )
      expect(metrics.total.inputTokens).toBe(150)
      expect(metrics.total.outputTokens).toBe(25)
      expect(metrics.total.cacheReadTokens).toBe(70)
      expect(metrics.total.cacheWriteTokens).toBe(10)
      expect(metrics.total.costUSD).toBeCloseTo(0.015, 12)
      expect(metrics.scopes["openrouter__deepseek-chat__build"].cacheHitRate).toBeCloseTo(
        70 / (150 + 70),
        12,
      )
      const snapshotKeys = Object.keys(metrics.snapshots)
      expect(snapshotKeys).toEqual([
        `message:${hashContent("s-build")}:${hashContent("assistant-1")}`,
      ])
      expect(snapshotKeys[0]).not.toContain("s-build")
      expect(snapshotKeys[0]).not.toContain("assistant-1")
    })
  })

  it("skips duplicate zero-delta provider cache metric events", async () => {
    await withPlugin(async (hooks, cacheRoot) => {
      const update = {
        event: {
          type: "message.updated",
          properties: {
            info: {
              id: "assistant-1",
              sessionID: "s-build",
              role: "assistant",
              providerID: "openrouter",
              modelID: "deepseek-chat",
              agent: "build",
              cost: 0.01,
              tokens: {
                input: 100,
                output: 20,
                reasoning: 0,
                cache: { read: 40, write: 10 },
              },
            },
          },
        },
      }

      await hooks["chat.params"](
        { sessionID: "s-build", agent: "build", model: model("openrouter") },
        {},
      )
      await hooks.event(update)
      await hooks.event(update)

      const raw = readFileSync(join(stateDir(cacheRoot), "events.jsonl"), "utf-8")
      const events = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      const metricsEvents = events.filter((event) => event.type === "metrics")
      const metrics = JSON.parse(
        readFileSync(join(stateDir(cacheRoot), "cache-metrics.json"), "utf-8"),
      )

      expect(metricsEvents).toHaveLength(1)
      expect(metrics.total.events).toBe(1)
    })
  })

  it("migrates raw cache metric snapshot keys before applying deltas", async () => {
    await withPlugin(async (hooks, cacheRoot) => {
      const metricsDir = stateDir(cacheRoot)
      mkdirSync(metricsDir, { recursive: true })
      const existingTotals = {
        events: 1,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
        costUSD: 0.01,
        cacheHitRate: 0.4,
      }
      writeFileSync(
        join(metricsDir, "cache-metrics.json"),
        JSON.stringify(
          {
            total: { ...existingTotals },
            scopes: {
              "openrouter__deepseek-chat__build": { ...existingTotals },
            },
            snapshots: {
              "message:s-build:assistant-1": {
                inputTokens: 100,
                outputTokens: 20,
                cacheReadTokens: 40,
                cacheWriteTokens: 10,
                costUSD: 0.01,
              },
            },
            updated: 1,
          },
          null,
          2,
        ),
      )

      await hooks["chat.params"](
        { sessionID: "s-build", agent: "build", model: model("openrouter") },
        {},
      )
      await hooks.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              id: "assistant-1",
              sessionID: "s-build",
              role: "assistant",
              providerID: "openrouter",
              modelID: "deepseek-chat",
              agent: "build",
              cost: 0.015,
              tokens: {
                input: 150,
                output: 25,
                reasoning: 0,
                cache: { read: 70, write: 10 },
              },
            },
          },
        },
      })

      const metrics = JSON.parse(
        readFileSync(join(stateDir(cacheRoot), "cache-metrics.json"), "utf-8"),
      )
      expect(metrics.total.inputTokens).toBe(150)
      expect(metrics.total.outputTokens).toBe(25)
      expect(metrics.total.cacheReadTokens).toBe(70)
      expect(metrics.total.cacheWriteTokens).toBe(10)
      expect(metrics.total.costUSD).toBeCloseTo(0.015, 12)
      expect(Object.keys(metrics.snapshots)).toEqual([
        `message:${hashContent("s-build")}:${hashContent("assistant-1")}`,
      ])
    })
  })

  it("computes cache hit rate from cached plus uncached input tokens", async () => {
    await withPlugin(async (hooks, cacheRoot) => {
      await hooks["chat.params"](
        { sessionID: "s-build", agent: "build", model: model("openrouter") },
        {},
      )

      await hooks.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              id: "assistant-1",
              sessionID: "s-build",
              role: "assistant",
              providerID: "openrouter",
              modelID: "deepseek-chat",
              agent: "build",
              cost: 0,
              tokens: {
                input: 109,
                output: 4,
                reasoning: 15,
                cache: { read: 29952, write: 0 },
              },
            },
          },
        },
      })

      const metrics = JSON.parse(
        readFileSync(join(stateDir(cacheRoot), "cache-metrics.json"), "utf-8"),
      )
      const hitRate = metrics.scopes["openrouter__deepseek-chat__build"].cacheHitRate
      expect(hitRate).toBeCloseTo(29952 / (109 + 29952), 12)
      expect(hitRate).toBeLessThanOrEqual(1)
    })
  })

  it("persists scoped warm cache and promotes hashes to global after multiple scopes", async () => {
    await withPlugin(async (hooks, cacheRoot) => {
      const stable = "You are a stable cacheable system prompt block. ".repeat(8)
      const dynamic = "currentDate: 2026-06-25"

      await hooks["chat.params"](
        { sessionID: "s-build", agent: "build", model: model("deepseek") },
        {},
      )
      await hooks["chat.params"](
        { sessionID: "s-review", agent: "review", model: model("deepseek") },
        {},
      )

      for (let i = 0; i < 10; i++) {
        await hooks["experimental.chat.system.transform"](
          { sessionID: "s-build", model: model("deepseek") },
          { system: [`${dynamic}-${i}`, stable] },
        )
      }
      for (let i = 0; i < 10; i++) {
        await hooks["experimental.chat.system.transform"](
          { sessionID: "s-review", model: model("deepseek") },
          { system: [`${dynamic}-${i}`, stable] },
        )
      }

      const warm = JSON.parse(readFileSync(join(stateDir(cacheRoot), "warm-cache.json"), "utf-8"))
      const stableHash = hashContent(stable)
      expect(warm.version).toBe(2)
      expect(warm.scopes["deepseek__deepseek-chat__build"]).toContain(stableHash)
      expect(warm.scopes["deepseek__deepseek-chat__review"]).toContain(stableHash)
      expect(warm.global).toContain(stableHash)
    })
  })

  it("writes structured events for statistics and debugging without raw ids", async () => {
    await withPlugin(async (hooks, cacheRoot) => {
      const stable = "You are a stable cacheable system prompt block. ".repeat(8)
      const dynamic = "currentDate: 2026-06-25"

      await hooks["chat.params"](
        { sessionID: "s-sensitive-build", agent: "build", model: model("openrouter") },
        {},
      )
      for (let i = 0; i < 10; i++) {
        await hooks["experimental.chat.system.transform"](
          { sessionID: "s-sensitive-build", model: model("openrouter") },
          { system: [`${dynamic}-${i}`, stable] },
        )
      }
      await hooks.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              id: "msg-sensitive-1",
              sessionID: "s-sensitive-build",
              role: "assistant",
              providerID: "openrouter",
              modelID: "deepseek-chat",
              agent: "build",
              cost: 0.015,
              tokens: {
                input: 150,
                output: 25,
                reasoning: 0,
                cache: { read: 70, write: 10 },
              },
            },
          },
        },
      })

      const raw = readFileSync(join(stateDir(cacheRoot), "events.jsonl"), "utf-8")
      const events = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      const types = events.map((event) => event.type)

      expect(types).toContain("loaded")
      expect(types).toContain("transform_seen")
      expect(types).toContain("transform")
      expect(types).toContain("warm_cache_update")
      expect(types).toContain("metrics")
      expect(raw).not.toContain("s-sensitive-build")
      expect(raw).not.toContain("msg-sensitive-1")

      const transform = events.find((event) => event.type === "transform")
      expect(transform.sessionHash).toMatch(/^[a-f0-9]{16}$/)
      expect(transform.counts).toMatchObject({ stable: 1, dynamic: 1, total: 2 })
      expect(transform.classifier).toMatchObject({ unknown: 0 })

      const seen = events.find((event) => event.type === "transform_seen")
      expect(seen.sessionHash).toMatch(/^[a-f0-9]{16}$/)
      expect(seen.rawBlockCount).toBe(2)
      expect(seen.status).toBe("received")

      const metrics = events.find((event) => event.type === "metrics")
      expect(metrics.messageHash).toMatch(/^[a-f0-9]{16}$/)
      expect(metrics.delta.cacheReadTokens).toBe(70)
      expect(metrics.totals.cacheHitRate).toBeCloseTo(70 / (150 + 70), 12)

      const warmUpdate = events.find((event) => event.type === "warm_cache_update")
      expect(warmUpdate.scopedHashCount).toBeGreaterThan(0)
      expect(warmUpdate.globalHashCount).toBeGreaterThanOrEqual(0)
    })
  })

  it("records transform entry events for no-op system transforms", async () => {
    await withPlugin(async (hooks, cacheRoot) => {
      await hooks["chat.params"](
        { sessionID: "s-sensitive-noop", agent: "build", model: model("openrouter") },
        {},
      )
      await hooks["experimental.chat.system.transform"](
        { sessionID: "s-sensitive-noop", model: model("openrouter") },
        { system: ["single block"] },
      )

      const raw = readFileSync(join(stateDir(cacheRoot), "events.jsonl"), "utf-8")
      const events = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      const seen = events.find((event) => event.type === "transform_seen")

      expect(seen.scope).toBe("openrouter__deepseek-chat__build")
      expect(seen.sessionHash).toMatch(/^[a-f0-9]{16}$/)
      expect(seen.rawBlockCount).toBe(1)
      expect(seen.status).toBe("skipped")
      expect(seen.reason).toBe("insufficient_system_blocks")
      expect(raw).not.toContain("s-sensitive-noop")
      expect(events.some((event) => event.type === "transform")).toBe(false)
    })
  })

  it("splits a single long system block before deciding whether transform is a no-op", async () => {
    await withPlugin(async (hooks, cacheRoot) => {
      const dynamic = "currentDate: 2026-06-25"
      const stableA = "You are stable cacheable instructions A. ".repeat(90)
      const stableB = "You are stable cacheable instructions B. ".repeat(90)
      const systemBlock = [dynamic, stableA, stableB].join("\n\n")
      const output = { system: [systemBlock] }

      await hooks["chat.params"](
        { sessionID: "s-single-long", agent: "build", model: model("openrouter") },
        {},
      )
      await hooks["experimental.chat.system.transform"](
        { sessionID: "s-single-long", model: model("openrouter") },
        output,
      )

      expect(output.system).toEqual([stableA, stableB, dynamic])

      const raw = readFileSync(join(stateDir(cacheRoot), "events.jsonl"), "utf-8")
      const events = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      const seen = events.find((event) => event.type === "transform_seen")
      const transform = events.find((event) => event.type === "transform")

      expect(seen.rawBlockCount).toBe(1)
      expect(seen.splitBlockCount).toBe(3)
      expect(seen.status).toBe("received")
      expect(transform.counts).toMatchObject({ stable: 2, dynamic: 1, total: 3 })
    })
  })
})

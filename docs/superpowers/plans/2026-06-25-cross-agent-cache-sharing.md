# Cross-Agent Cache Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make shared stable system blocks appear before agent-specific stable blocks after OpenCode switches agents on the same provider/model.

**Architecture:** Keep the existing `provider__model__agent` DB for per-agent behavior, and add a `provider__model` family DB used only for cross-agent ranking. Classification remains content-agnostic; the new ranking phase partitions already-stable blocks into shared, scoped, and cold groups before appending dynamic blocks.

**Tech Stack:** TypeScript, OpenCode plugin hooks, Node fs/path APIs, Vitest.

---

## File Structure

- Modify `src/index.ts`: add family scope helpers, stable-block ranking, transform wiring, and diagnostics.
- Modify `src/__tests__/plugin.test.ts`: add cross-agent ordering and family DB persistence tests.
- Run existing tests through `npm test` and type checks through `npm run typecheck`.

The family DB should be persisted as another `stability-*.json` file using the existing DB helpers. Do not change prompt text. Do not migrate the warm-cache file format. Family warm membership should be derived from the family DB with `extractWarmHashes(familyDB)` so the existing global warm promotion does not count a family DB as a second agent scope. Family warm hashes are used for ranking only; they must not bypass volatile metadata classification.

### Task 1: Add Failing Cross-Agent Ordering Test

**Files:**
- Modify: `src/__tests__/plugin.test.ts`

- [ ] **Step 1: Add a test showing shared blocks should outrank agent-specific blocks**

Append this test inside the existing `describe("CacheOptimizerPlugin provider/model scope", () => { ... })` block, after the warm-cache promotion test:

```ts
  it("orders family-stable shared blocks before agent-specific stable blocks after agent switches", async () => {
    await withPlugin(async (hooks, cacheRoot) => {
      const sharedTools = "Shared tool and project instructions stay identical across agents. ".repeat(30)
      const buildPrompt = "You are the build agent with build-only instructions. ".repeat(30)
      const reviewPrompt = "You are the review agent with review-only instructions. ".repeat(30)

      await hooks["chat.params"](
        { sessionID: "s-build", agent: "build", model: model("deepseek") },
        {},
      )
      for (let i = 0; i < 3; i++) {
        await hooks["experimental.chat.system.transform"](
          { sessionID: "s-build", model: model("deepseek") },
          { system: [`currentDate: 2026-06-25\nsession id: build-${i}`, buildPrompt, sharedTools] },
        )
      }

      await hooks["chat.params"](
        { sessionID: "s-review", agent: "review", model: model("deepseek") },
        {},
      )
      for (let i = 0; i < 3; i++) {
        await hooks["experimental.chat.system.transform"](
          { sessionID: "s-review", model: model("deepseek") },
          {
            system: [
              `currentDate: 2026-06-25\nsession id: review-${i}`,
              reviewPrompt,
              sharedTools,
            ],
          },
        )
      }

      const output = {
        system: ["currentDate: 2026-06-25\nsession id: review-final", reviewPrompt, sharedTools],
      }
      await hooks["experimental.chat.system.transform"](
        { sessionID: "s-review", model: model("deepseek") },
        output,
      )

      expect(output.system[0]).toBe(sharedTools)
      expect(output.system[1]).toBe(reviewPrompt)
      expect(output.system[2]).toContain("session id: review-final")

      const raw = readFileSync(join(stateDir(cacheRoot), "events.jsonl"), "utf-8")
      const events = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      const transform = events.filter((event) => event.type === "transform").at(-1)

      expect(transform.ranking).toMatchObject({
        sharedStable: 1,
        scopedStable: 1,
        coldStable: 0,
      })
      expect(transform.ranking.sharedPrefixBytes).toBe(sharedTools.length)
    })
  })
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```bash
npm test -- src/__tests__/plugin.test.ts -t "orders family-stable shared blocks"
```

Expected: FAIL because current output keeps `reviewPrompt` before `sharedTools`, and the `ranking` diagnostic object does not exist.

### Task 2: Add Failing Family DB Persistence Test

**Files:**
- Modify: `src/__tests__/plugin.test.ts`

- [ ] **Step 1: Add a test for writing both agent and family stability DBs**

Append this test near the existing scope tests:

```ts
  it("writes a provider-model family DB alongside agent-scoped DBs", async () => {
    await withPlugin(async (hooks, cacheRoot) => {
      const stable = "Stable shared prompt content for the model family. ".repeat(20)
      const dynamic = "currentDate: 2026-06-25\nsession id: family-db"

      await hooks["chat.params"](
        { sessionID: "s-build-family", agent: "build", model: model("deepseek") },
        {},
      )
      await hooks["experimental.chat.system.transform"](
        { sessionID: "s-build-family", model: model("deepseek") },
        { system: [dynamic, stable] },
      )

      const files = readdirSync(stateDir(cacheRoot))
        .filter((file) => file.startsWith("stability-"))
        .sort()

      expect(files).toContain("stability-deepseek__deepseek-chat.json")
      expect(files).toContain("stability-deepseek__deepseek-chat__build.json")
    })
  })
```

- [ ] **Step 2: Run the family DB test and verify it fails**

Run:

```bash
npm test -- src/__tests__/plugin.test.ts -t "writes a provider-model family DB"
```

Expected: FAIL because only `stability-deepseek__deepseek-chat__build.json` is written for an agent session.

### Task 3: Add Family Scope Context Helpers

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Replace string-only session scope tracking with scope contexts**

In `src/index.ts`, replace the current session-scope block with this implementation:

```ts
// ── Session scope tracking ───────────────────────────────────────────

interface ScopeContext {
  scope: string
  familyScope: string
}

const sessionScopes = new Map<string, ScopeContext>()

function familyScope(model: ModelIdentity | undefined): string {
  return modelScope(model)
}

function scopeContext(model: ModelIdentity | undefined, agent?: string): ScopeContext {
  const scope = modelScope(model, agent)
  const modelFamily = familyScope(model)
  return {
    scope,
    familyScope: modelFamily === "default" ? scope : modelFamily,
  }
}

function rememberSessionScope(
  sessionID: string | undefined,
  model: ModelIdentity | undefined,
  agent?: string,
): string {
  const context = scopeContext(model, agent)
  if (sessionID) sessionScopes.set(sessionID, context)
  return context.scope
}

function scopeForSession(sessionID: string | undefined, model: ModelIdentity | undefined): string {
  if (sessionID) {
    const known = sessionScopes.get(sessionID)
    if (known) return known.scope
  }
  return scopeContext(model).scope
}

function familyScopeForSession(
  sessionID: string | undefined,
  model: ModelIdentity | undefined,
): string {
  if (sessionID) {
    const known = sessionScopes.get(sessionID)
    if (known) return known.familyScope
  }
  return scopeContext(model).familyScope
}
```

- [ ] **Step 2: Run existing scope tests**

Run:

```bash
npm test -- src/__tests__/plugin.test.ts -t "scope"
```

Expected: existing scope tests still PASS. The two new tests still FAIL.

### Task 4: Add Stable Block Ranking Helpers

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add `lookupContentScore` to the core imports**

Change the import from `./core` so it includes `lookupContentScore`:

```ts
import {
  emptyDB,
  updateDB,
  updateContentDB,
  extractWarmHashes,
  estimateSavings,
  hashContent,
  lookupContentScore,
} from "./core"
```

- [ ] **Step 2: Add ranking types and helpers before the plugin definition**

Insert this block after `pruneStaleHashes`:

```ts
// ── Cross-agent stable prefix ranking ────────────────────────────────

interface WarmHashMembership {
  global: Set<string>
  scoped: Set<string>
  family: Set<string>
}

interface StableRanking {
  sharedStable: string[]
  scopedStable: string[]
  coldStable: string[]
  dynamic: string[]
}

function warmMembershipForScope(scope: string, familyDB: StabilityDB): WarmHashMembership {
  const cache = loadWarmCache()
  return {
    global: cache.global,
    scoped: cache.scopes.get(scope) ?? new Set(),
    family: extractWarmHashes(familyDB),
  }
}

function hasStableContentScore(db: StabilityDB, hash: string): boolean {
  const score = lookupContentScore(db, hash)
  return db.contentObservations >= 2 && score !== null && score >= 0.7
}

function classificationWarmHashes(membership: WarmHashMembership): Set<string> {
  const hashes = new Set<string>(membership.global)
  for (const hash of membership.scoped) hashes.add(hash)
  return hashes
}

function rankStableBlocks(
  stableBlocks: string[],
  dynamicBlocks: string[],
  scopeDB: StabilityDB,
  familyDB: StabilityDB,
  warmMembership: WarmHashMembership,
): StableRanking {
  const ranking: StableRanking = {
    sharedStable: [],
    scopedStable: [],
    coldStable: [],
    dynamic: dynamicBlocks,
  }

  for (const block of stableBlocks) {
    const hash = hashContent(block)
    if (
      warmMembership.global.has(hash) ||
      warmMembership.family.has(hash) ||
      hasStableContentScore(familyDB, hash)
    ) {
      ranking.sharedStable.push(block)
      continue
    }

    if (warmMembership.scoped.has(hash) || hasStableContentScore(scopeDB, hash)) {
      ranking.scopedStable.push(block)
      continue
    }

    ranking.coldStable.push(block)
  }

  return ranking
}
```

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS after unused-import and type errors are resolved.

### Task 5: Wire Family DB and Ranking Into Transform

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Load family DB and membership in the transform hook**

Inside `"experimental.chat.system.transform"`, replace:

```ts
      const db = loadDB(scope)

      // Pass warm hashes to classifier for cache warming
      const classified = classify(splitBlocks, db, {
        splitThreshold: Number.MAX_SAFE_INTEGER,
        warmHashes: warmHashesForScope(scope),
      })

      // Reorder: stable → unknown → dynamic
      output.system = [...classified.stable, ...classified.unknown, ...classified.dynamic]
```

with:

```ts
      const family = familyScopeForSession(input.sessionID, input.model)
      const db = loadDB(scope)
      const familyDB = family === scope ? db : loadDB(family)
      const warmMembership = warmMembershipForScope(scope, familyDB)

      const classified = classify(splitBlocks, db, {
        splitThreshold: Number.MAX_SAFE_INTEGER,
        warmHashes: classificationWarmHashes(warmMembership),
      })

      const ranked = rankStableBlocks(
        classified.stable,
        [...classified.unknown, ...classified.dynamic],
        db,
        familyDB,
        warmMembership,
      )

      output.system = [
        ...ranked.sharedStable,
        ...ranked.scopedStable,
        ...ranked.coldStable,
        ...ranked.dynamic,
      ]
```

- [ ] **Step 2: Persist both DBs after reorder**

Replace:

```ts
      updateDB(db, output.system)
      updateContentDB(db, output.system)
```

with:

```ts
      updateDB(db, output.system)
      updateContentDB(db, output.system)
      if (family !== scope) {
        updateDB(familyDB, output.system)
        updateContentDB(familyDB, output.system)
      }
```

Replace:

```ts
      saveDB(scope, db)
```

with:

```ts
      saveDB(scope, db)
      if (family !== scope) saveDB(family, familyDB)
```

- [ ] **Step 3: Keep warm-cache writes scoped to agent DBs**

Leave this block scoped-only:

```ts
      if (db.observations % 10 === 0) {
        saveWarmCache(scope, db)
      }
```

Do not call `saveWarmCache(family, familyDB)`.

- [ ] **Step 4: Run the new family DB test**

Run:

```bash
npm test -- src/__tests__/plugin.test.ts -t "writes a provider-model family DB"
```

Expected: PASS.

### Task 6: Add Ranking Diagnostics

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Track shared prefix bytes and ranking counts**

After savings are calculated, add:

```ts
      const sharedPrefixBytes = ranked.sharedStable.reduce((s, b) => s + b.length, 0)
```

Change the diagnostic log call to include ranking counts:

```ts
      diag(
        scope,
        `S:${classified.stable.length} U:${classified.unknown.length} ` +
          `D:${classified.dynamic.length} T:${output.system.length} ` +
          `SH:${ranked.sharedStable.length} SC:${ranked.scopedStable.length} ` +
          `CS:${ranked.coldStable.length} ` +
          `obs:${db.observations} ` +
          `stableKB:${(stableBytes / 1024).toFixed(1)} ` +
          `sharedKB:${(sharedPrefixBytes / 1024).toFixed(1)} ` +
          `saved:$${estCallSaving.toFixed(6)} ` +
          `total:$${savings.estimatedSavingsUSD.toFixed(4)}`,
      )
```

Add this object to the `eventLog("transform", scope, { ... })` payload:

```ts
        family,
        ranking: {
          sharedStable: ranked.sharedStable.length,
          scopedStable: ranked.scopedStable.length,
          coldStable: ranked.coldStable.length,
          dynamic: ranked.dynamic.length,
          sharedPrefixBytes,
        },
```

- [ ] **Step 2: Run the cross-agent ordering test**

Run:

```bash
npm test -- src/__tests__/plugin.test.ts -t "orders family-stable shared blocks"
```

Expected: PASS.

### Task 7: Full Verification and Commit

**Files:**
- Modify: `src/index.ts`
- Modify: `src/__tests__/plugin.test.ts`

- [ ] **Step 1: Run the focused plugin suite**

Run:

```bash
npm test -- src/__tests__/plugin.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run all tests**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Inspect git diff**

Run:

```bash
git diff -- src/index.ts src/__tests__/plugin.test.ts
```

Expected: only family-scope ranking, diagnostics, and tests are changed.

- [ ] **Step 5: Commit implementation**

Run:

```bash
git add src/index.ts src/__tests__/plugin.test.ts
git commit -m "feat: share stable cache prefix across agents"
```

Expected: commit succeeds with the implementation changes only.

## Self-Review

- Spec coverage: family scope, shared/scoped/cold ranking, diagnostics, fallback behavior, and tests are covered by Tasks 1-7.
- Placeholder scan: the plan contains no deferred implementation markers.
- Type consistency: `familyScope`, `familyScopeForSession`, `WarmHashMembership`, `StableRanking`, `rankStableBlocks`, and `sharedPrefixBytes` are consistently named across tasks.
- Scope check: the plan changes only OpenCode system prompt ordering and does not introduce conversation-log rewriting, prompt mutation, manual pinning, or DeepSeek-specific branches.

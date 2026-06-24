<p align="center">
  <img src="https://img.shields.io/badge/platform-OpenCode-blue" alt="OpenCode">
  <img src="https://img.shields.io/badge/CLI-Claude%20Code%20%7C%20Codex%20%7C%20Gemini-orange" alt="Multi-CLI">
  <img src="https://img.shields.io/badge/cache%20增益-40–88%25-brightgreen" alt="Cache gain 40-88%">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT">
  <img src="https://img.shields.io/badge/依赖-零-blue" alt="Zero dependencies">
</p>

<h1 align="center">🧠 agent-cache-optimizer</h1>
<p align="center"><strong>内容无关的 KV Cache 优化器，适用于 LLM CLI Agent</strong></p>
<p align="center">提升 prompt cache 命中率 <strong>40–88%</strong><br>零配置 · 零内容依赖 · 适用于任何 Agent 框架</p>

---

## 🎯 问题

DeepSeek、Anthropic、OpenAI、Google 等 LLM 提供商都使用**前缀匹配 KV 缓存**：
如果你的 prompt 开头和之前的请求完全一致，已计算的 KV 状态会被复用 ——
缓存命中的成本接近零。

**但每个 CLI agent 都把动态内容放在 system prompt 的最前面：**

```
┌─────────────────────────────────────────────────┐
│ ⚡ HANDOFF 块（每个会话变化）                     │  ← 缓存失效
│ ⚡ REMEMBER / MEMORY（全天持续更新）              │  ← 缓存失效
├─────────────────────────────────────────────────┤
│ ✅ CLAUDE.md（数周不变）                          │  ← 永远用不到缓存
│ ✅ Agent 定义（静态）                             │  ← 永远用不到缓存
│ ✅ MCP / Skills / Tools（静态）                   │  ← 永远用不到缓存
│ ⚡ currentDate（每天变化）                        │
│ ⚡ Memory 注入（每次查询变化）                    │
└─────────────────────────────────────────────────┘
```

**结果：跨会话缓存复用率 = 0%。** 每次会话都要重新计算整个 system prompt，
即使其中 70-90% 的内容从未变化。

## 💡 解决方案

**agent-cache-optimizer** 在运行时重排 system prompt：

```
┌─────────────────────────────────────────────────┐
│ ✅ CLAUDE.md（稳定）          ← 缓存命中         │
│ ✅ Agent 定义（稳定）         ← 缓存命中         │
│ ✅ MCP / Skills / Tools       ← 缓存命中         │
│ ✅ Tool 定义                  ← 缓存命中         │
├─────────────────────────────────────────────────┤
│ ⚡ currentDate                                   │
│ ⚡ HANDOFF / REMEMBER / MEMORY                   │
│ ⚡ Memory 注入                                    │
└─────────────────────────────────────────────────┘
```

**稳定块在前 → 前缀跨会话保持一致 → 40-88% 缓存复用。**

## 🚀 安装

```json
{
  "plugin": ["agent-cache-optimizer"]
}
```

添加到 `~/.config/opencode/opencode.json`。OpenCode 下次启动时自动从 npm 安装。

```bash
# 或通过 CLI
opencode plugin agent-cache-optimizer --global
```

**重启 OpenCode — 完成。** 零配置。适用于 DeepSeek、Anthropic、OpenAI 等所有支持前缀匹配 KV 缓存的提供商。

### 验证

```bash
# 确认插件已加载
opencode debug config | grep agent-cache-optimizer

# 实时查看重排活动
tail -f ~/.cache/opencode/agent-cache-optimizer/diag.log
```

### 状态面板

OpenCode 内：

```
/cache-status
```

终端：

```bash
bash scripts/cache-status.sh
```

## 🏗 工作原理

### 1. 观测（完全内容无关）

插件**绝不读取 prompt 内容**。只对每个 system block 做哈希，追踪哪些哈希
跨调用保持不变、哪些变化：

```
会话 1:  [H1, CLAUDE-A, AGENT-X, TOOLS-V1, DATE-1, MEM-1]
会话 2:  [H2, CLAUDE-A, AGENT-X, TOOLS-V1, DATE-2, MEM-2]
会话 3:  [H3, CLAUDE-A, AGENT-X, TOOLS-V1, DATE-2, MEM-3]

3 次观测后:
  位置 0 的 H1/H2/H3 每次都变 → 分数 0.0（动态）
  位置 1 的 CLAUDE-A 从未变化 → 分数 1.0（稳定）
  位置 2 的 AGENT-X 从未变化 → 分数 1.0（稳定）
  ...
```

### 2. 分类与重排

```
                                                                  ┌──────────┐
  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐     │ 稳定     │
  │ HANDOFF  │   │ CLAUDE   │   │ TOOLS    │   │ MEMORY   │ ──▶ │ CLAUDE   │
  │ (动态)   │   │ (稳定)   │   │ (稳定)   │   │ (动态)   │     │ TOOLS    │
  └──────────┘   └──────────┘   └──────────┘   └──────────┘     │──────────│
       ⚡             ✅              ✅              ⚡           │ 动态     │
                                                                 │ HANDOFF  │
                                                                 │ MEMORY   │
                                                                 └──────────┘
```

### 3. 两阶段决策

| 阶段       | 触发条件               | 方法                     |
| ---------- | ---------------------- | ------------------------ |
| **冷启动** | 每个 agent 前 2 次调用 | 通用位置/大小/结构启发式 |
| **热状态** | 3+ 次调用              | 基于哈希的稳定性分数     |

冷启动启发式**仅使用**结构信号（位置、大小、分隔符、行密度）——不用任何关键词匹配，
不感知任何配置。这意味着插件可以立即在任何 agent 配置下工作。

## 📊 性能

在真实 OpenCode orchestrator prompt（~25KB system prompt）上测试：

| 场景                    | 可缓存前缀    | 改善 |
| ----------------------- | ------------- | ---- |
| 原始（无重排）          | 0 KB (0%)     | —    |
| 冷启动（启发式）        | 21.8 KB (88%) | +88% |
| 热状态（哈希，3+ 会话） | 21.8 KB (88%) | +88% |

## 🔌 支持的平台

| 平台            | 状态        | 适配器                                             |
| --------------- | ----------- | -------------------------------------------------- |
| **OpenCode**    | ✅ 原生插件 | `src/index.ts`                                     |
| **Claude Code** | 📖 指南     | [adapters/claude-code.md](adapters/claude-code.md) |
| **Codex**       | 🔜 计划中   | 基于 OpenCode 插件适配                             |
| **Gemini CLI**  | 🔜 计划中   | Google context caching                             |

## 🛠 缓存友好度审计

检查配置文件是否存在破坏缓存的模式：

```bash
bash scripts/check-cache-friendly.sh CLAUDE.md
bash scripts/check-cache-friendly.sh --opencode
bash scripts/check-cache-friendly.sh --all
```

## 🙋 FAQ

**Q: 会修改我的 prompt 内容吗？**
A: 只修改 system block 的**顺序**。内容从不改动。

**Q: 会破坏 agent 功能吗？**
A: 不会。LLM 看到的是相同的 blocks，只是顺序不同。System prompt 本身是无序的。

**Q: 支持非 OpenCode 的 agent 吗？**
A: 核心引擎是 CLI 无关的。OpenCode 有原生插件，Claude Code 有优化指南，
Codex 和 Gemini CLI 适配器在计划中。

**Q: 如果 prompt 内容变化了怎么办？**
A: 哈希追踪会自动适应。之前稳定的 block 如果开始变化，其分数会下降并移到动态区。
如果新增了稳定 block，几次观测后就会收敛到稳定区。

**Q: 支持 Anthropic prompt caching 吗？**
A: 支持。`chat.headers` hook 会自动为 Anthropic provider 添加
`prompt-caching-2024-07-31` beta header。

## 📄 License

MIT — 随便用、随便改、随便发、记得点 star ⭐

---

<p align="center">
  <sub>为 LLM CLI 生态而建。如果帮你省了 tokens，</sub><br>
  <sub>点个 ⭐ 让更多人看到它。</sub>
</p>

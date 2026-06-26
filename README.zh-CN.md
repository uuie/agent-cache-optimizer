<p align="center">
  <img src="https://img.shields.io/badge/platform-OpenCode-blue" alt="OpenCode">
  <img src="https://img.shields.io/badge/CLI-Claude%20Code%20%7C%20Codex%20%7C%20Gemini-orange" alt="Multi-CLI">
  <img src="https://img.shields.io/badge/providers-DeepSeek%20%7C%20Anthropic%20%7C%20OpenAI-purple" alt="DeepSeek Anthropic OpenAI">
  <img src="https://img.shields.io/badge/cache%20增益-40–88%25-brightgreen" alt="Cache gain 40-88%">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT">
  <img src="https://img.shields.io/badge/依赖-零-blue" alt="Zero dependencies">
</p>

<h1 align="center">🧠 agent-cache-optimizer</h1>
<p align="center"><strong>解决 multi-agent / multi-provider / project switching 下 prompt cache 失效的 OpenCode 插件</strong></p>
<p align="center">稳定 system blocks 放前面；handoff、memory、date、workspace state 等动态内容放后面。</p>
<p align="center">提升 prompt cache 命中率 <strong>40–88%</strong><br>OpenCode 零配置 · 零内容依赖 · 核心引擎 CLI 无关</p>
<p align="center"><a href="README.md">English</a> | <strong>中文</strong></p>

---

## 🎯 真正解决什么问题？

DeepSeek、Anthropic、OpenAI、Google 等 LLM provider 的 KV cache 都依赖
**前缀匹配**：prompt 开头必须和之前请求一致，provider 才能复用已经计算过的
KV 状态。

Agent prompt 经常刚好相反：动态内容在最前面，稳定但昂贵的内容在后面。

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

真实使用里，这些场景最容易打爆 prefix cache：

| 场景                                | 为什么 cache 失效                                   | 这个项目如何帮助                                      |
| ----------------------------------- | --------------------------------------------------- | ----------------------------------------------------- |
| Multi-agent 编排                    | planner / fixer / explorer 的 handoff 每次都不同    | 按 `provider__model__agent` scope 分别追踪稳定性      |
| Multi-provider / multi-model        | DeepSeek、Anthropic、OpenAI 和不同模型预热状态不同  | 保留分 scope 的 cache metrics 和 warm hashes          |
| Project / workspace / worktree 切换 | repo path、memory、date、workspace context 经常变化 | 把稳定 repo/tool/agent blocks 移到动态 workspace 前面 |
| 大型 MCP / tool / skill prompt      | 静态工具 schema 很大，但被前面的动态内容拖累        | 拆分大 blocks，把稳定 hashes 固定到前缀               |
| Handoff / memory-heavy session      | 任务状态每轮都变                                    | 保留 handoff/memory，但放到可缓存 blocks 后面         |

它**不压缩 prompt，不总结指令，也不读取 prompt 内容**。它只对 system blocks
做 hash，学习哪些 block 稳定，然后重排顺序，让 provider 的 prefix cache 真正生效。

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

```bash
agent-cache-optimizer status
agent-cache-optimizer status --json
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

### v0.6.1 真实 DeepSeek 运行结果（2026-06-26）

`v0.6.1` tag 记录了本地 OpenCode 运行中的 provider 上报缓存指标，测试时使用的过滤命令为：

```bash
cat ~/.cache/opencode/agent-cache-optimizer/diag.log \
  | grep hit \
  | grep 2026-06-26 \
  | grep deepseek__deepseek
```

过滤后共有 **309 条 cache hit 指标样本**：

| Scope                              | 样本数 | 观测命中率 | 最新指标                                         |
| ---------------------------------- | ------ | ---------- | ------------------------------------------------ |
| `deepseek-v4-pro` / `orchestrator` | 86     | 98.0-98.3% | 98.1% 命中率，39,084,800 cache-read tokens       |
| `deepseek-v4-flash` / `fixer`      | 196    | 86.1-99.2% | 99.0% 命中率，21,218,432 cache-read tokens       |
| `deepseek-v4-flash` / `explorer`   | 27     | 0.0-90.3%  | 预热后 90.3% 命中率，1,229,696 cache-read tokens |

其中 `explorer` scope 展示了冷启动效果：第一条样本为 0.0%，provider cache
预热后提升到 90%+ 命中率。

## 🔌 支持的平台

| 平台            | 状态                | 适配器                                             |
| --------------- | ------------------- | -------------------------------------------------- |
| **OpenCode**    | ✅ 原生插件         | `src/index.ts`                                     |
| **Claude Code** | ✅ 伴随插件 + 指南  | [adapters/claude-code.md](adapters/claude-code.md) |
| **Codex**       | ✅ 伴随插件 + skill | `.codex-plugin/plugin.json` + `skills/`            |
| **Gemini CLI**  | 🔜 计划中           | Google context caching                             |

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
A: 核心引擎是 CLI 无关的。OpenCode 支持自动重排，Claude Code 提供伴随插件
和优化指南，Codex 提供伴随插件和 status skill。Gemini CLI 指南在计划中。

**Q: 如果 prompt 内容变化了怎么办？**
A: 哈希追踪会自动适应。之前稳定的 block 如果开始变化，其分数会下降并移到动态区。
如果新增了稳定 block，几次观测后就会收敛到稳定区。

**Q: 支持 Anthropic prompt caching 吗？**
A: 支持。`chat.headers` hook 会自动为 Anthropic provider 添加
`prompt-caching-2024-07-31` beta header。

## ⭐ Star History

<a href="https://www.star-history.com/#uuie/agent-cache-optimizer&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=uuie/agent-cache-optimizer&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=uuie/agent-cache-optimizer&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=uuie/agent-cache-optimizer&type=Date" />
  </picture>
</a>

## 📄 License

MIT — 随便用、随便改、随便发、记得点 star ⭐

---

<p align="center">
  <sub>为 LLM CLI 生态而建。如果帮你省了 tokens，</sub><br>
  <sub>点个 ⭐ 让更多人看到它。</sub>
</p>

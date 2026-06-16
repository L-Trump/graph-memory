<div align="center">

# 🧠 Graph Memory · OpenClaw Plugin

**面向 [OpenClaw](https://github.com/openclaw/openclaw) Agent 的知识图谱语义记忆**

*让你的 agent 拥有结构化长期记忆：事实、流程、经验、主题、置信度和关系 —— 跨会话、跨时间保留。*

Graph Memory 是 hook-only OpenClaw 插件：它把长期语义知识提取到 SQLite 知识图谱中，通过 embedding/FTS + 图排序召回，并在符合条件的 turn 前注入紧凑的 `<gm_memory>` 上下文。

[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue)](https://github.com/openclaw/openclaw)
[![OpenClaw 2026.5.28+](https://img.shields.io/badge/OpenClaw-2026.5.28%2B-brightgreen)](https://github.com/openclaw/openclaw)
[![Version](https://img.shields.io/badge/version-3.0.0-0f766e)](CHANGELOG.md)
[![SQLite](https://img.shields.io/badge/SQLite-Knowledge%20Graph-orange)](https://www.sqlite.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[English](README.md) | **简体中文**

</div>

---

![Graph Memory hero](docs/images/hero.png)

## 为什么需要 Graph Memory？

很多 agent 记忆系统要么重放 transcript 片段，要么检索孤立文本块。这很有用，但当助手需要记住**关系**时还不够：

- 哪个方案修复了哪个故障；
- 哪个流程依赖哪个工具；
- 哪个用户偏好只适用于哪个 scope；
- 哪个节点可信、被反驳、过期、hot 或 deprecated；
- 哪些主题在多轮会话中涌现。

**Graph Memory** 会把长期对话知识变成 typed graph。它存储节点、边、置信信号、provenance、访问元数据、PageRank 和 embedding，并在需要时召回紧凑子图。

### 没有 Graph Memory

> **你：** “改这个插件时，不要直接动 runtime extension。先在 Codes checkout 里改。”
> *两周后*
> **Agent：** “我可以直接 patch extension 然后重启 Gateway。” 😬

### 有 Graph Memory

> **你：** “改这个插件时，不要直接动 runtime extension。先在 Codes checkout 里改。”
> *稍后 —— Graph Memory 召回规则和相关部署边界*
> **Agent：** “我只会在开发 checkout 里工作。同步 runtime 和重启 Gateway 是单独授权的部署步骤。” ✅

这就是它的定位：长期语义记忆，而不是原始 transcript replay。

---

## 你能得到什么

| 能力 | 含义 |
|---|---|
| **知识图谱记忆** | 存储 `TASK`、`SKILL`、`EVENT`、`KNOWLEDGE`、`STATUS`、`TOPIC`、`SESSION` 节点和类型化边。 |
| **跨会话语义召回** | 使用 embedding 或 FTS5 seed、graph walk、Personalized PageRank、全局 PageRank、关键词评分和访问衰减。 |
| **稳定层 + 动态层** | 将始终可见的 `hot` / `scope_hot` 与每轮 `L1/L2/L3` 召回分开注入。 |
| **置信/可靠性信号** | 跟踪 supported/contradicted 证据和 belief 分数，避免把所有提取内容都视为同等可信。 |
| **Scope 感知可见性** | 支持全局 hot 记忆和 session-scope hot 记忆，适合项目/群组级规则。 |
| **运行时控制** | `/gm status`、`/gm on`、`/gm off`、chat allow/deny、cache、timeout、circuit breaker。 |
| **有预算的维护** | Retention cleanup、增量向量去重、pair/merge budget、PageRank refresh。 |
| **Agent 工具** | 22 个 `gm_*` 工具，用于搜索、记录、编辑、图探索、embedding、主题归纳和维护。 |
| **独立诊断日志** | 常规指标可写入 `/tmp/openclaw/graph-memory-YYYY-MM-DD.log`，warning/error 仍保留在 host logs。 |

---

## Graph Memory 与其他 OpenClaw 记忆层

| 层 | 最适合 | 保存精确 transcript？ | 保存图关系？ | 注入上下文？ |
|---|---|:---:|:---:|:---:|
| **Graph Memory** | 长期语义事实、流程、经验、偏好、主题、关系 | 否 | ✅ 是 | ✅ 是 |
| **lossless-claw / ContextEngine** | 精确 transcript、compaction lineage、原始命令/工具输出证据 | ✅ 是 | 否 | ✅ 是 |
| **active-memory** | 基于工具召回的轻量近期记忆摘要 | 部分 | 否 | ✅ 是 |
| **手动笔记/文件** | 人类维护的 source of truth | 取决于文件 | 否 | 通过其他工具 |

**经验法则：** Graph Memory 负责“什么应该作为知识被记住”；lossless context 负责“当时到底发生了什么”。

---

## 快速开始

### 方式 A：源码 checkout / 开发安装

```bash
npm install
npm run build
```

然后在 OpenClaw 插件配置中启用。最小配置：

```json
{
  "plugins": {
    "entries": {
      "graph-memory": {
        "enabled": true,
        "config": {
          "dbPath": "~/.openclaw/graph-memory.db"
        }
      }
    }
  }
}
```

### 方式 B：Runtime extension copy

如果把 Graph Memory 作为本地 OpenClaw extension 运行，需要先构建 `dist/index.js`，再把源码/构建产物复制到配置的 extension 目录；如运行环境有缓存，清理相关缓存后重启 Gateway。

> Runtime sync 和 Gateway restart 是运维动作。生产中应作为单独授权的部署步骤执行，不应混在普通源码编辑里。

### 验证

启用插件后，在 OpenClaw session 中运行：

```text
/gm status
```

期望看到类似状态：

```text
Graph Memory: global=on recall=on extract=on
chatType=direct|group|channel|explicit eligibility=yes
recallTimeoutMs=20000 cacheEntries=...
```

然后尝试：

```text
gm_search("之前讨论过的主题")
gm_record("一条需要长期记住的事实、流程或经验。")
```

---

## AI-safe 安装注意事项

如果你让 AI assistant 帮忙安装或配置插件，**不要让它猜路径或当前配置**。先检查真实环境。

建议检查：

```bash
openclaw status
openclaw config get plugins.entries.graph-memory
openclaw config get plugins.load.paths
openclaw config get plugins.slots.contextEngine
```

指南：

- 除非已经确认 active workspace，否则 `plugins.load.paths` 优先使用绝对路径。
- API keys 应放在 OpenClaw SecretRef 或环境 secret 中；不要提交明文 key。
- 运行 maintenance、migration、bulk merge 或 re-embedding 前，先确认配置的 `dbPath`。
- SQLite 备份应保持一致。WAL 模式下使用 SQLite backup API，或一起处理 `-wal` / `-shm`。
- 只有在明确部署 runtime change 时才重启 Gateway。

---

## 推荐生产配置

```json
{
  "plugins": {
    "entries": {
      "graph-memory": {
        "enabled": true,
        "config": {
          "enabled": true,
          "recallEnabled": true,
          "extractionEnabled": true,
          "allowedChatTypes": ["direct", "group", "channel", "explicit"],
          "allowedChatIds": [],
          "deniedChatIds": [],

          "dbPath": "~/.openclaw/graph-memory.db",

          "autoRecallMode": "full",
          "recallTimeoutMs": 20000,
          "recallCacheTtlMs": 15000,
          "recallCircuitBreakerMaxTimeouts": 3,
          "recallCircuitBreakerCooldownMs": 60000,
          "recallMaxNodes": 15,
          "recallMaxDepth": 2,

          "embedding": {
            "apiKey": { "secretRef": "openclaw:graph-memory.embedding.apiKey" },
            "model": "text-embedding-3-small",
            "baseURL": "https://api.openai.com/v1"
          },
          "llm": {
            "apiKey": { "secretRef": "openclaw:graph-memory.llm.apiKey" },
            "model": "gpt-4o-mini",
            "baseURL": "https://api.openai.com/v1"
          },

          "dedupThreshold": 0.9,
          "dedupMaxPendingVectorsPerRun": 2000,
          "dedupMaxPairsPerRun": 1000,
          "dedupMaxMergesPerRun": 200,
          "pagerankDamping": 0.85,
          "pagerankIterations": 20,

          "retention": {
            "enabled": true,
            "retentionDays": 30,
            "maxDeletePerRun": 20000,
            "vacuum": false
          },

          "independentLogFile": {
            "enabled": true,
            "maxFileBytes": 104857600
          }
        }
      }
    }
  }
}
```

说明：

- 不配置 `embedding` 时，召回会回退到 SQLite FTS5。
- 不配置 `llm` 时，extraction/induction 会尽量使用运行时可用的 OpenClaw 模型路径。
- `autoRecallMode: "index"` 可减少 dynamic prepend 抖动，但会改变 recall context 插入位置。
- `allowedChatTypes` 默认覆盖所有自动化类型：`direct`、`group`、`channel`、`explicit`。

完整配置参考见 [docs/configuration.md](docs/configuration.md)。

---

## 架构

```text
┌──────────────────────────────────────────────────────────────────────┐
│                           index.ts (Entry)                          │
│  register plugin · normalize config · hooks · commands · gm_* tools │
└───────────┬───────────────┬────────────────┬───────────────────────┘
            │               │                │
            │ recall         │ extraction      │ operations/tools
            │               │                │
┌───────────▼──────────┐ ┌──▼────────────────┐ ┌──────────────────────┐
│ src/recaller/recall  │ │ extractor/extract │ │ registerTool blocks  │
│ embed/FTS seeds      │ │ LLM → nodes/edges │ │ gm_search/record/... │
│ graph walk + PPR     │ │ belief updates    │ │ gm_maintain/...     │
└───────────┬──────────┘ └──┬────────────────┘ └──────────┬───────────┘
            │               │                              │
┌───────────▼───────────────▼──────────────────────────────▼──────────┐
│                         SQLite Store                                │
│ gm_nodes · gm_edges · gm_vectors · gm_messages · gm_recalled        │
│ belief signals · scope/session metadata · dedup tracking            │
└───────────┬───────────────────────────────┬─────────────────────────┘
            │                               │
┌───────────▼──────────┐       ┌────────────▼─────────────┐
│ format/assemble      │       │ graph/maintenance        │
│ stable/dynamic XML   │       │ retention · dedup · PR   │
└──────────────────────┘       └──────────────────────────┘
```

### Hook 生命周期

| Hook | 用途 |
|---|---|
| `before_prompt_build` | 检查 eligibility、召回图谱上下文、组装 stable/dynamic memory、写入状态行。 |
| `before_message_write` | `autoRecallMode=index` 时，把紧凑 recall index 前置到 user message。 |
| `agent_end` | 保存新消息、提取节点/边、应用 belief updates、周期性维护。 |
| `before_compaction` / `after_compaction` | 保留/提取 active session material，维持 compact-active 连续性。 |
| `subagent_spawned` / `subagent_ended` | 保持 parent/child memory continuity。 |
| `session_end` | 最终提取、topic/session induction、maintenance、task-completed belief signals。 |

<details>
<summary><strong>文件说明（点击展开）</strong></summary>

| 文件 | 用途 |
|---|---|
| `index.ts` | 插件入口、runtime config normalization、OpenClaw hooks、`/gm` command、status/debug lines、所有 `gm_*` 工具注册。 |
| `openclaw.plugin.json` | 插件 metadata、config schema、UI hints。 |
| `src/types.ts` | Runtime types 和 `DEFAULT_CONFIG`。 |
| `src/store/db.ts` | SQLite open/migration/index lifecycle。 |
| `src/store/store.ts` | Node/edge/vector/message/recalled-row persistence APIs。 |
| `src/recaller/recall.ts` | 精确召回：embedding/FTS seeds、graph walk、PPR、scoring、decay、tier assignment。 |
| `src/recaller/score.ts` | Recall scoring helpers。 |
| `src/format/assemble.ts` | Stable/dynamic/context-index XML rendering。 |
| `src/extractor/extract.ts` | LLM extraction into graph nodes/edges and belief updates。 |
| `src/extractor/noise-filter.ts` | Persistence/extraction 前的 input/output noise filtering。 |
| `src/engine/embed.ts` | Embedding API abstraction and vector generation。 |
| `src/engine/llm.ts` | Extraction/induction 用 LLM helpers。 |
| `src/engine/induction.ts` | Topic/session induction。 |
| `src/engine/decay.ts` | Access/recency/intrinsic decay model。 |
| `src/graph/dedup.ts` | Incremental vector dedup and merge candidate handling。 |
| `src/graph/pagerank.ts` | Global PageRank computation。 |
| `src/graph/maintenance.ts` | Retention、dedup、PageRank orchestration。 |
| `src/logger.ts` | Independent async JSONL log writer。 |
| `test/*.test.ts` | Vitest tests：store、graph、recall、config、runtime controls、belief、decay、integration paths。 |

</details>

更深入说明见 [docs/architecture.md](docs/architecture.md)。

---

## 核心功能

### 1. 知识图谱提取

Graph Memory 提取结构化语义知识，而不是原始 transcript chunks。

```text
conversation messages
  → noise filter
  → LLM extraction
  → nodes: TASK/SKILL/EVENT/KNOWLEDGE/STATUS/TOPIC/SESSION
  → edges: 使用 / 依赖 / 修复 / 冲突 / 扩展 / ...
  → belief updates and provenance
```

每个节点可携带 content、description、confidence/belief、flags、source sessions、access metadata、embedding 和 PageRank。

### 2. 精确图谱召回

```text
Query → embedding or FTS5 seeds ─┐
                                  ├→ graph walk → Personalized PageRank → scoring → tiers
Global PageRank + keyword match ──┘
```

综合评分使用语义相关性、局部 PPR、全局 PageRank、关键词重合，以及 decay/access 信号。输出分层：

| Tier | 注入细节 | 典型用途 |
|---|---|---|
| `L1` | 完整内容 | 当前推理需要的高度相关记忆。 |
| `L2` | 仅 description | 有用上下文，但不注入完整 payload。 |
| `L3` | 仅 name | 提醒相关知识存在。 |
| `filtered` | 不注入 | 内部候选。 |

### 3. 稳定层 + 动态层上下文

稳定层设计为 prefix-stable：

- 全局 `hot` 节点；
- scope-specific `scope_hot` 节点；
- 启用时的 compact-active 节点。

动态层每轮变化：

- 当前 recall 的 L1/L2/L3 节点；
- 相关边；
- 可选 recall index 模式。

注入块示例：

```xml
<gm_memory>
  <knowledge_graph>
    <knowledge name="runtime-sync-boundary" tier="hot" confidence="0.98">
      Work in the development checkout first; runtime extension sync requires explicit authorization.
    </knowledge>
    <skill name="sqlite-wal-backup" tier="l1" confidence="0.90">
      Back up SQLite WAL databases with the backup API or include -wal/-shm consistently.
    </skill>
    <event name="dedup-backlog-drained" tier="l2" desc="Incremental vector dedup pending count reached zero." />
    <task name="future-pagerank-optimization" tier="l3" />
    <edges>
      <e name="supports" from="sqlite-wal-backup" to="runtime-sync-boundary" />
    </edges>
  </knowledge_graph>
</gm_memory>
```

### 4. Scope Hot 与 Hot Memory

`hot` 和 `scope_hot` 用于不应依赖语义召回的高优先级记忆。

- `hot`：每个 session 可见。
- `scope_hot:<scope>`：仅 session scope 匹配时可见。
- 普通记忆不应主动标 hot，除非用户明确要求。

### 5. Belief 与可靠性跟踪

Belief system 跟踪 supported/contradicted signals 和 0-1 belief score，让图谱能表达不确定性和矛盾证据，而不是把每次提取都视作同等可信。

### 6. Runtime Controls 与 Eligibility

```text
/gm status
/gm on [all|recall|extract]
/gm off [all|recall|extract]
/gm help
```

自动化由这些条件 gate：

- global `enabled`；
- `recallEnabled` / `extractionEnabled`；
- per-session toggles；
- `allowedChatTypes`；
- `allowedChatIds` / `deniedChatIds`。

### 7. Resilience：Cache、Timeout、Circuit Breaker

`before_prompt_build` recall 受这些机制保护：

- mode-aware in-memory cache；
- `recallTimeoutMs` hook latency budget；
- consecutive-timeout circuit breaker；
- bounded cache/circuit maps；
- status/debug visibility。

Timeout 只限制 hook latency，不会神奇取消已经运行的同步 SQLite 或 JavaScript 工作。

### 8. 有界维护

Maintenance 包括：

- inactive-session raw bookkeeping rows 的 retention cleanup；
- 增量向量 dedup；
- PageRank refresh；
- 可选 topic/session induction paths。

Dedup 预算：

| Config | 作用 |
|---|---|
| `dedupMaxPendingVectorsPerRun` | 每次 maintenance 检查的新增/变更向量数。`0` 回退到全量扫描。 |
| `dedupMaxPairsPerRun` | 每轮返回/处理的重复候选 pair 上限。 |
| `dedupMaxMergesPerRun` | 每轮实际 merge 上限。 |

---

## Agent 工具

Graph Memory 注册 **22 个 `gm_*` 工具**。

| 类别 | 工具 |
|---|---|
| 搜索和查看 | `gm_search`, `gm_get_node`, `gm_explore`, `gm_stats`, `gm_get_flags` |
| 记录和编辑 | `gm_record`, `gm_edit_node`, `gm_remove`, `gm_merge` |
| Hot/scope 可见性 | `gm_get_hots`, `gm_set_hot`, `gm_set_flags`, `gm_get_scope`, `gm_set_scope`, `gm_get_scope_hots`, `gm_set_scope_hot`, `gm_list_scopes` |
| Embedding 和维护 | `gm_maintain`, `gm_embedding`, `gm_reembedding_all` |
| 高层图谱整理 | `gm_induce_topics`, `gm_dream` |

常见流程：

```text
# 遇到可能之前解决过的问题，先搜索
gm_search("graph memory dedup performance")

# 查看精确节点
gm_get_node("runtime-sync-boundary")

# 显式记录长期经验
gm_record("When changing graph-memory config defaults, update src/types.ts and openclaw.plugin.json together.")

# 探索相关节点/边
gm_explore("sqlite-wal-backup")

# 手动维护
gm_maintain()
```

工具细节见 [docs/agent-tools.md](docs/agent-tools.md)。

---

## 运维

### 数据库生命周期

- 默认路径：`~/.openclaw/graph-memory.db`。
- 打开数据库时自动运行 migrations。
- schema migration、bulk merge、full re-embedding、手动恢复或有风险的维护实验前应先备份。
- `gm_remove()` 会 deprecate 节点；不会抹除所有历史证据。
- Retention cleanup 删除 inactive sessions 的旧 `gm_messages` 和 `gm_recalled` 行；不会删除语义节点/边。

### 维护指标

启用 independent logging 后，常规日志写入每日 JSONL 文件，通常是：

```text
/tmp/openclaw/graph-memory-YYYY-MM-DD.log
```

常用字段：

```text
dedup_mode=incremental
dedup_pending_before=23069
dedup_pending_after=21069
dedup_checked=2000
dedup_comparisons=698300
dedup_pairs=0
dedup_merged=0
dedup_ms=6287
pagerank_ms=6054
```

### 性能调优速查

| 现象 | 优先检查 |
|---|---|
| Recall 太慢 | `recallTimeoutMs`、`recallMaxNodes`、`recallMaxDepth`、cache TTL、embedding latency、vector table size。 |
| Maintenance 太慢 | `dedupMaxPendingVectorsPerRun`、`dedupMaxPairsPerRun`、`dedupMaxMergesPerRun`、`pagerankIterations`。 |
| Prompt context 太多 | `recallMaxNodes`、`autoRecallMode`、hot/scope-hot 数量、compact-active 设置。 |
| 召回太少 | embedding config、FTS fallback、query quality、`allowedChatTypes`、`/gm status`、cache/circuit state。 |
| 敏感 chat 不应自动化 | `deniedChatIds`、`allowedChatIds`、`/gm off all`、global `enabled=false`。 |

---

## 排障

### 没有召回记忆

1. 运行 `/gm status`。
2. 检查 `global=on`、`recall=on`、`eligibility=yes`。
3. 检查 `allowedChatTypes`、`allowedChatIds`、`deniedChatIds`。
4. 确认 embedding 已配置，或确认应使用 FTS5 fallback。
5. 查看 independent log 和 status/debug lines 中的 timeout/circuit/cache 状态。

### 没有提取

1. 查看 `/gm status` 的 extraction toggle。
2. 确认 session/chat eligibility。
3. 确认 LLM/extraction 配置。
4. 检查 noise filters 和 extraction recent-turn window。
5. 查看 host warning/error 和 Graph Memory log。

### Maintenance 慢

1. 查看 `dedup_*` 和 `pagerank_ms` 字段。
2. 如果 hooks 受影响，降低 per-run dedup budgets。
3. 如果要在计划维护窗口快速清 backlog，提高 `dedupMaxPendingVectorsPerRun`。
4. 如果 PageRank 占主要时间，降低 `pagerankIterations`。
5. 避免活跃使用期间 full re-embedding。

### 数据库锁或可疑状态

1. 停止并发 maintenance。
2. 备份数据库，WAL/SHM 如适用也要一致处理。
3. 用合适工具运行 SQLite integrity checks。
4. 不要在没有 rollback plan 时手写 SQL 改库。

更多见 [docs/diagnostics.md](docs/diagnostics.md)。

---

## 开发

```bash
npm install
npm test
npm run build
```

Release-sensitive gate：

```bash
npm test
npm run build
git diff --check
```

部分 real-database 或 real-model tests 依赖本地状态或环境变量。除非改动触及相关集成，不要把它们作为普通确定性开发的强制 gate。

推荐流程：

1. 在 development checkout 中修改源码。
2. 配置变更同时更新 `src/types.ts` 和 `openclaw.plugin.json`。
3. 添加 targeted tests。
4. 先跑 targeted tests，再跑 full tests/build。
5. 提交 source/docs changes。
6. Runtime sync 和 Gateway restart 是单独授权的部署动作。

见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## FAQ

**Graph Memory 会保存精确对话历史吗？**
不会。它保存语义图谱记忆。精确 transcript/source-message evidence 应交给 lossless context engine。

**必须配置 embedding 吗？**
不必须，但 embedding 会改善语义召回。不配置时回退到 SQLite FTS5。

**会拖慢 prompt 吗？**
Recall 会在 prompt build 前工作。使用 timeout/cache/circuit-breaker 和 recall size/depth budget 控制延迟。

**可以删除错误记忆吗？**
可以。用 `gm_remove` deprecate 节点，或用 `gm_edit_node` / `gm_merge` 修正和合并。

**什么应该标记为 `hot`？**
只有高优先级、广泛适用、必须始终注入的记忆。保持稀缺。

**可以和 lossless-claw 一起用吗？**
可以。Graph Memory 保存语义知识；lossless-claw 保存精确历史和 compaction lineage。

---

## 术语表

- **Hot node**：全局 pinned memory，每个 eligible session 都会注入。
- **Scope-hot node**：仅在当前 session 匹配 scope 时注入的 pinned memory。
- **L1/L2/L3**：动态召回层级；L1 完整内容，L2 描述，L3 仅名称。
- **PPR**：召回局部图上的 Personalized PageRank。
- **Decay**：基于 access/recency/intrinsic-value 的排序调整，不删除节点。
- **Dedup**：基于向量相似度的重复检测与合并支持。
- **Recall index**：`autoRecallMode=index` 下写入 user message 的紧凑索引。
- **Deprecated node**：从正常 active 使用中隐藏的节点，不一定抹除所有证据。

---

## 文档

- [架构](docs/architecture.md)
- [配置](docs/configuration.md)
- [诊断](docs/diagnostics.md)
- [Agent tools](docs/agent-tools.md)
- [OpenClaw integration playbook](docs/openclaw-integration-playbook.md)
- [Release checklist](docs/release-checklist.md)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

---

## 安全与隐私

Graph Memory 可能持久化长期语义数据：节点、边、description、content、metadata、embedding、访问时间戳、source-session IDs，以及有限 raw bookkeeping rows。它不应持久化 raw secrets、临时注入上下文，或不需要长期保存的跨会话隐私细节。

隐私边界明确时可使用：

- global：`enabled=false`、`recallEnabled=false` 或 `extractionEnabled=false`；
- session：`/gm off recall`、`/gm off extract`、`/gm off all`；
- routing：`allowedChatTypes`、`allowedChatIds`、`deniedChatIds`；
- correction：`gm_remove`、`gm_edit_node`、`gm_merge`；
- secrets：OpenClaw SecretRef 或环境 secret 管理。

当前文件、代码、服务、package state 和系统配置都是实时事实。请直接验证，不要从记忆中推断。

---

## 状态与兼容性

- Package version：`3.0.0`
- OpenClaw peer dependency：`^2026.5.28`
- Runtime：Node.js `>=18`
- Storage：SQLite via `@photostructure/sqlite`
- Repository：<https://github.com/adoresever/graph-memory>
- Issues：<https://github.com/adoresever/graph-memory/issues>

---

## 许可证

MIT。见 [LICENSE](LICENSE)。

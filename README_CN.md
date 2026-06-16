# Graph Memory

[![许可证：MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![OpenClaw](https://img.shields.io/badge/OpenClaw-%5E2026.5.28-7c3aed)
![版本](https://img.shields.io/badge/version-3.0.0-0f766e)
![Node](https://img.shields.io/badge/node-%3E%3D18-339933)

![Graph Memory hero](docs/images/hero.png)

Graph Memory 是 OpenClaw 的 hook-only 语义记忆插件：它从对话中提取长期知识，写入 SQLite 知识图谱，在后续会话中召回相关节点，并把紧凑的图谱上下文注入给符合条件的 agent turn。

它适合保存**语义记忆**：工作流、偏好、项目知识、踩坑经验、可复用事实。它不是原始 transcript 的无损保存系统；原始对话保留、证据追溯和 compaction lineage 应交给 lossless-claw 等 context engine。

> `README.md` 是项目 README 的 source of truth；本中文 README 尽量同步，但发布前仍应以英文版为准复核。

## 为什么需要 Graph Memory

长期运行的 agent 不能只依赖更大的上下文窗口。它们需要一种持久方式来记住偏好、项目决策、调试经验、可复用流程，以及事实之间的关系，同时又不必反复重放完整 transcript。

Graph Memory 会把被选中的对话知识转成 typed graph：可以搜索、排序、遍历、纠错和维护。它适合解决“助手总是重新发现同一段上下文”的问题；而精确原文、命令、工具输出和证据链仍应由无损上下文系统处理。

## 目录

- [Highlights](#highlights)
- [它做什么](#它做什么)
- [它如何配合 OpenClaw](#它如何配合-openclaw)
- [安装](#安装)
- [快速开始](#快速开始)
- [运行时开关](#运行时开关)
- [架构速览](#架构速览)
- [文档](#文档)
- [常见操作](#常见操作)
- [运维](#运维)
- [排障](#排障)
- [FAQ](#faq)
- [开发](#开发)
- [术语表](#术语表)
- [安全与隐私](#安全与隐私)
- [状态与兼容性](#状态与兼容性)
- [许可证](#许可证)

## Highlights

- **知识图谱，而不是 transcript replay**：在 SQLite 中存储长期语义节点和类型化关系边，并带有来源、置信信号、访问元数据和 PageRank 分数。
- **Hook-only OpenClaw 集成**：通过 OpenClaw hooks 与工具运行在所选 context engine 旁边，不替代 transcript assembly 或 compaction。
- **精确跨会话召回**：结合 embedding 或 FTS5 seed search、图遍历、Personalized PageRank、全局 PageRank、关键词评分和访问衰减。
- **稳定层 + 动态层注入**：把始终可见的 `hot` / `scope_hot` 与每轮召回的 `L1/L2/L3` 分层，保持 prompt 紧凑且可预期。
- **Agent 可操作工具面**：提供 `gm_*` 工具用于搜索、查看、显式记录、图探索、手动编辑、flags/scope、主题归纳、embedding 和维护。
- **运维安全控制**：支持全局与 session 级 recall/extraction 开关、chat allow/deny list、timeout、cache、circuit breaker 和独立插件日志。
- **有界维护**：retention cleanup、PageRank refresh 和增量向量去重都有预算控制，避免大图反复全量 dedup。
- **隐私导向设计**：长期语义记忆与原始 transcript 保存分离；临时注入上下文和 secret 不应被持久化为记忆。

## 它做什么

- 从对话中提取结构化节点（`TASK`、`SKILL`、`EVENT`、`KNOWLEDGE`、`STATUS`、`TOPIC`、`SESSION`）和具名关系边。
- 通过 embedding 或 FTS5、图遍历、Personalized PageRank、关键词混合评分和访问衰减进行跨会话召回。
- 将注入上下文拆成稳定层（`hot`、`scope_hot`、compact-active 节点）和动态召回层（`L1/L2/L3`）。
- 提供 `gm_*` 工具用于搜索、查看、编辑、flags、scope hot、embedding、维护、主题归纳和 dream 式图整理。
- 只通过 OpenClaw hooks 工作，不占用 `contextEngine` slot。

## 它如何配合 OpenClaw

Graph Memory 是 OpenClaw context engine 的补充，而不是替代：

- 用 Graph Memory 保存应跨 session 留存的长期语义知识；
- 用 lossless context tooling 保存精确 transcript、compaction lineage、命令、原始工具输出和证据；
- 文件、代码、服务状态、当前配置等实时事实必须直接验证，不能只凭记忆判断。

自动 recall/extraction 只在符合条件的 session 中运行。即使关闭自动化，工具仍可用。

## 安装

Graph Memory 是 OpenClaw 插件包。它要求 OpenClaw `^2026.5.28`，构建后的扩展入口为 `dist/index.js`。

开发或源码安装：

```bash
npm install
npm run build
```

然后在 OpenClaw 插件配置中启用。最小配置示例：

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

如果 embedding 或 extraction model 需要 API key，建议使用 OpenClaw SecretRef 配置，而不是明文 secret。完整 schema 见 [配置](docs/configuration.md)。

## 快速开始

1. 安装并启用插件。
2. 如不使用默认数据库路径，配置 `plugins.entries.graph-memory.config.dbPath`。
3. 可选配置 `embedding` 启用语义向量搜索；未配置时会降级为 FTS5。
4. 在会话中使用 `/gm status` 查看本 session 的 recall/extraction 开关。
5. 使用 `gm_search` / `gm_get_node` 查看记忆，使用 `gm_record` 显式记录长期知识。

## 运行时开关

```text
/gm status
/gm on [all|recall|extract]
/gm off [all|recall|extract]
/gm help
```

全局自动化由 `enabled`、`recallEnabled`、`extractionEnabled`、`allowedChatTypes`、`allowedChatIds`、`deniedChatIds` 控制。session 级开关会在可用时写入 OpenClaw keyed plugin state。

生产配置通常会显式设置 eligibility、延迟预算和 retention：

```json
{
  "enabled": true,
  "recallEnabled": true,
  "extractionEnabled": true,
  "allowedChatTypes": ["direct", "group", "channel", "explicit"],
  "allowedChatIds": [],
  "deniedChatIds": [],
  "recallTimeoutMs": 20000,
  "recallCacheTtlMs": 15000,
  "recallCircuitBreakerMaxTimeouts": 3,
  "recallCircuitBreakerCooldownMs": 60000,
  "autoRecallMode": "full",
  "recallMaxNodes": 15,
  "recallMaxDepth": 2,
  "dedupMaxPendingVectorsPerRun": 2000,
  "dedupMaxPairsPerRun": 1000,
  "dedupMaxMergesPerRun": 200,
  "retention": {
    "enabled": true,
    "retentionDays": 30,
    "maxDeletePerRun": 20000,
    "vacuum": false
  }
}
```

`embedding` 启用语义向量搜索；否则使用 FTS5 fallback。`llm` 可覆盖 extraction 与 topic induction 使用的模型。

## 架构速览

```text
eligible conversation turn
  → before_prompt_build: recall seeds + graph walk + ranking
  → stable/dynamic context injection
  → agent response
  → agent_end / compaction / session_end hooks
  → extraction via LLM
  → SQLite nodes, edges, vectors, access metadata
  → maintenance: retention, incremental dedup, PageRank
```

“Hook-only” 表示 Graph Memory 通过 OpenClaw 插件 hooks 和工具贡献记忆，而 transcript assembly 与 compaction 仍由所选 `contextEngine` 负责。`autoRecallMode=full` 时动态召回作为临时 prompt context 注入；`autoRecallMode=index` 时会把短 recall index 写入 user message，以改善 prefix-cache 稳定性。

![Graph UI example](docs/images/graph-ui.png)

## 文档

- [架构](docs/architecture.md)：hook 生命周期、存储模型、召回/提取流程、上下文注入层级。
- [配置](docs/configuration.md)：配置项、默认值、source-of-truth 和运维影响。
- [诊断](docs/diagnostics.md)：排查 recall、extraction、日志、eligibility、timeout 和数据库健康。
- [Agent 工具](docs/agent-tools.md)：`gm_*` 工具推荐用法和安全边界。

## 常见操作

### 工具地图

| 任务 | 工具 |
| --- | --- |
| 搜索和查看 | `gm_search`, `gm_get_node`, `gm_explore`, `gm_stats`, `gm_get_flags` |
| 记录和编辑 | `gm_record`, `gm_edit_node`, `gm_remove`, `gm_merge` |
| Hot/scope 可见性 | `gm_get_hots`, `gm_set_hot`, `gm_set_flags`, `gm_get_scope`, `gm_set_scope`, `gm_get_scope_hots`, `gm_set_scope_hot`, `gm_list_scopes` |
| Embedding 和维护 | `gm_maintain`, `gm_embedding`, `gm_reembedding_all` |
| 高层图谱整理 | `gm_induce_topics`, `gm_dream` |

详细工具说明见 [Agent 工具](docs/agent-tools.md)。

### 搜索和查看记忆

```text
gm_search("主题或问题")
gm_get_node("精确节点名")
gm_explore("精确节点名")
```

### 显式记录长期知识

```text
gm_record("用自然语言描述事实、流程或经验。")
```

除非用户明确要求，不要把记录标记为 `hot`。Hot / scope-hot 会被稳定注入，应保持稀缺。

### 维护图谱

```text
gm_maintain()
```

维护会重算图排名并执行去重/清理路径。`gm_reembedding_all` 成本较高，执行前应确认。

### 观察维护成本

启用独立日志后，插件常规指标会写入每日文件，例如：

```text
/tmp/openclaw/graph-memory-YYYY-MM-DD.log
```

常用维护字段：

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

大图运维时，`dedupMaxPendingVectorsPerRun`、`dedupMaxPairsPerRun`、`dedupMaxMergesPerRun`、`pagerankIterations` 和 retention 设置是主要预算旋钮。

### 注入上下文示例

Graph Memory 会向符合条件的 turn 注入紧凑的 XML-like context。简化示例：

```xml
<gm_memory>
  <knowledge_graph>
    <knowledge name="project-build-command" tier="hot" confidence="0.95">
      Use npm test and npm run build before syncing this plugin.
    </knowledge>
    <skill name="sqlite-wal-backup" tier="l1" confidence="0.90">
      Back up SQLite WAL databases with the backup API or include -wal/-shm consistently.
    </skill>
    <event name="dedup-backlog-drained" tier="l2" desc="Incremental vector dedup pending count reached zero." />
    <task name="future-pagerank-optimization" tier="l3" />
    <edges>
      <e name="supports" from="sqlite-wal-backup" to="project-build-command" />
    </edges>
  </knowledge_graph>
</gm_memory>
```

实际渲染的节点取决于 hot/scope-hot flags、召回结果、图排名、置信度和 token budget。

## 运维

- 默认 SQLite 数据库路径是 `~/.openclaw/graph-memory.db`；可通过 `dbPath` 调整。
- 插件打开数据库时会自动执行 schema migrations。大型 migration、批量 merge、全量 re-embedding 或手动恢复前应先备份数据库。
- `gm_maintain()` 负责 retention cleanup、增量向量去重和 PageRank refresh。Retention 删除 inactive sessions 的旧 `gm_messages` / `gm_recalled` 行；它不是语义节点/边删除策略。
- `gm_remove()` 会 deprecate 节点，而不是抹除所有历史证据。`gm_merge()` 会把有用内容/边迁移到保留节点并 deprecate 被合并节点。
- `gm_reembedding_all()` 成本较高，在大数据库上运行前应明确确认。
- SQLite 若处于 WAL 模式，备份应使用 SQLite backup API，或一致处理 `-wal` / `-shm` 文件。

## 排障

- 没有召回记忆：检查 `/gm status`、`recallEnabled`、chat eligibility、allow/deny list，以及 embedding 是否配置或是否预期使用 FTS5 fallback。
- 没有提取：检查 `extractionEnabled`、LLM 配置、session eligibility 和 Graph Memory 日志。
- 召回慢：查看 recall timing 日志、`recallTimeoutMs`、cache TTL、circuit breaker、`recallMaxNodes` 和 `recallMaxDepth`。
- 维护慢：查看独立日志中的 `dedup_*` 和 `pagerank_ms` 字段；调整 dedup budgets 和 PageRank 设置。
- 数据库错误或锁：停止并发维护，备份数据库，检查 SQLite integrity，并参考 [诊断](docs/diagnostics.md)。

## FAQ

**Graph Memory 会保存精确对话历史吗？**
不会。它保存语义图谱记忆。精确 transcript/source-message recall 应交给无损 context engine。

**Embedding 会产生成本吗？**
取决于配置的 provider。没有 embedding 时，Graph Memory 会回退到 SQLite FTS5。

**禁用插件后会发生什么？**
自动化会按全局或 session 开关停止。除非移除插件，否则已有数据库内容仍可通过工具访问。

**可以删除错误记忆吗？**
可以。使用 `gm_remove` deprecate 节点，或使用 `gm_edit_node` / `gm_merge` 修正和合并。

**它会拖慢 prompt 吗？**
Recall 会增加 hook 工作和 prompt context。可通过 `recallTimeoutMs`、cache/circuit breaker、`recallMaxNodes`、`recallMaxDepth` 和诊断日志调优。

**可以导出或备份记忆吗？**
主要存储是 `dbPath` 指向的 SQLite 数据库；请一致备份该数据库，WAL 模式下注意 `-wal` / `-shm`。

## 开发

```bash
npm test
npm run build
```

默认测试命令运行 Vitest suite。部分真实数据库、真实模型或探索性测试可能需要显式环境变量或本地凭据；除非改动触及这些集成，release gate 建议聚焦确定性测试和 `npm run build`。

代码修改应发生在开发 checkout 中，不要直接改运行中的 OpenClaw extensions 目录。同步到运行版和重启 Gateway 是运维动作，在本环境中需要用户明确授权。

推荐变更流程：

1. 修改配置默认值时，同步更新 source 和 manifest；
2. 对改动子系统运行 targeted tests；
3. release-sensitive 改动前运行完整 test suite；
4. 构建 `dist/index.js`；
5. review diff 并在开发 checkout 中提交；
6. 只有在单独获得授权后才同步到 runtime extension。

## 术语表

- **Hot node**：全局 pinned memory，始终注入，应谨慎使用。
- **Scope-hot node**：只在 session scope 匹配时注入的 pinned memory。
- **L1/L2/L3**：动态召回层级。L1 包含完整内容，L2 包含描述，L3 只包含名称。
- **PPR**：局部召回子图上的 Personalized PageRank。
- **Decay**：基于访问的排序调整，降低陈旧或低置信记忆权重，但不删除。
- **Dedup**：基于向量相似度的重复检测与合并支持。
- **Recall index**：`autoRecallMode=index` 下写入 user message 的短索引，用于替代较大的 dynamic prepend context。
- **Deprecated node**：从正常 active 使用中隐藏的节点，不一定抹除所有历史证据。

## 安全与隐私

Graph Memory 保存长期语义记忆：节点、边、metadata、vectors、访问时间戳，以及用于 extraction/recall bookkeeping 的有限 raw rows。它不应持久化临时注入上下文、原始 secret，或不需要长期保存的跨会话隐私细节。当前文件、代码、服务状态和系统配置属于实时事实，必须直接验证，不能只凭记忆判断。

隐私边界明确时可使用这些控制：

- 用 `enabled=false` 全局关闭自动化，或用 `recallEnabled=false` / `extractionEnabled=false` 分别关闭；
- 用 `/gm off recall`、`/gm off extract`、`/gm off all` 做 session 级停止；
- 用 `allowedChatTypes`、`allowedChatIds`、`deniedChatIds` 限制自动化；
- 用 `gm_remove` deprecate 错误或敏感节点；
- API keys 放入 OpenClaw SecretRef 配置。

## 状态与兼容性

Graph Memory 是活跃的 OpenClaw 插件包。当前包版本为 `3.0.0`，peer dependency 为 `openclaw ^2026.5.28`。运行时支持 Node.js `>=18`。

仓库：<https://github.com/adoresever/graph-memory>

Issue 与支持：<https://github.com/adoresever/graph-memory/issues>

## 许可证

见 [LICENSE](LICENSE)。

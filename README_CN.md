# graph-memory

<p align="center">
  <strong>OpenClaw 知识图谱上下文引擎插件</strong>
</p>

---

## 它解决什么问题

graph-memory 将对话转化为持久化知识图谱，并在之后的 OpenClaw 会话里把相关图谱上下文注入回来。

它主要解决：

1. **上下文爆炸** — 将旧的原始消息提炼成结构化节点和关系。
2. **跨会话失忆** — 过去的修复、决策、踩坑和流程可以在新会话中召回。
3. **经验孤岛** — 通过自由边类型把孤立记忆连起来，例如 `解决`、`使用`、`依赖`、`扩展`、`冲突`。

## 当前架构

```text
消息进入
  └─ ContextEngine.ingest(): 同步保存原始消息到 gm_messages，不调用 LLM

before_prompt_build hook
  ├─ Recaller.recallV2(): 仅精确召回路径
  ├─ saveRecalledNodes(): 将本轮召回节点写入 gm_recalled
  ├─ assembleStableContext(): scope_hot + hot + compact 后 active 节点 → appendSystemContext
  └─ assembleDynamicContext(): recalled L1/L2/L3 节点 → prependContext

afterTurn hook（异步后台，不阻塞用户回复）
  ├─ 保存新消息
  ├─ runTurnExtract(): LLM 提取 → gm_nodes + gm_edges
  ├─ beliefUpdates → gm_belief_signals + 节点 belief 更新
  ├─ syncEmbed(): 异步写 embedding；embedding 未就绪时进入队列
  ├─ advisorySuggestions → 可选后台 memory-advisor subagent
  └─ 每 compactTurnCount 轮：主题归纳 + session 归纳 + 轻量全局 PageRank

session_end hook
  ├─ finalize(): EVENT→SKILL 提升、补边、标记失效节点
  ├─ 主题归纳
  ├─ session 归纳：创建/更新 SESSION 节点
  ├─ runMaintenance(): retention 清理 → 向量去重 → 全局 PageRank
  └─ 对 session 节点记录 task_completed 置信度信号
```

### ContextEngine 接口

| 方法 | 当前行为 |
|------|----------|
| `bootstrap` | 轻量空初始化 |
| `ingest` | 同步保存消息到 `gm_messages`，不调用 LLM |
| `assemble` | 透传；KG 注入由 `before_prompt_build` 负责 |
| `compact` | 兜底提取路径；常规提取在 `afterTurn` |
| `afterTurn` | 主异步提取 + 周期性 topic/session/轻量维护 |
| `prepareSubagentSpawn` | 将当前召回图谱上下文共享给 subagent |
| `onSubagentEnded` | 清理 subagent session 状态 |
| `dispose` | 清理内存态 |


## 运行入口

graph-memory 通过两层入口接入 OpenClaw：

1. **ContextEngine 注册**

   ```ts
   api.registerContextEngine("graph-memory", () => engine)
   ```

   engine 实现 `bootstrap`、`ingest`、`assemble`、`compact`、`afterTurn`、`prepareSubagentSpawn`、`onSubagentEnded`、`dispose`。

2. **运行时 hooks 和 tools**

   - `api.on("before_prompt_build", ...)` 执行召回和 KG 上下文注入。
   - `api.on("session_end", ...)` 执行 finalize 和后台维护。
   - `api.registerTool(...)` 暴露 22 个 `gm_*` 工具。

因此 graph-memory 不是 CLI 循环，而是运行在 OpenClaw Gateway 生命周期中，随着 session 自动触发。

### 生命周期细节

| 入口 | 触发时机 | 主要工作 | 阻塞行为 |
|------|----------|----------|----------|
| `bootstrap` | Context engine 初始化 session | 轻量确认 | runtime await |
| `ingest` | 消息入库阶段 | 非 heartbeat 消息写入 `gm_messages` | 同步 DB 写入，无 LLM |
| `before_prompt_build` hook | 构造模型 prompt 前 | 根据最近历史和当前 prompt 并行召回，组装 stable/dynamic KG XML | await；返回 `appendSystemContext` / `prependContext` |
| `assemble` | ContextEngine assemble 阶段 | 只规范化 message content；KG 渲染已迁到 `before_prompt_build` | await |
| `compact` | runtime 压缩上下文 | 清理旧 `<gm_memory>`、兜底提取、标记 compact active nodes、把真正压缩交回 runtime | await，提取/归纳尽量后台化 |
| `afterTurn` | 每轮 assistant 回复后 | 保存新消息、触发提取、周期 topic/session 归纳、轻量 PageRank | 提取/topic induction 为 fire-and-forget；周期 session induction 当前会 await |
| `prepareSubagentSpawn` | 创建 subagent 前 | 将父 session 当前召回图谱复制给子 session | await |
| `onSubagentEnded` | 子 session 结束 | 清理子 session recalled/counter 内存态 | await |
| `session_end` hook | session 结束 | finalize、topic/session induction、retention+dedup+PageRank、belief signal | 启动 fire-and-forget 任务后快速返回 |
| `dispose` | 插件卸载 | 清理内存 map | await |

### before_prompt_build 细节

`before_prompt_build` 是主要注入入口：

1. 用 `cleanPrompt` 清理当前 prompt。
2. 构造两条召回 query：
   - `historyQuery`：最近 2 个以用户消息为边界的历史轮次，不包含当前 prompt。
   - `promptQuery`：清理后的当前用户 prompt。
3. 执行 `parallelRecall(recaller, historyQuery, promptQuery)` 并合并结果。
4. 将召回节点写入 `gm_recalled`，供 dream、retention 和调试使用。
5. 加载 stable 节点：
   - 全局 `hot` 节点；
   - 当前 session 绑定 scope 对应的 `scope_hot:<scope>` 节点；
   - compact 后需要继续保留的 active 节点。
6. `assembleStableContext` 渲染 stable context，`assembleDynamicContext` 渲染本轮 dynamic recall context。
7. 对 L1 节点记录访问次数和最后访问时间，用于遗忘/衰减机制。
8. 返回 stable KG 到 `appendSystemContext`，dynamic KG 到 `prependContext`。

### afterTurn 细节

`afterTurn` 是主要提取入口：

1. 清理 session file 中旧的 `<gm_memory>` 块。
2. 将新增消息写入 `gm_messages`，不调用 LLM。
3. 对新增消息触发 `runTurnExtract`。同一 session 内通过 `extractChain` 串行化，避免并发写入冲突。
4. 每 `compactTurnCount` 轮：
   - 后台执行 topic induction；
   - 对当前 session 执行 session induction；
   - 重新计算轻量全局 PageRank。

`runTurnExtract` 负责节点/边提取、belief 更新、embedding 同步和可选 memory-advisor 建议。

### session_end 细节

`session_end` 启动四类后台任务：

1. **Finalize**：提升可复用知识、补边、标记过时节点。
2. **Topic/session induction**：更新 TOPIC 和 SESSION 摘要。
3. **Maintenance**：retention cleanup、向量去重、全局 PageRank。
4. **Belief signal**：给 session 节点发出低权重 `task_completed` 证据。

## 当前功能

### 节点类型

| 类型 | 含义 |
|------|------|
| `TASK` | 用户要求完成的任务，含目标、步骤和结果 |
| `SKILL` | 可复用流程，含触发条件、步骤、常见错误 |
| `EVENT` | 一次性事故/错误，含现象、原因、修复 |
| `KNOWLEDGE` | 领域知识，含适用范围和注意事项 |
| `STATUS` | 时效性快照；语义上不做合并 |
| `TOPIC` | LLM 归纳出的主题节点，用于聚合相关语义节点 |
| `SESSION` | LLM 归纳出的会话摘要节点 |

### 边

边使用灵活 schema：

- `name`：自由关系名，由 LLM 或工具生成，例如 `使用`、`解决`、`依赖`、`扩展`、`冲突`、`来自会话`。
- `description`：一句话描述关系含义。

旧的固定枚举边会通过 `m7_edge_flexible` 迁移为灵活边。

### 召回路径

泛化/community 召回路径已经移除。当前只有精确路径：

```text
Query
  └─ embedding 就绪时向量搜索，否则 FTS5/LIKE 搜索
      ├─ 语义种子：top ceil(recallMaxNodes / 3)
      ├─ PageRank 候选：top ceil(recallMaxNodes / 5)，只作为图扩展锚点
      ├─ graphWalk(maxDepth = recallMaxDepth)：迭代 BFS，N 表示走 N 跳
      ├─ 从语义种子出发做 Personalized PageRank
      ├─ combinedScore = semantic × 0.5 + PPR × 0.4 + PageRank × 0.1
      ├─ decayEnabled !== false 时应用访问衰减评分
      └─ 分层：L1 / L2 / L3 / filtered
```

`before_prompt_build` 会跑两次 recall：一次基于最近 2 个用户边界历史轮次，一次基于当前 prompt，然后按节点名和 tier 优先级合并。合并后的召回结果会写入 `gm_recalled`；只有 L1 节点在 assemble 后更新 access tracking。

PPR teleport 回语义种子。全局 PageRank 候选只作为扩展锚点，不作为 PPR seed。PPR dangling mass 也回到语义种子。

关键词混合语义评分：

```text
hybridSemantic = vectorSim × (1 - KEYWORD_WEIGHT + keywordScore × KEYWORD_WEIGHT)
KEYWORD_WEIGHT = 0.4
```

`graphWalk(maxDepth=N)` 的语义是“走 N 跳”：

- `maxDepth=0`：只有种子节点
- `maxDepth=1`：种子 + 一跳邻居
- `maxDepth=2`：种子 + 一跳 + 二跳邻居

### 分层上下文注入

| Tier | 注入/渲染行为 |
|------|---------------|
| `scope_hot` | 稳定层；完整 description + content；仅在 session 绑定对应 scope 时渲染 |
| `hot` | 稳定层；完整 description + content；每个 session 都渲染 |
| `active` | stable 层；compact 后必须继续可见的当前 session 节点 |
| `L1` | dynamic 层；完整 description + content |
| `L2` | dynamic 层；仅 description |
| `L3` | dynamic 层；仅 name |
| `filtered` | 不注入 |

stable context 追加到 system context；dynamic context 作为 turn context 前置。`debugContextPreview` 或 `GM_DEBUG_CONTEXT_PREVIEW=1` 会输出上下文预览日志。


### Scope Hot

Scope Hot 是 Hot 的作用域版本，通过节点 flags 和 session-scope 绑定实现：

- 带 `hot` flag 的节点在所有 session 都渲染。
- 带 `scope_hot:<scope>` flag 的节点只在当前 session 绑定到 `<scope>` 时渲染。
- Session 绑定存储在 `gm_scopes`。
- `before_prompt_build` 中通过 `getScopeHotNodes()` 加载匹配节点。

典型流程：

```text
gm_set_scope(["gm开发"])
  → 当前 session 绑定 gm开发

gm_set_scope_hot("gm-plugin-development-core-principles", "gm开发")
  → 节点获得 flag scope_hot:gm开发

下一次 before_prompt_build
  → getScopesForSession(session)
  → getScopeHotNodes(scopes)
  → assembleStableContext(... scopeHotNodes ...)
  → 节点以 tier="scope_hot" 且 scope_hot="true" 渲染
```

`scope_hot` 的 tier 优先级高于全局 `hot`，所以同一节点同时命中两者时只渲染一次，并显示为 `scope_hot`。

### 置信度系统

每个节点可有 `belief ∈ [0, 1]`。

信号来源：

- 提取器的 `beliefUpdates`：对已召回节点给出 `supported` / `contradicted` 和权重 `0.5~2.0`。
- `session_end`：对 session 节点记录低权重 `task_completed` 信号。
- `gm_record` 只记录知识，刻意不处理 beliefUpdates。

`gm_stats` 会展示平均/高/低置信度和信号数量。


### 遗忘、保留与衰减机制

graph-memory 有两层不同意义的“遗忘”，另加一层语义软删除。它们解决的问题不同。

#### 1. 上下文遗忘：compaction + active-node carry-over

原始聊天上下文仍由 OpenClaw runtime 正常压缩。graph-memory 不接管完整压缩流程（`ownsCompaction=false`）。在 `compact` 中它会：

- 从 session file 清理旧 `<gm_memory>` 块；
- 对未提取消息做兜底提取；
- 将当前 session 节点标记为 compact 后仍需补回的 `active` 节点；
- 把真正的文本压缩委托回 runtime。

压缩后，这些 active 节点会进入 stable KG 层，避免当前 session 中重要知识立刻消失。active 节点最多保留 100 个，并对 TASK/EVENT/KNOWLEDGE 设置最低保留数，SKILL 不参与裁剪。

#### 2. 存储遗忘：retention cleanup

Retention cleanup 删除的是旧的原始 session 历史行，不删除语义知识节点。影响表：

- `gm_messages`
- `gm_recalled`

它不删除 `gm_nodes` 或 `gm_edges`。语义层的遗忘由软删除、合并和召回衰减处理。

Retention 只清理超过 `retention.retentionDays` 的 inactive session。Protected sessions 来自 OpenClaw session store：仍在 running 的 session，以及 cutoff 内更新过的 session。删除预算先给 `gm_messages`，剩余再给 `gm_recalled`。

#### 3. 召回遗忘：访问衰减

访问衰减不删除记忆，只降低陈旧/低价值节点的召回排名。实际注入的 L1 节点会记录：

- `access_count`
- `last_accessed_at`

衰减引擎计算：

```text
composite = recencyWeight × recency
          + frequencyWeight × frequency
          + intrinsicWeight × intrinsic

recency   = 距最后访问时间的 Weibull stretched-exponential 衰减
frequency = access_count 的饱和函数
intrinsic = 节点类型重要性 × belief
```

节点类型决定衰减速度和下限：

| 类型 | 行为 |
|------|------|
| `SKILL`, `TOPIC` | 最稳定，floor 0.8，慢衰减 |
| `KNOWLEDGE` | 较稳定，floor 0.65 |
| `EVENT` | 中等/偏快衰减，floor 0.35 |
| `TASK` | 完成任务会更快淡出，floor 0.35 |
| `STATUS` | 最快衰减，floor 0.2，适合快照 |

召回分数会乘以 `0.3 + 0.7 × max(typeFloor, composite)`，然后重新排序和分层。`decayEnabled=false` 可关闭该排名调整。

#### 4. 语义软删除

常规工具不会硬删除节点。`gm_remove` 和 `gm_merge` 会把节点标记为 `deprecated`；`gm_remove` 还会删除该节点的关联边。Deprecated 节点会从正常搜索、召回和边创建中过滤掉。如果 deprecated 节点之后被重新 upsert 或设置 flags，会被复活为 `active`。

### 主题归纳和 Session 归纳

- 主题归纳创建/更新 `TOPIC` 节点，并创建 `semantic → TOPIC` / `TOPIC ↔ TOPIC` 边。
- Session 归纳创建/更新 `SESSION` 节点，并通过 `来自会话` 边连接该会话产生的节点。
- 每 `compactTurnCount` 轮周期运行一次；`session_end` 时也会运行。
- `gm_induce_topics(name)` 可手动以某个语义节点为中心归纳主题。

### 维护和保留策略

`runMaintenance()` 当前执行：

1. **Retention cleanup**：清理 inactive session 的 `gm_messages`，剩余预算再清理 `gm_recalled`。
2. **向量去重**：按 `dedupThreshold` 做余弦相似度去重。
3. **全局 PageRank**：重新计算全局重要性。

Retention 细节：

- 默认启用。
- protected sessions = 仍在 running 的 session + cutoff 内更新过的 session。
- 默认保留 30 天，单次最多删除 20,000 行。
- 默认不自动 `VACUUM`，除非显式设置 `retention.vacuum=true`。

community 运行逻辑已经移除。只保留 legacy schema：`gm_nodes.community_id` 和 `gm_communities` 表，用于兼容旧数据库。

### gm_dream 与 gm_explore

- `gm_explore(nodeName, maxNodes?)`：从指定节点出发，使用语义邻居 + 图遍历探索子图，返回 L1 导向的子图文本供 LLM 使用，并记录返回 L1 节点的访问。如果种子没有关联节点，会返回 `isolated: true`，不会编造上下文。
- `gm_dream()`：从两个最近池中抽样锚点：最近召回节点池和最近创建节点池。每个池限定最近 168 小时（7 天）且最多 50 条，然后按指数时间衰减抽样。对每个种子探索其子图，并补充该种子最近 session 的 active nodes。

## 提取、归纳与测试细节

- extract 阶段每个 message block 最多渲染约 800 字，跳过 thinking block。
- 提取 prompt 会拒绝普通常识；`beliefUpdates` 只更新已召回旧节点，不更新本轮新节点。
- `beliefUpdates` 的 weight 范围是 0.5-2.0，reason 会截断。
- `advisorySuggestions` 只对本轮新建节点生效，常由长内容或复杂结构数据触发。
- Topic induction 只创建/更新 TOPIC 和 topic 边；硬约束为 semantic→TOPIC 的“主题属于”，以及 TOPIC↔TOPIC 的“主题包含/主题父级”。
- LLM 调用禁止工具调用（`tool_choice: none`），低温度，带 timeout/retry；embedding 启动会 ping，失败则 FTS5 fallback。
- 多数测试用 mock LLM；`belief-e2e.test.ts` 使用生产 DB copy + 真实 LLM 配置；dream 真实 DB 测试需 `RUN_GM_REAL_DB_TESTS=1`。

## Agent 工具（22 个）

| 工具 | 说明 |
|------|------|
| `gm_search(query)` | 从图谱召回相关节点和边 |
| `gm_record(content, flags?)` | 手动提取并记录知识；可传 `hot` / `scope_hot:<scope>` flags |
| `gm_stats()` | 节点/边/Hot/PageRank/Embedding/置信度统计 |
| `gm_maintain()` | 手动执行 retention 清理 + 去重 + 全局 PageRank |
| `gm_get_hots()` | 列出所有全局 hot 节点 |
| `gm_get_scope_hots(scope)` | 列出指定 scope 的 scope_hot 节点 |
| `gm_set_flags(name, flags)` | 覆盖设置节点 flags |
| `gm_get_node(name)` | 获取节点完整信息和出入边 |
| `gm_edit_node(name, description?, content?, type?)` | 覆盖更新节点字段并重新嵌入 |
| `gm_set_hot(name)` | 添加全局 `hot` flag |
| `gm_set_scope_hot(name, scope)` | 添加 `scope_hot:<scope>` flag |
| `gm_get_flags(name)` | 查看节点 flags |
| `gm_set_scope(scopes)` | 将当前 session 绑定到 scopes；`[]` 清空 |
| `gm_get_scope()` | 查看当前 session scopes |
| `gm_list_scopes()` | 列出 scopes 及绑定 session 数量 |
| `gm_remove(name, reason?)` | 软删除节点并清理关联边 |
| `gm_merge(keepName, mergeName)` | 手动合并两个节点并迁移边 |
| `gm_embedding(name, force?)` | 重算单个节点 embedding |
| `gm_reembedding_all(confirm, force?)` | 重算所有 active 节点 embedding，必须 `confirm=true` |
| `gm_induce_topics(name)` | 以节点为中心归纳主题 |
| `gm_explore(nodeName, maxNodes?)` | 探索节点中心子图 |
| `gm_dream()` | 从最近召回/创建池随机漫游子图；种子窗口为 7 天/50 条 |

## 配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `dbPath` | `~/.openclaw/graph-memory.db` | SQLite 数据库路径 |
| `compactTurnCount` | `6` | afterTurn 周期性归纳/轻量维护间隔 |
| `recallMaxNodes` | `15` | 分层召回 cutoff，约 1/3 L1、1/3 L2、1/3 L3 |
| `recallMaxDepth` | `2` | 从种子/扩展节点出发的图遍历跳数 |
| `freshTailCount` | `10` | deprecated/未使用的兼容字段 |
| `dedupThreshold` | `0.90` | 向量去重余弦相似度阈值 |
| `pagerankDamping` | `0.85` | PageRank/PPR 阻尼系数 |
| `pagerankIterations` | `20` | PageRank/PPR 迭代次数 |
| `extractionRecentTurns` | `3` | 提取 prompt 中包含的最近用户轮次 |
| `decayEnabled` | `true` | 是否启用访问衰减评分 |
| `debugContextPreview` | `false` | 是否输出 stable/dynamic 注入上下文预览 |
| `retention.enabled` | `true` | 是否在维护时清理 inactive session 历史 |
| `retention.retentionDays` | `30` | inactive session 历史保留天数 |
| `retention.maxDeletePerRun` | `20000` | 单次共享删除预算，先 messages 后 recalled |
| `retention.vacuum` | `false` | 清理后是否执行 SQLite `VACUUM`，默认关闭 |

### Embedding 服务

Embedding 使用 OpenAI-compatible HTTP 接口。已知可用目标：

| 服务商 | baseURL | 示例模型 |
|--------|---------|----------|
| OpenAI | `https://api.openai.com/v1` | `text-embedding-3-small` |
| 阿里云 DashScope | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `text-embedding-v4` |
| MiniMax | `https://api.minimax.chat/v1` | `embo-01` |
| Ollama | `http://localhost:11434/v1` | `nomic-embed-text` |

未配置 embedding 时，自动降级为 FTS5/LIKE 搜索。

## 数据库

SQLite WAL 模式，默认路径 `~/.openclaw/graph-memory.db`。

| 表 | 用途 |
|----|------|
| `gm_nodes` | 知识节点，含 type/status/belief/access tracking/flags/pagerank/legacy community_id |
| `gm_edges` | 灵活关系边：`from_id`、`to_id`、`name`、`description` |
| `gm_messages` | 原始对话消息 |
| `gm_signals` | 旧版/通用信号记录 |
| `gm_nodes_fts` | 节点 name/description/content 的 FTS5 表 |
| `gm_vectors` | 按 node_id 存储的 embedding 向量 |
| `gm_communities` | legacy 兼容表，运行逻辑不再使用 |
| `gm_scopes` | Session ↔ scope 绑定 |
| `gm_recalled` | `before_prompt_build` 写入的每 session 合并召回记录，用于 retention 和 dream 召回池抽样 |
| `gm_belief_signals` | 置信度证据记录 |
| `_migrations` | 迁移记录 |

### Flags

Flags 以 JSON 数组字符串存在 `gm_nodes.flags`：

- `hot` — 每次 stable context 都渲染。
- `scope_hot:<scope>` — 当前 session 绑定对应 scope 时渲染。
- 其他字符串可以存储，但只有上述两个有内置渲染语义。

## 开发

```bash
npm install
npm run build
npm test
```

默认 `npm test` 中大多数单元测试使用 mock LLM，并会跳过依赖 `/tmp/gm-test.db` 的真实 DB dream/debug 测试。`belief-e2e.test.ts` 是主要的真实 LLM e2e：它复制生产图数据库到临时 DB，并从 OpenClaw 配置读取 graph-memory 的 LLM 配置。如需显式运行 gated 的真实 DB dream/debug 测试：

```bash
RUN_GM_REAL_DB_TESTS=1 npm test
```

## 项目结构

```text
graph-memory/
├── index.ts                    # 插件入口、hooks、tools
├── openclaw.plugin.json        # 插件元数据和配置 schema
├── src/
│   ├── types.ts                # 核心类型和 DEFAULT_CONFIG
│   ├── engine/
│   │   ├── llm.ts              # LLM 封装
│   │   ├── embed.ts            # Embedding 封装
│   │   ├── induction.ts        # 主题/session 归纳
│   │   └── decay.ts            # 访问衰减引擎
│   ├── extractor/
│   │   ├── extract.ts          # LLM 提取/finalize 解析
│   │   └── noise-filter.ts     # 输入噪声过滤
│   ├── format/
│   │   ├── assemble.ts         # stable/dynamic KG XML 渲染
│   │   └── transcript-repair.ts
│   ├── recaller/
│   │   ├── recall.ts           # 精确召回、graphWalk、PPR、decay
│   │   └── score.ts            # 组合评分辅助函数
│   ├── graph/
│   │   ├── pagerank.ts         # 全局 PageRank 和 Personalized PPR
│   │   ├── dedup.ts            # 向量去重和合并编排
│   │   └── maintenance.ts      # retention + dedup + PageRank
│   └── store/
│       ├── db.ts               # SQLite 迁移和单例
│       └── store.ts            # CRUD/search/vector/scope/retention helper
└── test/                       # Vitest 测试
```

## 操作注意

- 不要把内部表名暴露为用户配置。
- 不要硬编码 OpenClaw `sessions.json` 路径；使用插件 session store API。
- 不要自动 VACUUM，除非用户显式配置。
- runtime community detection 已移除；除非重新设计，否则不要恢复。

## 许可证

MIT

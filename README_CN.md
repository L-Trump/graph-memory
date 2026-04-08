# graph-memory

<p align="center">
  <strong>OpenClaw 知识图谱上下文引擎插件</strong>
</p>

---

## 它解决什么问题

1. **上下文爆炸** — 对话轮次增加，消息堆积。graph-memory 用知识图谱替代原始消息，上下文长度收敛而非线性增长。
2. **跨对话失忆** — 昨天的 bug 解法、踩过的坑，新对话全部归零。graph-memory 自动从历史对话中召回相关知识。
3. **技能孤岛** — 孤立的学习条目之间没有关联。"装了 libgl1" 和 "ImportError: libGL.so.1" 本该通过一条 `解决` 边相连。

**感觉像在和一个积累经验的 Agent 对话。因为它确实在积累。**

## 架构

```
消息进入 → ingest()（同步，零 LLM）
  └─ 所有消息存入 gm_messages

before_prompt_build hook（每次 LLM 调用前）
  ├─ Input-layer 噪声过滤：跳过拒绝回复/元问题/Boilerplate 消息
  ├─ recallV2()：精确召回 → 分层节点
  ├─ saveRecalledNodes()：缓存召回节点到 gm_recalled
  └─ assembleContext()：渲染 KG XML → 通过 appendSystemContext 注入

afterTurn hook（后台异步，不阻塞用户对话）
  ├─ Input-layer 噪声过滤
  ├─ extract()：LLM 提取三元组 → gm_nodes + gm_edges
  ├─ recordBeliefSignal() + updateNodeBelief()：处理置信度更新
  ├─ syncEmbed()：异步写入向量（非阻塞）
  └─ 每 N 轮（compactTurnCount）：主题归纳 + 维护

session_end hook
  ├─ finalize()：EVENT → SKILL 升级、补充遗漏关系、标记失效节点
  ├─ 主题归纳
  ├─ runMaintenance()：去重 → PageRank → 社区检测
  └─ session belief 信号（weight=0.3）
```

### ContextEngine 接口

实现 OpenClaw 的 `ContextEngine` 接口：

| 方法 | 说明 |
|------|------|
| `bootstrap` | 轻量初始化（当前为空操作） |
| `ingest` | 同步保存消息到 gm_messages（零 LLM） |
| `assemble` | 仅透传消息（KG 渲染在 before_prompt_build hook 中） |
| `compact` | 兜底提取路径（包含噪声过滤 + beliefUpdates 处理） |
| `afterTurn` | 主提取入口（异步）：消息入库 → 提取 → 置信度更新 → 周期性维护 |
| `prepareSubagentSpawn` | 共享召回上下文给子 Agent |
| `onSubagentEnded` | 清理子 Agent session 数据 |
| `dispose` | 清理 session 状态 |

### Hooks

| Hook | 时机 | 作用 |
|------|------|------|
| `before_prompt_build` | 每次 LLM 调用前 | 召回 → 渲染 KG XML → 注入 system prompt |
| `session_end` | Session 结束时 | finalize + 主题归纳 + 维护 + 置信度信号 |

## 核心功能

### 节点类型

| 类型 | 含义 |
|------|------|
| `TASK` | 用户要求完成的任务，含目标、步骤、结果 |
| `SKILL` | 可复用技能，含触发条件、步骤、常见错误 |
| `EVENT` | 一次性错误，含现象、原因、解决方法 |
| `KNOWLEDGE` | 领域知识，有明确适用范围和注意事项 |
| `STATUS` | 时效性快照（永不合并，每次新建带时间戳） |

### 置信度系统

每个节点有 `belief` 分数 ∈ [0, 1]：
- `1.00` = 完全可信（多次验证）
- `0.7~0.99` = 可信，直接应用
- `0.4~0.69` = 参考，谨慎验证
- `0.00~0.39` = 低可信，使用前必须验证

**信号来源：**
- **Extract LLM**：提取结果中的 `beliefUpdates`（supported/contradicted）
- **Session end**：对所有 session 节点记录 `task_completed` 信号（weight=0.3）
- **gm_record 工具**：不处理 beliefUpdates（有意跳过）

### 边类型

边类型由 LLM 自由生成（如 `解决`、`使用`、`依赖`、`扩展`、`冲突`），每条边有 `description`（一句话描述关系）。

### 分层召回（渲染优先级）

| Tier | 优先级 | 输出内容 |
|------|--------|----------|
| `scope_hot` | 1（最高） | 完整 content — scope 下永久加载，永远可见 |
| `hot` | 2 | 完整 content — 每个 session 必定注入 |
| `active` | 3 | 完整 content — 本轮对话新产生，compact 后需参考上下文 |
| `L1` | 4 | 完整 content（Top 0~15 按综合分数） |
| `L2` | 5 | 仅 description（Top 15~30） |
| `L3` | 6 | 仅 name（Top 30~45） |
| `filtered` | 7 | 不传递，不渲染 |

### 精确召回路径

```
用户查询
  │
  └─ 精确路径（泛化路径已禁用）
       向量/FTS5 搜索 → 种子节点
       → 社区同伴扩展
       → 图遍历（N 跳）
       → 个性化 PageRank 排序
       → 关键词混合语义评分
```

> 注：泛化（社区级）路径当前禁用，仅精确路径运行。

### 组合评分

三维评分，min-max 归一化后加权求和：

```
combinedScore = semantic_weight × norm_semantic
              + ppr_weight × norm_ppr
              + pagerank_weight × norm_pagerank
```

**关键词混合召回**：语义分数由向量相似度和关键词重叠度混合：

```
hybridSemantic = vectorSim × (1 + keywordScore × KEYWORD_WEIGHT)
```

默认权重：α=0.5（语义）、β=0.3（PPR）、γ=0.2（PageRank）、KEYWORD_WEIGHT=0.4。

### 主题归纳

周期性触发（`compactTurnCount` 轮一次 + session_end 时），过程：
1. 取 session 节点作为 `sessionNodes`
2. 跨 session 召回相关节点
3. 形成局部子图
4. LLM 归纳 `TOPIC` 节点，含：
   - `semantic → TOPIC` 边（节点归属主题）
   - `TOPIC ↔ TOPIC` 边（主题间关系）

也可手动调用 `gm_induce_topics(name)`。

### 噪声过滤（双层）

**Input-layer**（`src/extractor/noise-filter.ts`）：消息进入提取流程前过滤
- Agent 拒绝回复（"I don't have any information"）
- 关于记忆的元问题（"do you remember"）
- 严格 Boilerplate（招呼语、HEARTBEAT）
- 短文本 Boilerplate（≤10字）

**Output-layer**（`src/extractor/extract.ts`）：LLM 提取结果写入数据库前过滤
- 同名重复（保留第一个）
- 幻觉占位符（content of X、纯标点、长重复字符）
- 内容近似重复（词重叠 >65%）

## Agent 工具（17个）

| 工具 | 说明 |
|------|------|
| `gm_search(query)` | 在图谱中语义搜索相关节点 |
| `gm_record(content, flags?)` | 手动记录知识到图谱（不处理 beliefUpdates） |
| `gm_stats()` | 图谱统计：节点数、边数、社区数、PageRank Top、置信度统计 |
| `gm_get_hots()` | 获取所有 hot 节点 |
| `gm_maintain()` | 手动触发图维护：去重 → PageRank → 社区检测 |
| `gm_embedding(name, force?)` | 重新计算单个节点的向量 |
| `gm_reembedding_all(confirm, force?)` | 重新计算所有节点的向量（需 confirm=true） |
| `gm_remove(name, reason?)` | 软删除节点（标记为 deprecated） |
| `gm_induce_topics(name)` | 以指定节点为中心进行主题归纳 |
| `gm_get_node(name)` | 获取节点完整信息：description、content、置信度、flags、边 |
| `gm_edit_node(name, description?, content?)` | 编辑节点（自动重算向量） |
| `gm_set_hot(name)` | 添加 "hot" flag |
| `gm_set_scope_hot(name, scope)` | 添加 "scope_hot:scope" flag |
| `gm_get_flags(name)` | 获取节点所有 flags |
| `gm_set_flags(name, flags)` | 设置（替换）节点 flags |
| `gm_set_scope(scopes)` | 将 scope 绑定到当前 session |
| `gm_get_scope()` | 获取当前 session 绑定的 scope |
| `gm_list_scopes()` | 列出所有 scope 及其 session 数量 |

### Scope Hot

Scope 将上下文绑定到 session。通过 `gm_set_scope` 设置 scope。带有匹配 `scope_hot:scope` flag 的节点在 assemble 时优先于普通 hot 节点渲染。

## 安装

### 前置条件

- [OpenClaw](https://github.com/openclaw/openclaw)（v2026.3.x+）
- Node.js 22+

### 第一步：安装插件

```bash
pnpm openclaw plugins install graph-memory
```

### 第二步：激活上下文引擎（关键步骤）

编辑 `~/.openclaw/openclaw.json`：

```json
{
  "plugins": {
    "slots": { "contextEngine": "graph-memory" },
    "entries": {
      "graph-memory": {
        "enabled": true,
        "config": {
          "llm": {
            "apiKey": "你的LLM-API密钥",
            "baseURL": "https://api.openai.com/v1",
            "model": "gpt-4o-mini"
          },
          "embedding": {
            "apiKey": "你的Embedding-API密钥",
            "baseURL": "https://api.openai.com/v1",
            "model": "text-embedding-3-small",
            "dimensions": 512
          }
        }
      }
    }
  }
}
```

### 第三步：重启并验证

```bash
pnpm openclaw gateway --verbose
```

日志中应看到：

```
[graph-memory] ready | db=~/.openclaw/graph-memory.db | provider=... | model=...
[graph-memory] vector search ready
```

## 配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `dbPath` | `~/.openclaw/graph-memory.db` | SQLite 数据库路径 |
| `compactTurnCount` | `6` | 维护周期（每隔多少轮触发主题归纳 + 维护） |
| `recallMaxNodes` | `45` | 每次召回最多注入的节点数 |
| `recallMaxDepth` | `2` | 图遍历跳数 |
| `freshTailCount` | `10` | assemble 时始终保留的最新节点数 |
| `dedupThreshold` | `0.90` | 向量去重的余弦相似度阈值 |
| `pagerankDamping` | `0.85` | PPR 阻尼系数 |
| `pagerankIterations` | `20` | PPR 迭代次数 |
| `extractionRecentTurns` | `3` | 注入到提取 prompt 的最近 session 轮数 |

### 支持的 Embedding 服务商

| 服务商 | baseURL | 模型 |
|--------|---------|------|
| OpenAI | `https://api.openai.com/v1` | `text-embedding-3-small` |
| 阿里云 DashScope | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `text-embedding-v4` |
| MiniMax | `https://api.minimax.chat/v1` | `embo-01` |
| Ollama | `http://localhost:11434/v1` | `nomic-embed-text` |

## 开发

```bash
git clone https://github.com/adoresever/graph-memory.git
cd graph-memory
npm install
npx vitest run   # 所有测试通过
```

### 项目结构

```
graph-memory/
├── index.ts                     # 插件入口 + 所有 hooks + 17 个工具
├── src/
│   ├── types.ts                 # 类型定义 + GmConfig
│   ├── db.ts                    # DB 单例 + 迁移记录
│   ├── store.ts               # SQLite CRUD（节点/边/消息/向量）
│   ├── engine/
│   │   ├── llm.ts            # LLM（原生 fetch，无 SDK 依赖）
│   │   ├── embed.ts            # Embedding（原生 fetch）
│   │   └── induction.ts        # 主题归纳引擎
│   ├── extractor/
│   │   ├── extract.ts        # 知识提取 + beliefUpdates
│   │   └── noise-filter.ts   # Input-layer 噪声过滤（拒绝回复/元问题/Boilerplate）
│   ├── format/
│   │   └── assemble.ts       # 上下文组装 + KG XML 渲染 + system prompt
│   ├── recaller/
│   │   ├── recall.ts         # 召回（仅精确路径）+ 组合评分 + 关键词混合
│   │   └── score.ts          # 组合评分函数
│   └── graph/
│       ├── pagerank.ts         # Personalized PageRank + 全局 PageRank
│       ├── community.ts        # 社区检测 + 摘要
│       ├── dedup.ts          # 向量去重
│       └── maintenance.ts       # 编排去重 → PR → 社区检测
└── test/                       # vitest 测试
```

## 数据库

SQLite WAL 模式，路径 `~/.openclaw/graph-memory.db`。

| 表 | 用途 |
|----|------|
| `gm_nodes` | 知识节点（含置信度、pagerank、community_id、flags） |
| `gm_edges` | 类型化关系 |
| `gm_messages` | 原始对话消息 |
| `gm_signals` | 信号记录（tool_error、skill_invoked 等） |
| `gm_vectors` | Embedding 向量 |
| `gm_communities` | 社区摘要 + embedding |
| `gm_scopes` | Session ↔ scope 绑定 |
| `gm_recalled` | 每 session 的召回节点缓存 |
| `gm_belief_signals` | 置信度证据记录（verdict、weight、reason） |
| `gm_recall_feedback` | 召回反馈信号 |
| `_migrations` | 迁移记录 |

### gm_nodes flags

Flags 以 JSON 数组字符串存储：
- `"hot"` — 每次 assemble 必定渲染
- `"scope_hot:xxx"` — 当 session 绑定了 scope `xxx` 时渲染
- 自定义字符串

## 许可证

MIT

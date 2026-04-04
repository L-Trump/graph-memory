# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

graph-memory 是 OpenClaw 的知识图谱上下文引擎插件，从对话中自动提取节点/边，支持跨对话召回（向量+FTS5+PageRank）、社区检测和向量去重。

## 开发命令

```bash
npm test          # 运行所有测试
npm run test:watch # 监听模式
npm run build     # 编译 TypeScript
```

## 架构

### 核心模块

- **index.ts** — 插件主入口，注册 ContextEngine、工具（gm_*）和生命周期钩子
- **src/types.ts** — 核心类型：GmNode（节点）、GmEdge（边）、GmConfig、Signal、RecallResult
- **src/score.ts** — 组合评分：semantic(α) + PPR(β) + PageRank(γ) 三维归一化加权

### 存储层 (src/store/)

- **db.ts** — SQLite 初始化，创建 `gm_nodes` / `gm_edges` / `gm_messages` 表
- **store.ts** — 节点/边的 CRUD、FTS5 搜索、向量存储（`gm_vectors` 表）

### 召回 (src/recaller/recall.ts)

**双路径并行召回**：
1. 精确路径：向量/FTS5 搜索 → 社区扩展 → 图遍历 → PPR 排序
2. 泛化路径：社区摘要 embedding → 匹配社区成员 → PPR 排序

**四级 Tier**：L1（top 15, 完整 content）、L2（15-30, description）、L3（30-45, name）、filtered

### 图算法 (src/graph/)

- **pagerank.ts** — 全局 PageRank（写入 `gm_nodes.pagerank`）+ 个性化 PPR（recall 时实时计算）
- **community.ts** — Label Propagation 社区检测（无向边，O edges），写回 `gm_nodes.community_id`
- **dedup.ts** — 向量余弦相似度去重
- **maintenance.ts** — session_end 时运行去重+社区+PageRank+摘要

### 提取 (src/extractor/extract.ts)

调用 LLM 从对话中提取三元组。知识图谱以三级格式（name/type/description + content）传给 LLM 作为上下文。

### 格式 (src/format/assemble.ts)

assembleContext 将节点/边渲染为文本注入 systemPrompt，含溯源片段（episodic）功能。

### 引擎 (src/engine/)

- **llm.ts** — LLM 调用封装（OpenAI 兼容）
- **embed.ts** — Embedding 向量计算（fetch 原生实现，兼容所有 OpenAI 兼容端点）

### 关键数据流

```
对话消息
  → ingestMessage（入库 gm_messages）
  → afterTurn → runTurnExtract → extractor.extract（LLM 提取三元组）
  → upsertNode / upsertEdge（存库 + 同步 embedding）
  → 每 N 轮 → detectCommunities + computeGlobalPageRank

recall（before_prompt_build）
  → recaller.recallV2（双路径 + 组合评分 + 四级分级）
  → TieredNode[] + GmEdge[] + pprScores

assemble
  → assembleContext（图谱渲染 + episodic 片段）
  → 返回 { messages, systemPromptAddition, estimatedTokens }
```

### 插件生命周期

- `register()` — 初始化 db/llm/recaller/extractor，注册 ContextEngine 和工具
- `before_prompt_build` — 调用 recallV2 填充召回结果到 session 内存
- `afterTurn` — 消息入库 + 每轮提取 + 周期性（图维护）
- `session_end` — finalize 提升技能 + 全量维护
- `dispose` — 清理内存状态

### 数据库 Schema

- `gm_nodes` — id, type, name, description, content, status, validated_count, pagerank, community_id, flags, source_sessions, created_at, updated_at
- `gm_edges` — id, from_id, to_id, name, description, session_id, created_at
- `gm_messages` — id, session_id, turn_index, role, content, extracted, created_at
- `gm_vectors` — node_id, content_hash, embedding（BLOB），建有 FTS5 虚拟列

### 工具函数

- `gm_search` — 搜索图谱（recallV2）
- `gm_record` — 手动记录记忆
- `gm_stats` — 图谱统计
- `gm_maintain` — 手动触发维护
- `gm_get_hots` — 获取 hot 节点
- `gm_set_flags` — 设置节点 flags
- `gm_remove` — 软删除节点
- `gm_embedding` / `gm_reembedding_all` — 重新嵌入

### 环境变量

- `GM_DEBUG=1` — 开启 recall/embed 调试日志
- `OPENCLAW_PROVIDER` — LLM provider（默认 anthropic）

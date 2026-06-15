# Graph Memory

Graph Memory 是 OpenClaw 的 hook-only 知识图谱记忆插件：它从对话中提取长期知识，写入 SQLite 图谱数据库，在后续会话中召回相关节点，并把压缩后的图谱上下文注入给 agent。

它适合保存**语义记忆**：工作流、偏好、项目知识、踩坑经验、可复用事实。它不是原始 transcript 的无损保存系统；原始对话保留和压缩应交给 lossless-claw 等 context engine。

## 它做什么

- 从对话中提取结构化节点（`TASK`、`SKILL`、`EVENT`、`KNOWLEDGE`、`STATUS`、`TOPIC`、`SESSION`）和具名关系边。
- 通过 embedding 或 FTS5、图遍历、Personalized PageRank、关键词混合评分和访问衰减进行跨会话召回。
- 将注入上下文拆成稳定层（`hot`、`scope_hot`、compact-active 节点）和动态召回层（`L1/L2/L3`）。
- 提供 `gm_*` 工具用于搜索、查看、编辑、flags、scope hot、embedding、维护、主题归纳和 dream 式图整理。
- 只通过 OpenClaw hooks 工作，不占用 `contextEngine` slot。

## 快速开始

1. 在 OpenClaw 中安装/启用插件。
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

## 文档

- [架构](docs/architecture.md)：hook 生命周期、存储模型、召回/提取流程、上下文注入层级。
- [配置](docs/configuration.md)：配置项、默认值、source-of-truth 和运维影响。
- [诊断](docs/diagnostics.md)：排查 recall、extraction、日志、eligibility、timeout 和数据库健康。
- [Agent 工具](docs/agent-tools.md)：`gm_*` 工具推荐用法和安全边界。

## 常见操作

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

## 开发

```bash
npm test
npm run build
```

代码修改应发生在开发 checkout 中，不要直接改运行中的 OpenClaw extensions 目录。同步到运行版和重启 Gateway 是运维动作，在本环境中需要用户明确授权。

## 安全与隐私

Graph Memory 保存的是长期语义记忆。它不应持久化临时注入上下文、原始 secret，或不需要长期保存的跨会话隐私细节。当前文件、代码、服务状态和系统配置属于实时事实，必须直接验证，不能只凭记忆判断。

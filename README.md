<div align="center">

# 🧠 Graph Memory · OpenClaw Plugin

**Knowledge-Graph Semantic Memory for [OpenClaw](https://github.com/openclaw/openclaw) Agents**

*Give your agent a structured long-term memory: facts, workflows, lessons, topics, confidence, and relationships — across sessions and across time.*

A hook-only OpenClaw plugin that extracts durable semantic knowledge into SQLite, recalls it with embedding/FTS + graph ranking, and injects compact `<gm_memory>` context before eligible turns.

[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue)](https://github.com/openclaw/openclaw)
[![OpenClaw 2026.5.28+](https://img.shields.io/badge/OpenClaw-2026.5.28%2B-brightgreen)](https://github.com/openclaw/openclaw)
[![Version](https://img.shields.io/badge/version-3.0.0-0f766e)](CHANGELOG.md)
[![SQLite](https://img.shields.io/badge/SQLite-Knowledge%20Graph-orange)](https://www.sqlite.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**English** | [简体中文](README_CN.md)

</div>

---

![Graph Memory hero](docs/images/hero.png)

## Why Graph Memory?

Most agent memory systems either replay transcript fragments or retrieve isolated text chunks. That is useful, but it is not enough when an assistant needs to remember **relationships**:

- which solution fixed which failure;
- which workflow depends on which tool;
- which user preference applies only in which scope;
- which node is trusted, contradicted, old, hot, or deprecated;
- which topics emerged across many sessions.

**Graph Memory** turns durable conversation knowledge into a typed graph. It stores nodes, edges, confidence signals, provenance, access metadata, PageRank, and embeddings, then recalls a compact subgraph when it matters.

### Without Graph Memory

> **You:** "When editing this plugin, never touch the runtime extension directly. Work in the Codes checkout first."
> *(two weeks later)*
> **Agent:** "I can patch the extension directly and restart Gateway." 😬

### With Graph Memory

> **You:** "When editing this plugin, never touch the runtime extension directly. Work in the Codes checkout first."
> *(later — Graph Memory recalls the rule and related deployment boundary)*
> **Agent:** "I'll work only in the development checkout. Syncing runtime and restarting Gateway are separate authorized steps." ✅

That's the point: durable semantic memory, not raw transcript replay.

---

## What You Get

| Capability | What it means |
|---|---|
| **Knowledge graph memory** | Stores `TASK`, `SKILL`, `EVENT`, `KNOWLEDGE`, `STATUS`, `TOPIC`, and `SESSION` nodes with typed edges. |
| **Cross-session semantic recall** | Uses embedding or FTS5 seeds, graph walk, Personalized PageRank, global PageRank, keyword scoring, and access decay. |
| **Stable + dynamic context** | Injects always-visible `hot` / `scope_hot` memories separately from per-turn `L1/L2/L3` recall. |
| **Belief/confidence signals** | Tracks supported/contradicted evidence and belief scores so stale or unreliable nodes can be handled cautiously. |
| **Scope-aware visibility** | Supports global hot memories and session-scope hot memories for project/group-specific rules. |
| **Runtime controls** | `/gm status`, `/gm on`, `/gm off`, allow/deny chat filters, cache, timeout, and circuit breaker. |
| **Maintenance budget controls** | Retention cleanup, incremental vector dedup, pair/merge budgets, PageRank refresh. |
| **Agent tools** | 22 `gm_*` tools for search, recording, editing, graph exploration, embeddings, topic induction, and maintenance. |
| **Independent diagnostics** | Routine metrics can go to `/tmp/openclaw/graph-memory-YYYY-MM-DD.log` while warnings/errors remain visible in host logs. |

---

## Graph Memory vs Other OpenClaw Memory Layers

| Layer | Best for | Stores exact transcript? | Stores graph relationships? | Injects context? |
|---|---|:---:|:---:|:---:|
| **Graph Memory** | Durable semantic facts, workflows, lessons, preferences, topics, relationships | No | ✅ Yes | ✅ Yes |
| **lossless-claw / ContextEngine** | Exact transcript recall, compaction lineage, raw commands/tool output evidence | ✅ Yes | No | ✅ Yes |
| **active-memory** | Lightweight recent memory summaries from tool-assisted recall | Partial | No | ✅ Yes |
| **Manual notes/files** | Human-curated source of truth | Depends | No | Via other tooling |

**Rule of thumb:** use Graph Memory for *what should be remembered as knowledge*; use lossless context for *what exactly happened*.

---

## Quick Start

### Option A: Source checkout / development install

```bash
npm install
npm run build
```

Then enable the plugin from OpenClaw's plugin configuration. A minimal entry:

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

### Option B: Runtime extension copy

If you run Graph Memory as a local OpenClaw extension, build `dist/index.js`, copy the source/build into the configured extension directory, clear relevant runtime caches if your environment uses them, then restart Gateway.

> Runtime sync and Gateway restart are operational actions. In production, do them as a separate authorized deployment step, not as part of ordinary source editing.

### Validate

After enabling the plugin, use an OpenClaw session:

```text
/gm status
```

Expected high-level state:

```text
Graph Memory: global=on recall=on extract=on
chatType=direct|group|channel|explicit eligibility=yes
recallTimeoutMs=20000 cacheEntries=...
```

Then try:

```text
gm_search("a topic you previously discussed")
gm_record("A durable fact, workflow, or lesson to remember.")
```

---

## AI-Safe Install Notes

If an AI assistant is helping you install or configure this plugin, **do not let it guess paths or active config**. Inspect the real environment first.

Recommended checks:

```bash
openclaw status
openclaw config get plugins.entries.graph-memory
openclaw config get plugins.load.paths
openclaw config get plugins.slots.contextEngine
```

Guidelines:

- Prefer absolute paths in plugin load paths unless the active workspace is confirmed.
- Keep API keys in OpenClaw SecretRef-backed config or environment-backed secrets; do not commit plaintext keys.
- Confirm the configured `dbPath` before running maintenance, migrations, bulk merges, or re-embedding.
- Backup SQLite consistently. If WAL mode is active, use SQLite backup APIs or handle `-wal` / `-shm` files together.
- Restart Gateway only when you intentionally deploy a runtime change.

---

## Recommended Production Config

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

Notes:

- Without `embedding`, recall falls back to SQLite FTS5.
- Without `llm`, extraction/induction uses the available OpenClaw model path where supported by runtime integration.
- `autoRecallMode: "index"` can reduce dynamic prepend churn but changes where recall context is inserted.
- `allowedChatTypes` defaults to all supported automation types: `direct`, `group`, `channel`, `explicit`.

See [docs/configuration.md](docs/configuration.md) for the full config reference.

---

## Architecture

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

### Hook Lifecycle

| Hook | Purpose |
|---|---|
| `before_prompt_build` | Check eligibility, recall graph context, assemble stable/dynamic memory, persist status lines. |
| `before_message_write` | In `autoRecallMode=index`, prepend a compact recall index to the user message. |
| `agent_end` | Save new messages, extract nodes/edges, apply belief updates, run periodic maintenance. |
| `before_compaction` / `after_compaction` | Preserve/extract active session material and maintain compact-active continuity. |
| `subagent_spawned` / `subagent_ended` | Preserve parent/child memory continuity. |
| `session_end` | Final extraction, topic/session induction, maintenance, and task-completed belief signals. |

<details>
<summary><strong>File Reference (click to expand)</strong></summary>

| File | Purpose |
|---|---|
| `index.ts` | Plugin entry point, runtime config normalization, OpenClaw hooks, `/gm` command, status/debug lines, all `gm_*` tool registration. |
| `openclaw.plugin.json` | Plugin metadata, config schema, and UI hints. |
| `src/types.ts` | Runtime types and `DEFAULT_CONFIG`. |
| `src/store/db.ts` | SQLite open/migration/index lifecycle. |
| `src/store/store.ts` | Node/edge/vector/message/recalled-row persistence APIs. |
| `src/recaller/recall.ts` | Precise recall: embedding/FTS seeds, graph walk, PPR, scoring, decay, tier assignment. |
| `src/recaller/score.ts` | Recall scoring helpers. |
| `src/format/assemble.ts` | Stable/dynamic/context-index XML rendering. |
| `src/extractor/extract.ts` | LLM extraction into graph nodes/edges and belief updates. |
| `src/extractor/noise-filter.ts` | Input/output noise filtering before persistence/extraction. |
| `src/engine/embed.ts` | Embedding API abstraction and vector generation. |
| `src/engine/llm.ts` | LLM invocation helpers for extraction/induction. |
| `src/engine/induction.ts` | Topic/session induction. |
| `src/engine/decay.ts` | Access/recency/intrinsic decay model. |
| `src/graph/dedup.ts` | Incremental vector dedup and merge candidate handling. |
| `src/graph/pagerank.ts` | Global PageRank computation. |
| `src/graph/maintenance.ts` | Retention, dedup, PageRank orchestration. |
| `src/logger.ts` | Independent async JSONL log writer. |
| `test/*.test.ts` | Vitest coverage for store, graph, recall, config, runtime controls, belief, decay, and integration paths. |

</details>

For a deeper walkthrough, see [docs/architecture.md](docs/architecture.md).

---

## Core Features

### 1. Knowledge Graph Extraction

Graph Memory extracts structured semantic knowledge rather than raw transcript chunks.

```text
conversation messages
  → noise filter
  → LLM extraction
  → nodes: TASK/SKILL/EVENT/KNOWLEDGE/STATUS/TOPIC/SESSION
  → edges: 使用 / 依赖 / 修复 / 冲突 / 扩展 / ...
  → belief updates and provenance
```

Each node can carry content, description, confidence/belief, flags, source sessions, access metadata, embeddings, and PageRank.

### 2. Precise Graph Recall

```text
Query → embedding or FTS5 seeds ─┐
                                  ├→ graph walk → Personalized PageRank → scoring → tiers
Global PageRank + keyword match ──┘
```

The combined score uses semantic relevance, local PPR, global PageRank, keyword overlap, and decay/access signals. The output is tiered:

| Tier | Injected detail | Typical use |
|---|---|---|
| `L1` | Full content | Highly relevant memories needed for current reasoning. |
| `L2` | Description only | Useful context without full payload. |
| `L3` | Name only | Awareness that related knowledge exists. |
| `filtered` | Not injected | Internal candidate only. |

### 3. Stable + Dynamic Context

Stable context is designed to be prefix-stable:

- global `hot` nodes;
- scope-specific `scope_hot` nodes;
- compact-active nodes when enabled.

Dynamic context changes per turn:

- current recall L1/L2/L3 nodes;
- relevant edges;
- optional recall index mode.

Example injected block:

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

### 4. Scope Hot and Hot Memory

`hot` and `scope_hot` are for high-priority memories that should not rely on semantic recall.

- `hot`: visible in every session.
- `scope_hot:<scope>`: visible only when the session has that scope.
- Normal memories should not be marked hot unless explicitly requested.

### 5. Belief and Reliability Tracking

The belief system tracks supported/contradicted signals and 0-1 belief scores. This lets the graph represent uncertainty and contradictory evidence instead of treating every extraction as equally reliable.

### 6. Runtime Controls and Eligibility

```text
/gm status
/gm on [all|recall|extract]
/gm off [all|recall|extract]
/gm help
```

Automation is gated by:

- global `enabled`;
- `recallEnabled` / `extractionEnabled`;
- per-session toggles;
- `allowedChatTypes`;
- `allowedChatIds` / `deniedChatIds`.

### 7. Resilience: Cache, Timeout, Circuit Breaker

`before_prompt_build` recall is protected by:

- mode-aware in-memory cache;
- `recallTimeoutMs` hook latency budget;
- consecutive-timeout circuit breaker;
- bounded cache/circuit maps;
- status/debug visibility.

The timeout bounds hook latency. It does not magically cancel already-running synchronous SQLite or JavaScript work.

### 8. Bounded Maintenance

Maintenance includes:

- retention cleanup for inactive-session raw bookkeeping rows;
- incremental vector dedup;
- PageRank refresh;
- optional topic/session induction paths.

Dedup budgets:

| Config | Purpose |
|---|---|
| `dedupMaxPendingVectorsPerRun` | Max new/changed vectors checked per maintenance pass. `0` falls back to full scan. |
| `dedupMaxPairsPerRun` | Max duplicate candidate pairs returned/processed. |
| `dedupMaxMergesPerRun` | Max actual merges per pass. |

---

## Agent Tools

Graph Memory registers **22 `gm_*` tools**.

| Category | Tools |
|---|---|
| Search and inspect | `gm_search`, `gm_get_node`, `gm_explore`, `gm_stats`, `gm_get_flags` |
| Record and edit | `gm_record`, `gm_edit_node`, `gm_remove`, `gm_merge` |
| Hot/scope visibility | `gm_get_hots`, `gm_set_hot`, `gm_set_flags`, `gm_get_scope`, `gm_set_scope`, `gm_get_scope_hots`, `gm_set_scope_hot`, `gm_list_scopes` |
| Embeddings and maintenance | `gm_maintain`, `gm_embedding`, `gm_reembedding_all` |
| Higher-level review | `gm_induce_topics`, `gm_dream` |

Common workflows:

```text
# Search first when a problem may have been solved before
gm_search("graph memory dedup performance")

# Inspect a precise node
gm_get_node("runtime-sync-boundary")

# Explicitly record a durable lesson
gm_record("When changing graph-memory config defaults, update src/types.ts and openclaw.plugin.json together.")

# Explore related nodes/edges
gm_explore("sqlite-wal-backup")

# Manual maintenance
gm_maintain()
```

See [docs/agent-tools.md](docs/agent-tools.md) for tool-by-tool guidance.

---

## Operations

### Database lifecycle

- Default path: `~/.openclaw/graph-memory.db`.
- Migrations run automatically on open.
- Back up before schema migrations, bulk merges, full re-embedding, manual recovery, or risky maintenance experiments.
- `gm_remove()` deprecates nodes; it does not erase all historical evidence.
- Retention cleanup removes old `gm_messages` and `gm_recalled` rows for inactive sessions; it does not delete semantic nodes/edges.

### Maintenance metrics

When independent logging is enabled, routine logs go to a daily JSONL file, usually:

```text
/tmp/openclaw/graph-memory-YYYY-MM-DD.log
```

Useful fields:

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

### Performance tuning quick guide

| Symptom | First knobs to inspect |
|---|---|
| Recall too slow | `recallTimeoutMs`, `recallMaxNodes`, `recallMaxDepth`, cache TTL, embedding latency, vector table size. |
| Maintenance too slow | `dedupMaxPendingVectorsPerRun`, `dedupMaxPairsPerRun`, `dedupMaxMergesPerRun`, `pagerankIterations`. |
| Too much prompt context | `recallMaxNodes`, `autoRecallMode`, hot/scope-hot count, compact-active settings. |
| Too little recall | embedding config, FTS fallback, query quality, `allowedChatTypes`, `/gm status`, cache/circuit state. |
| Sensitive chat should not automate | `deniedChatIds`, `allowedChatIds`, `/gm off all`, global `enabled=false`. |

---

## Troubleshooting

### No memories recalled

1. Run `/gm status`.
2. Check `global=on`, `recall=on`, `eligibility=yes`.
3. Verify `allowedChatTypes`, `allowedChatIds`, and `deniedChatIds`.
4. Check whether embedding is configured or whether FTS5 fallback should be used.
5. Inspect independent log and status/debug lines for timeout/circuit/cache state.

### Extraction not happening

1. Check `/gm status` for extraction toggle.
2. Confirm session/chat eligibility.
3. Confirm LLM/extraction configuration.
4. Check noise filters and extraction recent-turn window.
5. Inspect host warnings/errors and Graph Memory log.

### Slow maintenance

1. Inspect `dedup_*` and `pagerank_ms` fields.
2. Lower per-run dedup budgets if hooks are affected.
3. Raise `dedupMaxPendingVectorsPerRun` if you want to drain backlog faster during planned maintenance windows.
4. Reduce `pagerankIterations` if PageRank dominates.
5. Avoid full re-embedding during active usage.

### Database locked or suspicious

1. Stop concurrent maintenance.
2. Back up the database, including WAL/SHM if applicable.
3. Run SQLite integrity checks with appropriate tooling.
4. Avoid manual SQL mutations unless you understand the schema and have a rollback plan.

See [docs/diagnostics.md](docs/diagnostics.md) for deeper diagnostics.

---

## Development

```bash
npm install
npm test
npm run build
```

Release-sensitive gate:

```bash
npm test
npm run build
git diff --check
```

Some real-database or real-model tests require local state or environment flags. Do not make those mandatory for ordinary deterministic development unless the changed subsystem requires them.

Recommended change workflow:

1. Modify source in the development checkout.
2. If config changes, update both `src/types.ts` and `openclaw.plugin.json`.
3. Add targeted tests.
4. Run targeted tests, then full tests/build.
5. Commit source/docs changes.
6. Treat runtime sync and Gateway restart as separate authorized deployment actions.

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## FAQ

**Does Graph Memory preserve exact conversation history?**
No. It stores semantic graph memory. Use a lossless context engine for exact transcript/source-message evidence.

**Does it require embeddings?**
No, but embeddings improve semantic recall. Without embedding, Graph Memory falls back to SQLite FTS5.

**Will it slow prompts down?**
Recall does work before prompt build. Use timeout/cache/circuit-breaker settings and recall size/depth budgets to control latency.

**Can I remove a bad memory?**
Yes. Use `gm_remove` to deprecate a node, or `gm_edit_node` / `gm_merge` to correct and consolidate memory.

**What should be marked `hot`?**
Only high-priority, broadly applicable memories that should always be injected. Keep them scarce.

**Can I use it with lossless-claw?**
Yes. They solve different problems: Graph Memory stores semantic knowledge; lossless-claw preserves exact conversation history and compaction lineage.

---

## Glossary

- **Hot node**: globally pinned memory injected into every eligible session.
- **Scope-hot node**: pinned memory injected only when the current session has a matching scope.
- **L1/L2/L3**: dynamic recall tiers; L1 full content, L2 description, L3 name only.
- **PPR**: Personalized PageRank over the recalled local graph.
- **Decay**: access/recency/intrinsic-value scoring adjustment that changes ranking without deleting nodes.
- **Dedup**: vector-similarity based duplicate detection and merge support.
- **Recall index**: compact index written into the user message in `autoRecallMode=index`.
- **Deprecated node**: node hidden from normal active use without necessarily erasing all evidence.

---

## Documentation

- [Architecture](docs/architecture.md)
- [Configuration](docs/configuration.md)
- [Diagnostics](docs/diagnostics.md)
- [Agent tools](docs/agent-tools.md)
- [OpenClaw integration playbook](docs/openclaw-integration-playbook.md)
- [Release checklist](docs/release-checklist.md)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

---

## Safety and Privacy

Graph Memory may persist durable semantic data: nodes, edges, descriptions, content, metadata, embeddings, access timestamps, source-session IDs, and limited raw bookkeeping rows. It should not persist raw secrets, transient injected context, or private cross-session details that are not needed as durable knowledge.

Use these controls when privacy boundaries matter:

- global: `enabled=false`, `recallEnabled=false`, or `extractionEnabled=false`;
- session: `/gm off recall`, `/gm off extract`, `/gm off all`;
- routing: `allowedChatTypes`, `allowedChatIds`, `deniedChatIds`;
- correction: `gm_remove`, `gm_edit_node`, `gm_merge`;
- secrets: OpenClaw SecretRef or environment-backed secret management.

Current files, code, services, package state, and system configuration are live facts. Verify them directly; do not infer them from memory.

---

## Status and Compatibility

- Package version: `3.0.0`
- OpenClaw peer dependency: `^2026.5.28`
- Runtime: Node.js `>=18`
- Storage: SQLite via `@photostructure/sqlite`
- Repository: <https://github.com/adoresever/graph-memory>
- Issues: <https://github.com/adoresever/graph-memory/issues>

---

## License

MIT. See [LICENSE](LICENSE).

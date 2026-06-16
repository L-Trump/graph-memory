# Graph Memory Architecture

Graph Memory is a hook-only OpenClaw plugin. It contributes durable semantic memory through lifecycle hooks and `gm_*` tools while leaving the selected ContextEngine responsible for transcript assembly, compaction, and exact history recall.

## Design Goals

1. **Semantic memory, not transcript replay** — store durable knowledge as nodes and relationships.
2. **Graph-aware recall** — retrieve not only matching text but also related concepts, causes, fixes, dependencies, and conflicts.
3. **Prompt discipline** — separate prefix-stable memories from per-turn dynamic recall.
4. **Operational safety** — keep recall bounded by cache/timeout/circuit breaker and keep maintenance budgeted.
5. **Correctability** — support explicit record/edit/remove/merge flows and belief/confidence updates.
6. **Context-engine compatibility** — run beside lossless context systems instead of replacing them.

## System Boundary

Graph Memory is responsible for:

- extracting durable nodes/edges from eligible conversations;
- recalling graph context before replies;
- injecting stable and dynamic memory context;
- exposing tools for graph search, inspection, editing, maintenance, embeddings, and topic induction;
- maintaining graph metadata such as PageRank, access counters, belief signals, and dedup state.

Graph Memory is not responsible for:

- lossless transcript preservation;
- source-message proof or raw tool-output recovery;
- provider prompt-cache ownership;
- replacing OpenClaw's ContextEngine;
- deciding whether live files/services/config are current — those must be verified directly.

## High-Level Flow

```text
┌──────────────────────────────────────────────────────────────────────┐
│                          OpenClaw runtime                            │
└───────────────────────┬───────────────────────┬──────────────────────┘
                        │                       │
              before_prompt_build             agent_end/session_end
                        │                       │
┌───────────────────────▼─────────────┐ ┌──────▼──────────────────────┐
│ Recall path                          │ │ Extraction path             │
│ - resolve eligibility                │ │ - choose new messages       │
│ - build history/prompt query         │ │ - strip injected GM context │
│ - cache/circuit/timeout guard        │ │ - save raw bookkeeping rows │
│ - seed search + graph walk + PPR     │ │ - LLM extract nodes/edges   │
│ - assemble stable/dynamic context    │ │ - apply belief updates      │
└───────────────────────┬─────────────┘ └──────┬──────────────────────┘
                        │                       │
                        └───────────┬───────────┘
                                    │
                         ┌──────────▼───────────┐
                         │ SQLite graph store   │
                         │ nodes/edges/vectors  │
                         │ messages/recalled    │
                         │ belief/dedup/access  │
                         └──────────┬───────────┘
                                    │
                         ┌──────────▼───────────┐
                         │ Maintenance          │
                         │ retention/dedup/PR   │
                         └──────────────────────┘
```

## Data Model

### Node Types

| Type | Typical content |
|---|---|
| `TASK` | Work items, implementation goals, ongoing operational tasks. |
| `SKILL` | Reusable procedures, debugging playbooks, workflows, conventions. |
| `EVENT` | Incidents, fixes, historical observations, reported bugs. |
| `KNOWLEDGE` | Durable facts, architectural principles, decisions, constraints. |
| `STATUS` | Time-sensitive snapshots, current operating state, allowlists. |
| `TOPIC` | Induced high-level themes across nodes or sessions. |
| `SESSION` | Session-level summaries/anchors for graph continuity. |

### Edge Model

Edges use free-form names/descriptions so the extractor can represent natural relations:

- `使用` / uses
- `依赖` / depends on
- `修复` / fixes
- `导致` / causes
- `冲突` / conflicts with
- `扩展` / extends
- `验证` / verifies
- `触发` / triggers

Edges are used for graph walk, Personalized PageRank, local context construction, and human inspection.

### Important Metadata

| Field family | Purpose |
|---|---|
| `flags` | `hot` and `scope_hot:<scope>` visibility. |
| `belief`, `successCount`, `failureCount` | Confidence and supported/contradicted evidence tracking. |
| `sourceSessions` | Provenance of extraction. |
| `accessCount`, `lastAccessedAt` | Decay-aware ranking and usage diagnostics. |
| `pagerank` | Global graph importance used during recall ranking. |
| vectors | Semantic similarity for recall and dedup. |
| dedup tracking | Incremental maintenance state for new/changed vectors. |

## Recall Pipeline

Graph Memory currently uses precise recall.

```text
history + prompt query
  → embedding query if available
  → vector search and/or FTS5 fallback
  → PageRank candidate expansion
  → graph walk from seed nodes
  → Personalized PageRank on local subgraph
  → combined semantic/PPR/global-PR/keyword score
  → access decay modulation
  → tier assignment
  → stable/dynamic context assembly
```

### Scoring Signals

| Signal | Role |
|---|---|
| Semantic similarity | Primary match between query and node content. |
| FTS5/keyword overlap | Exact token match fallback or boost. |
| Personalized PageRank | Local graph relevance around seed nodes. |
| Global PageRank | General graph importance. |
| Access decay | Recency/frequency/intrinsic adjustment. |
| Belief/confidence | Reliability awareness and future ranking input. |

### Tiers

| Tier | Rendering |
|---|---|
| `scope_hot` | Full content in stable layer for matching scope. |
| `hot` | Full content in stable layer globally. |
| `active` | Current-session compact-active stable context. |
| `L1` | Full content in dynamic recall layer. |
| `L2` | Description only. |
| `L3` | Name only. |
| `filtered` | Not rendered. |

## Context Injection

### Stable Layer

Stable context is appended as system context and should remain relatively prefix-stable:

- global hot nodes;
- scope-hot nodes for current session scopes;
- compact-active nodes when enabled.

Stable layer intentionally avoids rendering too many dynamic edges to preserve prefix-cache stability.

### Dynamic Layer

Dynamic context changes per turn and contains recall results:

- `autoRecallMode="full"`: dynamic XML is returned as `prependContext`.
- `autoRecallMode="index"`: a compact recall index is staged and written into the user message by `before_message_write`.

## Hook Lifecycle

### `before_prompt_build`

1. Normalize runtime config.
2. Resolve session key and session toggles.
3. Check eligibility (`enabled`, recall toggles, chat type/id filters).
4. Build history and prompt queries.
5. Check recall cache.
6. Check circuit breaker.
7. Run recall under timeout guard.
8. Load hot/scope-hot/compact-active stable inputs.
9. Assemble context.
10. Record access metadata.
11. Persist status/debug lines.
12. Return prompt context or stage recall index.

### `before_message_write`

Applies staged recall-index content only when the prompt hash matches. This prevents stale recall indexes from being written to unrelated messages.

### `agent_end`

1. Select new messages since the run started.
2. Strip transient injected GM context.
3. Persist raw bookkeeping rows.
4. Run extraction when enabled and eligible.
5. Persist nodes/edges/vectors.
6. Apply belief updates for recalled nodes.
7. Periodically induce topics/session nodes and run maintenance.

### Compaction Hooks

- `before_compaction`: preserve/extract relevant active session material before loss of prompt detail.
- `after_compaction`: mark compacted active nodes and optionally induce session-level graph anchors.

### Subagent and Session End Hooks

Subagent hooks preserve continuity between parent/child sessions. `session_end` performs final extraction, topic/session induction, maintenance, and task-completed belief signals.

## Maintenance Architecture

```text
gm_maintain / periodic maintenance
  → retention cleanup for inactive raw rows
  → incremental vector dedup
  → global PageRank recompute
  → metrics/logging
```

### Incremental Dedup

`gm_vectors` tracks `updated_at` and `dedup_checked_at`.

- New/updated vectors become pending.
- Each run checks up to `dedupMaxPendingVectorsPerRun` pending vectors.
- Pending vectors are compared against same-type pending vectors and already-checked same-type active vectors.
- Pair and merge budgets bound work.
- Setting `dedupMaxPendingVectorsPerRun=0` falls back to full scan.

### Retention

Retention removes old raw `gm_messages` and `gm_recalled` rows for inactive sessions. It does not delete semantic nodes or edges.

## Resilience

| Mechanism | Purpose |
|---|---|
| Cache | Avoid repeated recall work for same session/mode/query. |
| Timeout | Bound hook latency. |
| Circuit breaker | Skip recall temporarily after repeated timeouts. |
| Bounded maps | Avoid unbounded cache/circuit status growth. |
| Independent log | Keep routine GM diagnostics out of the main host log. |
| `/gm status` | Show resolved state and last recall/eligibility information. |

## File Reference

| File | Purpose |
|---|---|
| `index.ts` | Entry, hooks, config normalization, commands, tools, status/debug. |
| `src/types.ts` | Types and defaults. |
| `src/store/db.ts` | SQLite migrations and indexes. |
| `src/store/store.ts` | Store APIs. |
| `src/recaller/recall.ts` | Recall implementation. |
| `src/format/assemble.ts` | Context rendering. |
| `src/extractor/extract.ts` | LLM graph extraction. |
| `src/engine/induction.ts` | Topic/session induction. |
| `src/graph/dedup.ts` | Incremental dedup. |
| `src/graph/maintenance.ts` | Retention + dedup + PageRank orchestration. |
| `src/logger.ts` | Async independent logger. |

## Future Architecture Work

Known next-level improvements:

- cooperative recall deadline checks inside vector scan, graph walk, and PPR;
- unified database transaction/session queue;
- indexed/vector-extension-backed search to avoid full vector scans;
- incremental or less frequent PageRank refresh;
- stronger provenance rendering in recalled context.

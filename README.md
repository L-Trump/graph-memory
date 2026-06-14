# graph-memory

> **Forked from** [adoresever/graph-memory](https://github.com/adoresever/graph-memory) · custom OpenClaw knowledge-graph memory plugin

<p align="center">
  <strong>Knowledge Graph Memory Plugin for OpenClaw</strong>
</p>

---

## What it does

graph-memory turns conversations into a persistent knowledge graph and injects relevant graph context back into future OpenClaw sessions.

It solves three practical problems:

1. **Context explosion** — old raw messages are distilled into structured nodes and edges.
2. **Cross-session amnesia** — previous fixes, decisions, pitfalls, and workflows can be recalled later.
3. **Disconnected experience** — isolated memories are connected by free-form relationship edges such as `解决`, `使用`, `依赖`, `扩展`, `冲突`.

## Current architecture

```text
Message in / model turn completes
  └─ agent_end hook: save new messages to gm_messages and trigger extraction

before_prompt_build hook
  ├─ Recaller.recallV2(): precise recall only
  ├─ saveRecalledNodes(): persist per-turn recalled nodes to gm_recalled
  ├─ assembleStableContext(): scope_hot + hot + compacted active nodes → appendSystemContext
  └─ assembleDynamicContext(): recalled L1/L2/L3 nodes → prependContext

before_message_write hook
  └─ index mode only: prepend a short recall index to the matching user message

compaction hooks
  ├─ before_compaction: fallback extraction for unextracted messages
  └─ after_compaction: mark compacted active nodes and refresh session induction

subagent hooks
  ├─ subagent_spawned: best-effort copy of recalled graph context to child session
  └─ subagent_ended: cleanup child in-memory state

session_end hook
  ├─ finalize(): promote EVENT→SKILL, add missed edges, invalidate obsolete nodes
  ├─ topic induction
  ├─ session induction: create/update SESSION node for the session
  ├─ runMaintenance(): retention cleanup → vector dedup → global PageRank
  └─ task_completed belief signals for session nodes
```

Graph Memory is now a hook-only OpenClaw plugin. It does **not** register a ContextEngine and does not occupy `plugins.slots.contextEngine`; OpenClaw's selected context engine/runtime (usually `legacy`) continues to own message assembly and runtime compaction. Graph Memory provides memory side effects: recall, extraction, graph maintenance, and `gm_*` tools.

## Runtime entry points

graph-memory enters OpenClaw through runtime hooks and tools:

- `api.on("before_prompt_build", ...)` performs recall and KG context injection.
- `api.on("before_message_write", ...)` supports `autoRecallMode=index` by prepending a short recall index to matching user messages; it intentionally does not strip transient `<gm_memory>` blocks from the transcript.
- `api.on("agent_end", ...)` stores completed-turn messages, triggers extraction, and runs periodic topic/session/lightweight maintenance.
- `api.on("before_compaction", ...)` performs best-effort fallback extraction before runtime compaction.
- `api.on("after_compaction", ...)` marks compacted active nodes for stable reinjection and refreshes session induction.
- `api.on("subagent_spawned", ...)` / `api.on("subagent_ended", ...)` maintain in-memory recalled context for child sessions on a best-effort basis.
- `api.on("session_end", ...)` performs finalization and background maintenance.
- `api.registerTool(...)` exposes the `gm_*` tools.

This means graph-memory is not called from a CLI loop and is no longer part of the ContextEngine lifecycle. It runs inside the OpenClaw Gateway hook lifecycle and is invoked automatically as sessions progress.

### Lifecycle details

| Entry point | Trigger | Main work | Blocking behavior |
|-------------|---------|-----------|-------------------|
| `before_prompt_build` hook | Before model prompt construction | Parallel recall from recent history + current prompt; assemble stable/dynamic KG XML | awaited; returns `appendSystemContext` / `prependContext` |
| `before_message_write` hook | Before user message persistence | In index mode, prepend short recall index; transcript stripping is intentionally not done here | awaited |
| `agent_end` hook | After each assistant turn | Save new messages, trigger extraction, periodic topic/session induction, lightweight PageRank | hook is observational; extraction/topic induction are fire-and-forget; periodic session induction is awaited inside the hook |
| `before_compaction` hook | Before runtime compaction | Fallback extraction for unextracted GM messages | awaited by hook runner; does not own compaction |
| `after_compaction` hook | After runtime compaction | Mark compacted active nodes and run session induction | awaited by hook runner; induction is fire-and-forget |
| `subagent_spawned` hook | After subagent creation | Best-effort copy of current recalled graph context to child session | awaited by hook runner |
| `subagent_ended` hook | Child session end | Remove child recalled context and counters | awaited by hook runner |
| `session_end` hook | Session close | finalize, topic/session induction, retention+dedup+PageRank maintenance, belief signals | handler starts fire-and-forget tasks and returns quickly |
| runtime lifecycle cleanup | Plugin unload/reset/delete/disable/restart | Clear in-memory maps | awaited by host when supported |

### before_prompt_build in detail

`before_prompt_build` is the primary injection entry point:

1. Clean the current prompt with `cleanPrompt`.
2. Build two recall queries:
   - `historyQuery`: the last 2 user-bounded turns, excluding the current prompt.
   - `promptQuery`: the cleaned current user prompt.
3. Run `parallelRecall(recaller, historyQuery, promptQuery)` and merge results.
4. Persist recalled nodes into `gm_recalled` for dream/retention/debugging.
5. Load stable nodes:
   - global `hot` nodes,
   - `scope_hot:<scope>` nodes for scopes bound to this session,
   - compacted active nodes that need to survive compaction.
6. Render stable context with `assembleStableContext` and dynamic recall context with `assembleDynamicContext`.
7. Record access for L1 nodes (`access_count`, `last_accessed_at`) for the forgetting/decay mechanism.
8. Return `appendSystemContext` for stable KG and `prependContext` for dynamic KG.

### agent_end in detail

`agent_end` is the main extraction entry point:

1. Determine the session from hook context (`ctx.sessionId` / `ctx.sessionKey`).
2. Prefer the runtime pre-prompt message count when available; otherwise use the last observed runtime length and recent-message fingerprints so compaction does not confuse DB `turn_index` with runtime array indexes.
3. Strip transient `<gm_memory>` blocks before saving messages into `gm_messages`.
4. Trigger `runTurnExtract` on new messages. Extraction is serialized per session with `extractChain` so overlapping turns do not corrupt writes.
5. Every `compactTurnCount` turns:
   - run topic induction in the background,
   - run session induction for the current session,
   - recompute lightweight global PageRank.

`runTurnExtract` handles node/edge extraction, belief updates, embeddings, and optional memory-advisor suggestions.

### Compaction hooks in detail

Graph Memory does not own runtime compaction. OpenClaw's active context engine/runtime performs the actual transcript compaction. Graph Memory only performs memory-side work around that lifecycle:

1. `before_compaction` runs fallback extraction for unextracted `gm_messages` rows.
2. `after_compaction` marks current-session active nodes that should remain visible in the stable KG layer.
3. Those marked active nodes are rendered by future `before_prompt_build` calls when `compactActiveNodesEnabled=true`.

### session_end in detail

`session_end` starts four background tasks:

1. **Finalize**: promote reusable knowledge, add missed edges, invalidate obsolete nodes.
2. **Topic/session induction**: update TOPIC and SESSION summaries.
3. **Maintenance**: retention cleanup, vector dedup, global PageRank.
4. **Belief signal**: emit low-weight `task_completed` evidence for session nodes.

## Current features

### Node types

| Type | Meaning |
|------|---------|
| `TASK` | User-requested task with goal, steps, and result |
| `SKILL` | Reusable procedure with trigger, steps, pitfalls |
| `EVENT` | One-off incident/error with symptom, cause, fix |
| `KNOWLEDGE` | Domain knowledge with scope and caveats |
| `STATUS` | Time-sensitive snapshot; never merged semantically |
| `TOPIC` | LLM-induced topic node that groups related semantic nodes |
| `SESSION` | LLM-induced session summary node |

### Edges

Edges use a flexible schema:

- `name`: free-form relation name, generated by the LLM or tools (for example `使用`, `解决`, `依赖`, `扩展`, `冲突`, `来自会话`).
- `description`: one-sentence explanation of the relationship.

Older typed edges are migrated to this flexible schema by migration `m7_edge_flexible`.

### Recall path

The old generalized/community recall design is not part of the current runtime. The current recall path is precise-only:

```text
Query
  └─ vector search if embedding is ready, otherwise FTS5/LIKE search
      ├─ semantic seeds: top ceil(recallMaxNodes / 3)
      ├─ PageRank candidates: top ceil(recallMaxNodes / 5), used only as graph-expansion anchors
      ├─ graphWalk(maxDepth = recallMaxDepth): iterative BFS, N means N hops
      ├─ Personalized PageRank from semantic seeds
      ├─ combinedScore = semantic × 0.5 + PPR × 0.4 + PageRank × 0.1
      ├─ access-based decay adjusts combinedScore when decayEnabled !== false
      └─ tiers: L1 / L2 / L3 / filtered
```

`before_prompt_build` runs recall twice: once from the last 2 user-bounded history turns and once from the current prompt, then merges by node name with tier priority. The merged recall result is persisted to `gm_recalled`; only L1 nodes update access tracking after assembly.

PPR teleports to semantic seeds. Global PageRank candidates are only expansion anchors, not PPR seeds. Dangling PPR mass is returned to the semantic seeds.

Keyword hybrid scoring mixes vector similarity with keyword overlap:

```text
hybridSemantic = vectorSim × (1 - KEYWORD_WEIGHT + keywordScore × KEYWORD_WEIGHT)
KEYWORD_WEIGHT = 0.4
```

`graphWalk(maxDepth=N)` now means "walk N hops":

- `maxDepth=0`: only seed nodes
- `maxDepth=1`: seed + one-hop neighbors
- `maxDepth=2`: seed + one-hop + two-hop neighbors

### Tiered context injection

| Tier | Injection/rendering behavior |
|------|------------------------------|
| `scope_hot` | Stable layer; full description + content; rendered for sessions bound to matching scope |
| `hot` | Stable layer; full description + content; rendered in every session |
| `active` | Stable layer after compaction; current-session nodes that must remain visible |
| `L1` | Dynamic layer; full description + content |
| `L2` | Dynamic layer; description only |
| `L3` | Dynamic layer; name only |
| `filtered` | Not injected |

Stable context is appended to system context; dynamic context is prepended as turn context. `debugContextPreview` or `GM_DEBUG_CONTEXT_PREVIEW=1` logs context previews.


### Scope Hot

Scope Hot is the scoped version of Hot memory. It is implemented through node flags and session-scope bindings:

- A node with flag `hot` is rendered in every session.
- A node with flag `scope_hot:<scope>` is rendered only when the current session is bound to `<scope>`.
- Session bindings are stored in `gm_scopes`.
- Matching scope-hot nodes are loaded by `getScopeHotNodes()` during `before_prompt_build`.

Typical flow:

```text
gm_set_scope(["gm开发"])
  → current session bound to gm开发

gm_set_scope_hot("gm-plugin-development-core-principles", "gm开发")
  → node gets flag scope_hot:gm开发

next before_prompt_build
  → getScopesForSession(session)
  → getScopeHotNodes(scopes)
  → assembleStableContext(... scopeHotNodes ...)
  → node rendered with tier="scope_hot" and scope_hot="true"
```

`scope_hot` has higher tier priority than global `hot`, so if the same node appears in both places it is rendered once as `scope_hot`.

### Belief/confidence system

Each node can have a `belief` score in `[0, 1]`.

Signal sources:

- Extractor `beliefUpdates` for recalled nodes: `supported` or `contradicted` with weight `0.5~2.0`.
- `session_end`: `task_completed` signal for session nodes with low weight.
- Manual tools such as `gm_record` store knowledge but intentionally do not process belief updates.

The stats tool reports average/high/low belief and signal counts.


### Forgetting, retention, and decay

graph-memory has two different "forgetting" layers. They intentionally solve different problems.

#### 1. Context forgetting: compaction + active-node carry-over

Raw chat context is still compacted by the normal OpenClaw runtime. graph-memory does not own full compaction. Around compaction, it:

- removes stale `<gm_memory>` blocks from the session file,
- runs fallback extraction for any unextracted messages,
- marks current-session nodes as `active` carry-over nodes,
- delegates the actual text compaction back to the runtime.

After compaction, those marked active nodes are rendered in the stable KG layer so important in-session knowledge does not disappear immediately. Active nodes are capped at 100, with minimum retention for TASK/EVENT/KNOWLEDGE and SKILL protected from trimming.

#### 2. Storage forgetting: retention cleanup

Retention cleanup deletes old raw session history rows, not semantic knowledge nodes. It affects:

- `gm_messages`
- `gm_recalled`

It does **not** delete `gm_nodes` or `gm_edges`. Semantic forgetting is represented separately by soft deletion (`status='deprecated'`), merge, and recall decay.

Retention only targets inactive sessions older than `retention.retentionDays`. Protected sessions are derived from the OpenClaw session store: running sessions plus sessions updated within the cutoff. The delete budget is shared: `gm_messages` first, then `gm_recalled`.

#### 3. Recall forgetting: access-based decay

Access decay does not delete memory. It lowers recall ranking for stale/low-value nodes. L1 nodes that are actually injected are recorded with:

- `access_count`
- `last_accessed_at`

The decay engine computes:

```text
composite = recencyWeight × recency
          + frequencyWeight × frequency
          + intrinsicWeight × intrinsic

recency   = Weibull stretched-exponential decay since last access
frequency = saturated function of access_count
intrinsic = type importance × belief
```

Node type controls decay speed and floor:

| Type | Behavior |
|------|----------|
| `SKILL`, `TOPIC` | Very stable; floor 0.8; slow decay |
| `KNOWLEDGE` | Moderately stable; floor 0.65 |
| `EVENT` | Medium/fast decay; floor 0.35 |
| `TASK` | Completed tasks fade faster; floor 0.35 |
| `STATUS` | Fastest decay; floor 0.2; intended for snapshots |

The recall score is multiplied by `0.3 + 0.7 × max(typeFloor, composite)`, then results are re-sorted and re-tiered. `decayEnabled=false` disables this ranking adjustment.

#### 4. Semantic soft deletion

Nodes are not hard-deleted by normal tools. `gm_remove` and `gm_merge` mark nodes as `deprecated`; `gm_remove` also removes incident edges. Deprecated nodes are filtered out of normal search/recall and edge creation. If a deprecated node is later upserted or receives flags, it can be revived to `active`.

### Topic and session induction

- Topic induction creates/updates `TOPIC` nodes and `semantic → TOPIC` / `TOPIC ↔ TOPIC` edges.
- Session induction creates/updates `SESSION` nodes summarizing a session and links session-created nodes with `来自会话` edges.
- Periodic induction runs every `compactTurnCount` turns; both also run at `session_end`.
- `gm_induce_topics(name)` manually induces topics around a specific semantic node.

### Maintenance and retention

`runMaintenance()` currently does:

1. **Retention cleanup** of inactive session history (`gm_messages`, then remaining budget for `gm_recalled`).
2. **Vector dedup** using cosine similarity and `dedupThreshold`.
3. **Global PageRank** recomputation.

Retention details:

- Enabled by default.
- Protected sessions are `running` sessions plus sessions updated within the retention cutoff.
- Default retention is 30 days, max 20,000 deleted rows per maintenance run.
- `VACUUM` is never automatic unless `retention.vacuum=true`; default is false.

Community detection/runtime code has been removed. The legacy `gm_nodes.community_id` column and `gm_communities` table remain only for schema compatibility.

### gm_dream and gm_explore

- `gm_explore(nodeName, maxNodes?)`: explores a node-centered subgraph using semantic neighbors + graph walk; returns an L1-oriented subgraph text for LLM use. It records access for returned L1 nodes. If the seed has no related nodes, it returns an `isolated: true` result instead of fabricating context.
- `gm_dream()`: samples anchors from two recent pools: recalled nodes and newly created nodes. Each pool is limited to the last 168 hours (7 days) and 50 entries, then sampled with exponential time decay. For each sampled seed, it explores the seed subgraph and also supplements active nodes from the seed's most recent session.

## Extraction, induction, and testing details

- `extract.ts` renders each message block with an ~800-character cap and skips thinking blocks.
- Extraction prompts reject common-sense knowledge; `beliefUpdates` only update existing recalled nodes, not nodes created in the same extraction.
- `beliefUpdates` use verdict `supported` / `contradicted`, weight `0.5..2.0`, and truncated reasons.
- `advisorySuggestions` are only acted on for newly created nodes and are usually triggered by long content or complex structured data.
- Topic induction only creates/updates TOPIC nodes and topic edges. It hard-validates `semantic → TOPIC` as `主题属于`, and `TOPIC ↔ TOPIC` as `主题包含` / `主题父级`.
- LLM calls disable tool calls (`tool_choice: none`), use low temperature, timeout/retry; embedding startup pings the endpoint and falls back to FTS5 if unavailable.
- Most tests use mocked LLMs. `belief-e2e.test.ts` uses a production DB copy plus real LLM config. Dream real-DB tests require `RUN_GM_REAL_DB_TESTS=1`.

## Agent tools (22 total)

| Tool | Description |
|------|-------------|
| `gm_search(query)` | Recall relevant nodes and edges from the graph |
| `gm_record(content, flags?)` | Extract and record manual knowledge; optional `hot` / `scope_hot:<scope>` flags |
| `gm_stats()` | Node/edge/hot/PageRank/embedding/belief stats |
| `gm_maintain()` | Manual retention cleanup + dedup + global PageRank |
| `gm_get_hots()` | List all global hot nodes |
| `gm_get_scope_hots(scope)` | List scope-hot nodes for one scope |
| `gm_set_flags(name, flags)` | Replace a node's flags |
| `gm_get_node(name)` | Get full node data plus incoming/outgoing edges |
| `gm_edit_node(name, description?, content?, type?)` | Overwrite node fields and re-embed |
| `gm_set_hot(name)` | Add global `hot` flag |
| `gm_set_scope_hot(name, scope)` | Add `scope_hot:<scope>` flag |
| `gm_get_flags(name)` | Show a node's flags |
| `gm_set_scope(scopes)` | Bind current session to scopes; `[]` clears |
| `gm_get_scope()` | Show current session scopes |
| `gm_list_scopes()` | List scopes and bound session counts |
| `gm_remove(name, reason?)` | Soft-delete a node and remove its incident edges |
| `gm_merge(keepName, mergeName)` | Manually merge two nodes and migrate edges |
| `gm_embedding(name, force?)` | Recompute one node embedding |
| `gm_reembedding_all(confirm, force?)` | Recompute embeddings for all active nodes; requires `confirm=true` |
| `gm_induce_topics(name)` | Induce topics centered on a node |
| `gm_explore(nodeName, maxNodes?)` | Explore a node-centered subgraph |
| `gm_dream()` | Random decayed exploration from recent recalled/created pools; 7-day/50-entry seed windows |

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `dbPath` | `~/.openclaw/graph-memory.db` | SQLite database path |
| `compactTurnCount` | `6` | Periodic agent_end induction/lightweight maintenance interval |
| `recallMaxNodes` | `15` | Tiering cutoff: roughly 1/3 L1, 1/3 L2, 1/3 L3 |
| `recallMaxDepth` | `2` | Graph walk hops from seed/expansion nodes |
| `freshTailCount` | `10` | Deprecated/unused compatibility field |
| `dedupThreshold` | `0.90` | Cosine similarity threshold for vector dedup |
| `pagerankDamping` | `0.85` | PageRank/PPR damping factor |
| `pagerankIterations` | `20` | PageRank/PPR iteration count |
| `extractionRecentTurns` | `3` | Recent user-bounded turns included in extraction prompt |
| `decayEnabled` | `true` | Enable access-based decay scoring |
| `debugContextPreview` | `false` | Log stable/dynamic injected context previews |
| `retention.enabled` | `true` | Enable inactive session history cleanup during maintenance |
| `retention.retentionDays` | `30` | Keep inactive session history for this many days |
| `retention.maxDeletePerRun` | `20000` | Shared deletion budget for `gm_messages` then `gm_recalled` |
| `retention.vacuum` | `false` | Run SQLite `VACUUM` after cleanup; disabled by default |

### LLM and embedding providers

LLM extraction/finalization calls use either plugin `llm.apiKey + llm.baseURL` (OpenAI-compatible chat completions) or Anthropic config fallback. GM sets `tool_choice: "none"`, temperature 0.1, 90s timeout, and retries 429/500/502/503/529.

Embeddings are OpenAI-compatible HTTP calls. Known working targets include:

| Provider | baseURL | Example model |
|----------|---------|---------------|
| OpenAI | `https://api.openai.com/v1` | `text-embedding-3-small` |
| DashScope | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `text-embedding-v4` |
| MiniMax | `https://api.minimax.chat/v1` | `embo-01` |
| Ollama | `http://localhost:11434/v1` | `nomic-embed-text` |

Without embedding config, or if the startup embedding ping fails, graph-memory falls back to FTS5/LIKE search. Embedding calls use an OpenAI-compatible `/embeddings` endpoint with optional `dimensions`, a 10s timeout, and retries.

## Database

SQLite WAL mode at `~/.openclaw/graph-memory.db`.

| Table | Purpose |
|-------|---------|
| `gm_nodes` | Knowledge nodes; includes type, status, belief, access tracking, flags, pagerank, legacy `community_id` |
| `gm_edges` | Flexible relationship edges: `from_id`, `to_id`, `name`, `description` |
| `gm_messages` | Raw conversation messages |
| `gm_signals` | Legacy/general signal records |
| `gm_nodes_fts` | FTS5 table for node name/description/content |
| `gm_vectors` | Embedding vectors keyed by node id |
| `gm_communities` | Legacy compatibility table; runtime no longer uses it |
| `gm_scopes` | Session ↔ scope bindings |
| `gm_recalled` | Per-session merged recall records written by `before_prompt_build`; used by retention and dream recalled-pool sampling |
| `gm_belief_signals` | Belief evidence records |
| `_migrations` | Migration tracker |

### Flags

Flags are stored as JSON array strings on `gm_nodes.flags`:

- `hot` — always rendered in stable context.
- `scope_hot:<scope>` — rendered when the current session is bound to `<scope>`.
- Any other string can be stored, but only the above two have built-in rendering semantics.

## Development

```bash
npm install
npm run build
npm test
```

Default `npm test` uses mocked LLMs for most unit tests and skips real-DB dream/debug tests that require `/tmp/gm-test.db`. `belief-e2e.test.ts` is the notable real-LLM e2e test: it copies the production graph DB to a temp DB and reads graph-memory LLM config from OpenClaw config. To run the gated real-DB dream/debug tests explicitly:

```bash
RUN_GM_REAL_DB_TESTS=1 npm test
```

## Project structure

```text
graph-memory/
├── index.ts                    # Plugin entry, hooks, tools
├── openclaw.plugin.json        # Plugin metadata/config schema
├── src/
│   ├── types.ts                # Core types and DEFAULT_CONFIG
│   ├── engine/
│   │   ├── llm.ts              # LLM wrapper
│   │   ├── embed.ts            # Embedding wrapper
│   │   ├── induction.ts        # Topic/session induction
│   │   └── decay.ts            # Access-based decay engine
│   ├── extractor/
│   │   ├── extract.ts          # LLM extraction/finalization parsing
│   │   └── noise-filter.ts     # Input noise filter
│   ├── format/
│   │   ├── assemble.ts         # Stable/dynamic KG XML rendering
│   │   └── transcript-repair.ts
│   ├── recaller/
│   │   ├── recall.ts           # Precise recall, graphWalk, PPR, decay
│   │   └── score.ts            # Combined score helpers
│   ├── graph/
│   │   ├── pagerank.ts         # Global PageRank and personalized PPR
│   │   ├── dedup.ts            # Vector dedup and merge orchestration
│   │   └── maintenance.ts      # Retention + dedup + PageRank
│   └── store/
│       ├── db.ts               # SQLite migrations/singleton
│       └── store.ts            # CRUD/search/vector/scope/retention helpers
└── test/                       # Vitest tests
```

## Notes for operators

- Do not expose internal table names as user config.
- Do not hardcode the OpenClaw `sessions.json` path; use the plugin session store API.
- Do not auto-VACUUM unless explicitly configured.
- Runtime community detection is intentionally removed; do not reintroduce it unless the feature is redesigned.

## License

MIT

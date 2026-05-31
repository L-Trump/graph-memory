# CLAUDE.md

This file provides guidance to Claude Code / coding agents when working in this repository.

## Project overview

graph-memory is an OpenClaw ContextEngine plugin. It extracts knowledge graph nodes/edges from conversations, stores them in SQLite, recalls relevant graph context across sessions, and injects stable/dynamic KG XML before model calls.

Current runtime features:

- Precise recall via embedding or FTS5/LIKE search, iterative graph walk, Personalized PageRank, combined scoring, and access-based decay.
- Stable context: `scope_hot`, `hot`, compacted active nodes.
- Dynamic context: recalled `L1` / `L2` / `L3` nodes.
- Topic induction and session induction.
- Belief/confidence scoring from `beliefUpdates` and session signals.
- Retention cleanup for inactive `gm_messages` / `gm_recalled` rows.
- Vector dedup and global PageRank maintenance.

Community runtime code has been removed. Only legacy schema compatibility remains (`gm_nodes.community_id`, `gm_communities`). Do not reintroduce community detection unless explicitly redesigning the feature.

## Development commands

```bash
npm run build                    # bundle TypeScript with tsup
npm test                         # run default Vitest suite
npm run test:watch               # watch mode
npx vitest run test/foo.test.ts   # run one test file
```

Default `npm test` skips real-DB dream/debug tests that depend on `/tmp/gm-test.db`. To run those explicitly:

```bash
RUN_GM_REAL_DB_TESTS=1 npm test
```

## Core files

- `index.ts` — plugin entry; ContextEngine implementation; hooks; all `gm_*` tools.
- `src/types.ts` — `GmNode`, `GmEdge`, config, extraction/finalize/recall result types.
- `src/store/db.ts` — SQLite singleton and idempotent migrations.
- `src/store/store.ts` — node/edge/message/vector/search/scope/retention helpers.
- `src/recaller/recall.ts` — precise recall pipeline, graph expansion, PPR, tiering, decay.
- `src/graph/pagerank.ts` — global PageRank and Personalized PageRank.
- `src/graph/dedup.ts` — vector duplicate detection and merge orchestration.
- `src/graph/maintenance.ts` — retention cleanup → dedup → PageRank.
- `src/engine/induction.ts` — topic and session induction.
- `src/engine/decay.ts` — access-based decay scoring.
- `src/extractor/extract.ts` — LLM extraction/finalization parsing.
- `src/extractor/noise-filter.ts` — input-layer noise filtering.
- `src/format/assemble.ts` — stable/dynamic KG XML rendering and KG system guidance.


## OpenClaw runtime entry points

Runtime registration happens in `index.ts`:

```ts
api.registerContextEngine("graph-memory", () => engine)
api.on("before_prompt_build", ...)
api.on("session_end", ...)
api.registerTool(...)
```

The important design point: KG rendering is primarily done from the `before_prompt_build` hook, not from `engine.assemble`. `assemble` now mostly normalizes message content.

### Entry-point responsibilities

- `ingest`: synchronous raw message storage into `gm_messages`; skip heartbeats; no LLM.
- `before_prompt_build`: clean prompt, build `historyQuery` from the last 2 user-bounded turns plus `promptQuery` from the current prompt, run `parallelRecall`, persist merged recall results to `gm_recalled`, load hot/scope_hot/compacted active nodes, render stable+dynamic KG, record L1 access only.
- `afterTurn`: save newly generated messages, fire `runTurnExtract`, run periodic topic/session induction and lightweight PageRank every `compactTurnCount` turns.
- `compact`: strip old `<gm_memory>`, fallback extract unextracted messages, mark compacted active nodes, delegate real compaction to runtime.
- `prepareSubagentSpawn`: copy parent recalled graph context into the child session.
- `onSubagentEnded`: clear child recalled context/counters.
- `session_end`: fire-and-forget finalize, topic/session induction, retention+dedup+PageRank maintenance, task_completed belief signals.

### In-memory runtime state

- `recalled`: session key/id → latest recall result used by prompt injection and subagent sharing.
- `msgSeq`: session id → monotonically increasing message/turn count.
- `turnCounter`: session id → afterTurn periodic maintenance counter.
- `compactedActiveNodeIds`: session id → active node ids that should be re-injected after compaction.
- `extractChain`: session id → promise chain that serializes LLM extraction writes.

### Scope Hot mechanics

Scope Hot is implemented with ordinary node flags plus `gm_scopes`:

- Node flag `hot` means render in every session.
- Node flag `scope_hot:<scope>` means render only when the current session is bound to `<scope>`.
- `gm_set_scope(scopes)` overwrites current session scope bindings.
- `gm_set_scope_hot(name, scope)` appends the corresponding node flag.
- `before_prompt_build` calls `getScopesForSession()` then `getScopeHotNodes()` and passes the result to `assembleStableContext`.
- `scope_hot` has the highest tier priority, above `hot`.

### Forgetting model

There are three different mechanisms. Do not conflate them:

1. **Runtime context forgetting**: normal OpenClaw compaction. graph-memory marks current session nodes as compacted active nodes and re-injects them in stable context after compaction.
2. **Storage retention**: maintenance deletes old inactive `gm_messages` and `gm_recalled` rows. It does not delete semantic `gm_nodes` or `gm_edges`.
3. **Recall decay**: access-based decay reduces ranking of stale memories using `access_count`, `last_accessed_at`, node type, and belief. It does not delete anything.

Semantic deletion is soft deletion only: tools mark nodes `deprecated`; normal recall/search/edge creation excludes deprecated nodes.

## Runtime data flow

```text
incoming message
  → ingest(): save gm_messages

before_prompt_build
  → recaller.recallV2
  → saveRecalledNodes
  → assembleStableContext + assembleDynamicContext
  → appendSystemContext + prependContext

afterTurn
  → save new messages
  → runTurnExtract
  → upsertNode/upsertEdge
  → beliefUpdates handling
  → async embedding
  → optional advisory subagent
  → every compactTurnCount turns: topic induction + session induction + global PageRank

session_end
  → finalize
  → topic induction
  → session induction
  → runMaintenance(retention + dedup + PageRank)
  → task_completed belief signals
```

## Recall implementation notes

Current recall is precise-only. Do not document or reintroduce the old generalized/community recall design unless explicitly redesigning it.

Pipeline:

1. If embedding is ready, vector search provides semantic seeds; otherwise FTS5/LIKE search is used.
2. If vector seeds are too few, FTS5 supplements them.
3. Global PageRank top nodes are added only as graph-expansion anchors, not as PPR seeds.
4. `graphWalk(db, seeds, maxDepth)` uses iterative BFS with one `from_id IN (...) OR to_id IN (...)` SQL query per layer.
5. `maxDepth=N` means walk exactly N hops (`1` includes one-hop neighbors).
6. Personalized PageRank starts from semantic seeds.
7. Combined score = semantic `0.5` + PPR `0.4` + global PageRank `0.1`.
8. Access-based decay adjusts combined score unless `decayEnabled === false`.
9. Tier assignment uses `recallMaxNodes`: top third L1, second third L2, third third L3, rest filtered.
10. Access tracking is intentionally only recorded for L1 nodes that are actually assembled/injected.

## Extraction, induction, and tests

- `extract.ts` renders message blocks with an 800-character per-block truncation and skips thinking blocks.
- Extractor prompts reject common-sense knowledge and only emit `beliefUpdates` for existing recalled nodes, not newly created nodes.
- `beliefUpdates` use verdict `supported` / `contradicted`, weight `0.5..2.0`, and reason text capped around 200 chars.
- `advisorySuggestions` are only acted on for newly created nodes and are meant for long or structured knowledge that may deserve a document.
- Topic induction hard-validates edge shapes: semantic → TOPIC uses `主题属于`; TOPIC ↔ TOPIC uses `主题包含` / `主题父级`; semantic ↔ semantic edges are discarded in induction.
- LLM calls use OpenAI-compatible chat completions or Anthropic fallback, `tool_choice: none`, temperature 0.1, 90s timeout, and retry on 429/500/502/503/529.
- Embedding calls use OpenAI-compatible `/embeddings`, optional dimensions, 10s timeout, startup ping, and FTS5 fallback on failure.
- Most tests use mocked LLMs. `belief-e2e.test.ts` uses a production DB copy plus real LLM config. Dream real/debug/fullflow tests are gated behind `RUN_GM_REAL_DB_TESTS=1`.

## Maintenance and retention

`runMaintenance(db, cfg, opts)` currently performs:

1. Retention cleanup, only when `protectedSessionIds` are provided.
   - Protected session rule: running sessions OR sessions updated within cutoff.
   - Deletes from `gm_messages` first, then uses remaining `maxDeletePerRun` budget for `gm_recalled`.
   - `VACUUM` only runs when `retention.vacuum === true`.
2. Async vector dedup.
3. Global PageRank recomputation.

Do not expose internal table names as user-facing config. Do not hardcode `sessions.json`; use OpenClaw session store APIs.

## Database schema summary

- `gm_nodes`: knowledge nodes; supports `TASK`, `SKILL`, `EVENT`, `KNOWLEDGE`, `STATUS`, `TOPIC`, `SESSION`; includes flags, belief, access tracking, pagerank, and legacy `community_id`.
- `gm_edges`: flexible `name` + `description` relationship edges.
- `gm_messages`: raw conversation messages.
- `gm_signals`: generic/legacy signal table.
- `gm_nodes_fts`: FTS5 virtual table for name/description/content.
- `gm_vectors`: embeddings by node id.
- `gm_communities`: legacy compatibility table; runtime no longer uses it.
- `gm_scopes`: scope/session bindings.
- `gm_recalled`: merged recall records written by `before_prompt_build`; used for retention and gm_dream recalled-pool sampling.
- `gm_belief_signals`: belief evidence records.
- `_migrations`: migration tracker.

## Tools registered in index.ts

22 tools are currently registered:

- Search/record/stats/maintenance: `gm_search`, `gm_record`, `gm_stats`, `gm_maintain`
- Hot/scope/flags: `gm_get_hots`, `gm_get_scope_hots`, `gm_set_flags`, `gm_get_flags`, `gm_set_hot`, `gm_set_scope_hot`, `gm_set_scope`, `gm_get_scope`, `gm_list_scopes`
- Node editing: `gm_get_node`, `gm_edit_node`, `gm_remove`, `gm_merge`
- Embeddings: `gm_embedding`, `gm_reembedding_all`
- Induction/exploration: `gm_induce_topics`, `gm_explore`, `gm_dream`

## Configuration defaults

See `src/types.ts` for the source of truth.

Important defaults:

- `compactTurnCount = 6`
- `recallMaxNodes = 15`
- `recallMaxDepth = 2`
- `dedupThreshold = 0.90`
- `pagerankDamping = 0.85`
- `pagerankIterations = 20`
- `extractionRecentTurns = 3`
- `decayEnabled = true`
- `debugContextPreview = false`
- `retention = { enabled: true, retentionDays: 30, maxDeletePerRun: 20000, vacuum: false }`
- `freshTailCount` remains as a deprecated/unused compatibility field.

## Testing notes

- Keep tests deterministic and isolated with `createTestDb()` where possible.
- Real production-DB tests should be guarded behind `RUN_GM_REAL_DB_TESTS=1`.
- `graphWalk(maxDepth)` tests should assert hop semantics, not layer-count semantics.
- Async APIs such as `dedup()` and `detectDuplicates()` must be awaited.

## Safety / development boundary for this user environment

For this local development setup, code changes should be made in `/home/ltrump/Codes/graph-memory/` only unless explicitly instructed otherwise. Do not modify the running extension copy under `~/.openclaw/extensions/graph-memory/`, do not restart Gateway, and do not sync Codes → Extensions without explicit authorization.

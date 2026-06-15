# Graph Memory Architecture

Graph Memory is a hook-only OpenClaw plugin. It runs beside the selected ContextEngine and contributes semantic memory through hooks and tools; it does not own transcript assembly or compaction.

## Boundary

Graph Memory is responsible for:

- extracting durable knowledge graph nodes and edges from eligible conversations;
- recalling relevant graph context before a reply;
- injecting stable and dynamic memory context;
- exposing tools for graph search, inspection, editing, maintenance, embeddings, and topic induction.

Graph Memory is not responsible for:

- lossless transcript storage;
- provider prompt-cache management;
- replacing OpenClaw's context engine;
- preserving exact historical commands or raw tool outputs.

## Data model

The graph stores nodes and edges in SQLite.

Node types:

- `TASK`
- `SKILL`
- `EVENT`
- `KNOWLEDGE`
- `STATUS`
- `TOPIC`
- `SESSION`

Edges have free-form names and descriptions. This lets the extractor represent relations in natural terms such as `使用`, `依赖`, `修复`, `冲突`, or `扩展`.

Important node metadata includes:

- `belief` and signal counts for confidence tracking;
- `flags` for `hot` and `scope_hot:<scope>` visibility;
- `sourceSessions` for extraction provenance;
- access counters and timestamps for decay-aware recall;
- PageRank score for global graph importance.

## Hook lifecycle

### `before_prompt_build`

1. Resolve and normalize runtime config.
2. Resolve a stable session key and session toggle.
3. Check automation eligibility (`enabled`, recall toggle, chat type/id allow/deny lists).
4. Build history and prompt queries.
5. Run cache/circuit-breaker protected recall.
6. Load stable inputs: global hot, scope hot, and optional compact-active nodes.
7. Assemble stable and dynamic context.
8. Persist lightweight status lines for `/status` when enabled.
9. Return `appendSystemContext` and/or `prependContext`, or stage recall-index content for `before_message_write`.

### `before_message_write`

In `autoRecallMode="index"`, this hook prepends a short recall index to the user message when the prompt hash matches the staged recall result. This mode is intended to improve provider prompt-cache stability by avoiding a large dynamic prepend.

### `agent_end`

1. Select new messages for the run.
2. Strip transient GM context from persisted text.
3. Save messages and extract graph nodes/edges when extraction is enabled and eligible.
4. Apply belief updates for recalled nodes.
5. Periodically induce topics/session summaries and run maintenance.

### Compaction and session hooks

- `before_compaction` can preserve/extract relevant active session material before context is compacted.
- `after_compaction` marks compacted active nodes and may induce a session node.
- `subagent_spawned` / `subagent_ended` preserve parent-child memory continuity.
- `session_end` finalizes extraction, topic/session induction, maintenance, and task-completed belief signals.

## Recall pipeline

The current recall path is precise recall only:

1. embed or FTS query;
2. vector/FTS seed search;
3. PageRank candidate expansion;
4. graph walk from seeds;
5. personalized PageRank;
6. combined scoring with semantic, PPR, and global PageRank components;
7. access decay modulation;
8. tier assignment.

Tiers:

- `L1`: complete content;
- `L2`: description only;
- `L3`: name only;
- `filtered`: internal only, not injected.

## Context layers

### Stable layer

Stable context is appended as system context and is intended to be prefix-stable:

- global `hot` nodes;
- current-session `scope_hot` nodes;
- compact-active nodes when `compactActiveNodesEnabled=true`.

### Dynamic layer

Dynamic context contains the current turn's recalled L1/L2/L3 nodes and relevant edges. In `full` mode it is returned as `prependContext`. In `index` mode a short index is written into the user message instead.

## Runtime resilience

`before_prompt_build` recall is protected by:

- mode-aware in-memory cache;
- timeout wrapper;
- per-session circuit breaker;
- bounded circuit/cache maps;
- status/debug lines.

The timeout bounds hook latency but does not cancel synchronous database or in-flight recall work. Future cooperative deadlines should check budget inside vector scan, graph walk, PPR, and assembly stages.

## Logging

Routine Graph Memory info/debug output can be written to an independent daily file (`/tmp/openclaw/graph-memory-YYYY-MM-DD.log` by default). Warnings and errors remain visible in the OpenClaw host log.

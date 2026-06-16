# Graph Memory

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![OpenClaw](https://img.shields.io/badge/OpenClaw-%5E2026.5.28-7c3aed)
![Version](https://img.shields.io/badge/version-3.0.0-0f766e)
![Node](https://img.shields.io/badge/node-%3E%3D18-339933)

![Graph Memory hero](docs/images/hero.png)

Graph Memory is a hook-only OpenClaw memory plugin that extracts durable knowledge from conversations into a SQLite knowledge graph, recalls relevant nodes across sessions, and injects compact graph context back into eligible agent turns.

It is designed for **semantic memory**: workflows, preferences, project knowledge, lessons learned, and reusable facts. It is not a lossless transcript store; use a context engine such as lossless-claw for raw conversation preservation and compaction.

## Why Graph Memory

Long-running agents need more than a larger prompt window. They need a durable way to remember preferences, project decisions, debugging lessons, reusable workflows, and relationships between facts without replaying entire transcripts. Graph Memory turns selected conversation knowledge into a typed graph that can be searched, ranked, traversed, corrected, and maintained over time.

Use it when you want an assistant to stop rediscovering the same context, but still keep exact transcript recall and evidence in a separate lossless context system.

## Contents

- [Highlights](#highlights)
- [What it does](#what-it-does)
- [How it fits with OpenClaw](#how-it-fits-with-openclaw)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Runtime controls](#runtime-controls)
- [Architecture at a glance](#architecture-at-a-glance)
- [Documentation](#documentation)
- [Common operations](#common-operations)
- [Operations](#operations)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Development](#development)
- [Glossary](#glossary)
- [Safety and privacy](#safety-and-privacy)
- [Status and compatibility](#status-and-compatibility)
- [License](#license)

## Highlights

- **Knowledge graph, not transcript replay** — stores durable semantic nodes and typed edges in SQLite, with provenance, confidence signals, access metadata, and PageRank scores.
- **Hook-only OpenClaw integration** — runs alongside the selected context engine through OpenClaw hooks; it does not replace transcript assembly or compaction.
- **Precise cross-session recall** — combines embedding or FTS5 seed search, graph walk, personalized PageRank, global PageRank, keyword scoring, and access decay.
- **Stable + dynamic context injection** — separates always-visible `hot`/`scope_hot` memories from per-turn recalled `L1/L2/L3` context to keep prompts compact and predictable.
- **Agent-operable memory tools** — exposes `gm_*` tools for search, inspection, explicit recording, graph exploration, manual edits, flag management, topic induction, embeddings, and maintenance.
- **Operational safety controls** — supports global and per-session recall/extraction toggles, chat allow/deny lists, timeouts, recall caching, circuit breakers, and independent plugin logging.
- **Bounded maintenance** — retention cleanup, PageRank refresh, and incremental vector dedup are budgeted so large graphs can be maintained without repeated full dedup scans.
- **Privacy-oriented design** — durable semantic memory is kept separate from raw transcript preservation; transient injected context and secrets should not be persisted as memories.

## What it does

- Extracts structured nodes (`TASK`, `SKILL`, `EVENT`, `KNOWLEDGE`, `STATUS`, `TOPIC`, `SESSION`) and labeled edges from conversations.
- Recalls memories with embedding or FTS5 search, graph walk, personalized PageRank, keyword scoring, and access decay.
- Splits injected context into a stable layer (`hot`, `scope_hot`, compact-active nodes) and a dynamic recall layer (`L1/L2/L3`).
- Provides `gm_*` tools for search, inspection, editing, flags, scope hot nodes, embeddings, maintenance, topic induction, and dream-style graph review.
- Runs as OpenClaw hooks only; it does **not** occupy the `contextEngine` slot.

## How it fits with OpenClaw

Graph Memory complements, rather than replaces, OpenClaw's context engine:

- use Graph Memory for durable semantic knowledge that should survive across sessions;
- use lossless context tooling for exact transcript recall, compaction lineage, commands, raw tool output, and source-message evidence;
- verify live facts such as files, code, service state, and current configuration directly instead of trusting stored memory.

Automatic recall/extraction only runs in eligible sessions. Tools remain available even when automation is disabled.

## Installation

Graph Memory is an OpenClaw plugin package. It expects OpenClaw `^2026.5.28` and ships a built extension entry at `dist/index.js`.

For development or source installs:

```bash
npm install
npm run build
```

Then enable the plugin from OpenClaw's plugin configuration. A minimal entry looks like:

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

If embedding or extraction models need API keys, prefer OpenClaw SecretRef-backed configuration rather than plaintext secrets. See [Configuration](docs/configuration.md) for the full schema and source-of-truth notes.

## Quick start

1. Install and enable the plugin.
2. Configure `plugins.entries.graph-memory.config.dbPath` if the default database path is not desired.
3. Optionally configure `embedding` for semantic vector search. Without embedding, Graph Memory falls back to FTS5.
4. Use `/gm status` in a session to inspect session-level recall/extraction toggles.
5. Use `gm_search` and `gm_get_node` to inspect memories; use `gm_record` for explicit durable records.

## Runtime controls

Graph Memory supports global config and per-session toggles:

```text
/gm status
/gm on [all|recall|extract]
/gm off [all|recall|extract]
/gm help
```

Global automation is controlled by `enabled`, `recallEnabled`, `extractionEnabled`, `allowedChatTypes`, `allowedChatIds`, and `deniedChatIds`. Session toggles are stored in OpenClaw keyed plugin state when available.

A compact production-oriented config usually sets eligibility, latency budgets, and retention explicitly:

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

`embedding` enables semantic vector search; otherwise recall falls back to FTS5. `llm` can override the model used for extraction and topic induction.

## Architecture at a glance

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

"Hook-only" means Graph Memory contributes memory through OpenClaw plugin hooks and tools while leaving the selected `contextEngine` responsible for transcript assembly and compaction. In `autoRecallMode=full`, dynamic recall is injected as temporary prompt context; in `autoRecallMode=index`, a short recall index is written into the user message to improve prefix-cache stability.

![Graph UI example](docs/images/graph-ui.png)

## Documentation

- [Architecture](docs/architecture.md) — hook lifecycle, storage model, recall/extraction flow, and context injection layers.
- [Configuration](docs/configuration.md) — config keys, defaults, source-of-truth notes, and operational impact.
- [Diagnostics](docs/diagnostics.md) — how to debug recall, extraction, logging, eligibility, timeouts, and database health.
- [Agent tools](docs/agent-tools.md) — recommended `gm_*` tool usage patterns and safety boundaries.

## Common operations

### Tool map

| Task | Tools |
| --- | --- |
| Search and inspect | `gm_search`, `gm_get_node`, `gm_explore`, `gm_stats`, `gm_get_flags` |
| Record and edit | `gm_record`, `gm_edit_node`, `gm_remove`, `gm_merge` |
| Hot/scope visibility | `gm_get_hots`, `gm_set_hot`, `gm_set_flags`, `gm_get_scope`, `gm_set_scope`, `gm_get_scope_hots`, `gm_set_scope_hot`, `gm_list_scopes` |
| Embeddings and maintenance | `gm_maintain`, `gm_embedding`, `gm_reembedding_all` |
| Higher-level graph review | `gm_induce_topics`, `gm_dream` |

Detailed tool guidance lives in [Agent tools](docs/agent-tools.md).

### Search and inspect memory

```text
gm_search("topic or problem")
gm_get_node("exact-node-name")
gm_explore("exact-node-name")
```

### Record a durable fact

```text
gm_record("Natural-language description of the fact, workflow, or lesson.")
```

Do not mark records as `hot` unless the user explicitly asks. Hot and scope-hot memories are always injected and should remain scarce.

### Maintain the graph

```text
gm_maintain()
```

Maintenance recomputes graph ranking and runs deduplication/cleanup paths. Large embedding refreshes (`gm_reembedding_all`) are expensive and should be confirmed before use.

### Observe maintenance cost

When independent logging is enabled, routine plugin metrics are written to a daily file such as:

```text
/tmp/openclaw/graph-memory-YYYY-MM-DD.log
```

Useful maintenance fields include:

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

For large graphs, `dedupMaxPendingVectorsPerRun`, `dedupMaxPairsPerRun`, `dedupMaxMergesPerRun`, `pagerankIterations`, and retention settings are the main operational budgets to tune.

### Example injected context

Graph Memory injects compact XML-like context into eligible turns. A simplified example:

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

The exact rendered nodes depend on hot/scope-hot flags, recall results, graph ranking, confidence, and token budgets.

## Operations

- The default SQLite database path is `~/.openclaw/graph-memory.db`; set `dbPath` to relocate it.
- Schema migrations run automatically when the plugin opens the database. Back up the database before large migrations, bulk merges, full re-embedding, or manual recovery.
- `gm_maintain()` handles retention cleanup, incremental vector dedup, and PageRank refresh. Retention removes old raw `gm_messages` / `gm_recalled` rows for inactive sessions; it is not a semantic node/edge deletion policy.
- `gm_remove()` deprecates a node rather than erasing all historical evidence. `gm_merge()` moves useful content/edges into the kept node and deprecates the merged node.
- `gm_reembedding_all()` can be expensive and should be explicitly confirmed before running on large databases.
- If SQLite is running in WAL mode, backup with SQLite's backup API or ensure the `-wal` and `-shm` files are handled consistently.

## Troubleshooting

- No memories recalled: check `/gm status`, `recallEnabled`, chat eligibility, allow/deny lists, and whether embedding is configured or FTS5 fallback is expected.
- Extraction not happening: check `extractionEnabled`, LLM config, session eligibility, and the Graph Memory log.
- Slow recall: inspect recall timing logs, `recallTimeoutMs`, cache TTL, circuit breaker status, `recallMaxNodes`, and `recallMaxDepth`.
- Slow maintenance: inspect `dedup_*` and `pagerank_ms` fields in the independent log; tune dedup budgets and PageRank settings.
- Database errors or locks: stop concurrent maintenance, back up the database, inspect SQLite integrity, and see [Diagnostics](docs/diagnostics.md).

## FAQ

**Does Graph Memory preserve exact conversation history?**
No. It stores semantic graph memories. Use a lossless context engine for exact transcript/source-message recall.

**Does embedding cost money?**
It can, depending on the configured provider. Without embedding, Graph Memory falls back to SQLite FTS5 search.

**What happens if I disable the plugin?**
Automation stops according to the global or session toggle. Existing database content remains available to tools unless the plugin itself is removed.

**Can I remove a bad memory?**
Yes. Use `gm_remove` to deprecate a node, or `gm_edit_node` / `gm_merge` to correct and consolidate it.

**Will this slow down prompts?**
Recall adds hook work and prompt context. Use `recallTimeoutMs`, cache/circuit-breaker settings, `recallMaxNodes`, `recallMaxDepth`, and the diagnostics log to tune latency.

**Can I export or back up memory?**
The primary store is SQLite at `dbPath`; back up that database consistently, including WAL files if applicable.

## Development

```bash
npm test
npm run build
```

The default test command runs the Vitest suite. Some real-database, real-model, or exploratory tests may require explicit environment flags or local credentials; keep release gates focused on deterministic tests plus `npm run build` unless a change touches those integrations.

`README.md` is the source-of-truth project README. `README_CN.md` may lag behind and should be updated separately when preparing a bilingual release.

Source edits should be made in the development checkout, not directly in a running OpenClaw extensions directory. Syncing a build to a runtime extension and restarting Gateway are operational actions that require explicit user authorization in this environment.

Recommended change workflow:

1. update source and manifest defaults together when changing configuration;
2. run targeted tests for the touched subsystem;
3. run the full test suite before release-sensitive changes;
4. build `dist/index.js`;
5. review the diff and commit from the development checkout;
6. sync to a runtime extension only as a separate authorized operational step.

## Glossary

- **Hot node**: a globally pinned memory that is always injected; use sparingly.
- **Scope-hot node**: a pinned memory injected only when the session has a matching scope.
- **L1/L2/L3**: dynamic recall tiers. L1 includes full content, L2 includes descriptions, and L3 includes names only.
- **PPR**: personalized PageRank over the local recalled subgraph.
- **Decay**: access-aware ranking adjustment that lowers stale or low-confidence memories without deleting them.
- **Dedup**: vector-similarity based duplicate detection and merge support.
- **Recall index**: a compact index written to the user message in `autoRecallMode=index` instead of large dynamic prepend context.
- **Deprecated node**: a node hidden from normal active use without necessarily erasing all historical evidence.

## Safety and privacy

Graph Memory stores durable semantic memories: nodes, edges, metadata, vectors, access timestamps, and limited raw rows used for extraction/recall bookkeeping. It should avoid persisting transient injected context, raw secrets, or private cross-session details that are not needed as durable knowledge. Treat current files, code, service state, and system configuration as live facts that must be verified directly rather than inferred from memory.

Use these controls when privacy boundaries matter:

- disable automation globally with `enabled=false`, or separately with `recallEnabled=false` / `extractionEnabled=false`;
- use `/gm off recall`, `/gm off extract`, or `/gm off all` for a session-level stop;
- restrict automation with `allowedChatTypes`, `allowedChatIds`, and `deniedChatIds`;
- use `gm_remove` to deprecate an incorrect or sensitive node;
- keep API keys in OpenClaw SecretRef-backed config.

## Status and compatibility

Graph Memory is an active OpenClaw plugin package. The current package version is `3.0.0` and the peer dependency is `openclaw ^2026.5.28`. Runtime support expects Node.js `>=18`.

Repository: <https://github.com/adoresever/graph-memory>

Issues and support: <https://github.com/adoresever/graph-memory/issues>

## License

See [LICENSE](LICENSE).

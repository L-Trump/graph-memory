# Graph Memory

Graph Memory is a hook-only OpenClaw memory plugin that extracts durable knowledge from conversations into a SQLite knowledge graph, recalls relevant nodes across sessions, and injects compact graph context back into eligible agent turns.

It is designed for **semantic memory**: workflows, preferences, project knowledge, lessons learned, and reusable facts. It is not a lossless transcript store; use a context engine such as lossless-claw for raw conversation preservation and compaction.

## What it does

- Extracts structured nodes (`TASK`, `SKILL`, `EVENT`, `KNOWLEDGE`, `STATUS`, `TOPIC`, `SESSION`) and labeled edges from conversations.
- Recalls memories with embedding or FTS5 search, graph walk, personalized PageRank, keyword scoring, and access decay.
- Splits injected context into a stable layer (`hot`, `scope_hot`, compact-active nodes) and a dynamic recall layer (`L1/L2/L3`).
- Provides `gm_*` tools for search, inspection, editing, flags, scope hot nodes, embeddings, maintenance, topic induction, and dream-style graph review.
- Runs as OpenClaw hooks only; it does **not** occupy the `contextEngine` slot.

## Quick start

1. Install/enable the plugin in OpenClaw.
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

## Documentation

- [Architecture](docs/architecture.md) — hook lifecycle, storage model, recall/extraction flow, and context injection layers.
- [Configuration](docs/configuration.md) — config keys, defaults, source-of-truth notes, and operational impact.
- [Diagnostics](docs/diagnostics.md) — how to debug recall, extraction, logging, eligibility, timeouts, and database health.
- [Agent tools](docs/agent-tools.md) — recommended `gm_*` tool usage patterns and safety boundaries.

## Common operations

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

## Development

```bash
npm test
npm run build
```

Source edits should be made in the development checkout, not directly in a running OpenClaw extensions directory. Syncing a build to a runtime extension and restarting Gateway are operational actions that require explicit user authorization in this environment.

## Safety and privacy

Graph Memory stores durable semantic memories. It should avoid persisting transient injected context, raw secrets, or private cross-session details that are not needed as durable knowledge. Treat current files, code, service state, and system configuration as live facts that must be verified directly rather than inferred from memory.

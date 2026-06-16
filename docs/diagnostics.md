# Graph Memory Diagnostics

This guide explains how to debug Graph Memory recall, extraction, maintenance, database health, and runtime eligibility.

## Quick Triage

Start with the session command:

```text
/gm status
```

Look for:

- global enabled state;
- recall/extraction state;
- chat type and conversation id;
- eligibility result;
- resolved key config values;
- cache/circuit state;
- last recall status and token counts;
- independent log config.

Then inspect the independent log if enabled:

```bash
ls -lh /tmp/openclaw/graph-memory-*.log
tail -n 80 /tmp/openclaw/graph-memory-$(date +%F).log
```

The log is JSONL. Routine info/debug should be there; warnings/errors also go to the host logger.

## Common Symptoms

### No memories recalled

Checklist:

1. `/gm status` shows `global=on` and `recall=on`.
2. `eligibility=yes`.
3. `allowedChatTypes` includes the current chat type.
4. `allowedChatIds` is empty or includes the current conversation id.
5. `deniedChatIds` does not include the current conversation id.
6. Session toggle has not disabled recall.
7. Circuit breaker is not open.
8. Recall query is not empty/noisy.
9. Embedding config is valid or FTS5 fallback has content.

Useful actions:

```text
/gm status
gm_search("distinctive keyword from expected memory")
gm_stats()
```

### Extraction not happening

Checklist:

1. `/gm status` shows extraction on.
2. `extractionEnabled=true` globally.
3. Chat/session is eligible.
4. LLM/extraction path is configured and reachable.
5. New messages are actually selected by `agent_end`.
6. Noise filters are not filtering the turn.
7. Extraction recent-turn window contains useful text.

Useful actions:

```text
/gm status
gm_stats()
gm_search("recent fact expected to be extracted")
```

### Recall is slow

Look for timing fields in logs:

- total `before_prompt_build` time;
- embedding time;
- vector search time;
- FTS fallback time;
- graph walk time;
- PPR time;
- tier assignment / decay scoring time;
- context assembly time.

First tuning knobs:

| Knob | Effect |
|---|---|
| `recallMaxNodes` | Lower to render fewer nodes. |
| `recallMaxDepth` | Lower to reduce graph walk expansion. |
| `recallCacheTtlMs` | Raise to reuse more recall results. |
| `recallTimeoutMs` | Raise only if correct recall needs more time. |
| `autoRecallMode` | Try `index` to reduce dynamic prepend churn. |

If vector search dominates, the current implementation may be scanning the vector table. Consider future indexed/vector-extension work for very large graphs.

### Maintenance is slow

Look for fields like:

```text
dedup_mode=incremental
dedup_pending_before=...
dedup_pending_after=...
dedup_checked=...
dedup_comparisons=...
dedup_pairs=...
dedup_merged=...
dedup_ms=...
pagerank_ms=...
```

Interpretation:

| Field | Meaning |
|---|---|
| `dedup_pending_before` | Backlog of vectors needing dedup check before this run. |
| `dedup_pending_after` | Backlog after this run. |
| `dedup_checked` | How many pending vectors were fully checked. |
| `dedup_comparisons` | Number of cosine comparisons performed. |
| `dedup_pairs` | Candidate duplicate pairs found. |
| `dedup_merged` | Actual merges performed. |
| `pagerank_ms` | Time spent in global PageRank recompute. |

Tuning:

- Lower `dedupMaxPendingVectorsPerRun` to reduce per-run cost.
- Raise it during planned maintenance windows to drain backlog faster.
- Lower `pagerankIterations` if PageRank dominates.
- Keep `dedupMaxMergesPerRun` conservative when merge correctness matters.

### Database locked or suspicious

1. Stop concurrent maintenance or long-running runs.
2. Back up the database consistently.
3. Include WAL/SHM files if not using SQLite backup API.
4. Run integrity checks with SQLite tooling.
5. Avoid manual mutation without a rollback plan.

Example read-only checks:

```bash
sqlite3 ~/.openclaw/graph-memory.db 'PRAGMA integrity_check;'
sqlite3 ~/.openclaw/graph-memory.db 'SELECT COUNT(*) FROM gm_nodes WHERE status="active";'
sqlite3 ~/.openclaw/graph-memory.db 'SELECT COUNT(*) FROM gm_edges;'
sqlite3 ~/.openclaw/graph-memory.db 'SELECT COUNT(*) FROM gm_vectors;'
```

Do not run destructive SQL against production without explicit authorization and a backup.

## Status Lines

When `statusDebugEnabled=true`, Graph Memory writes compact plugin status lines into session debug entries. Typical examples:

```text
🧠 Graph Memory: recall=ok stable=3200tok dynamic=4800tok nodes=15 edges=12
🔎 Graph Memory Debug: mode=full cache=miss elapsed=4200ms scope_hot=2 hot=1 compact_active=0
```

These are meant for `/status` visibility and quick operator diagnosis.

## Independent Log

Default path:

```text
/tmp/openclaw/graph-memory-YYYY-MM-DD.log
```

Format: JSONL.

Routing:

- info/debug: file only when possible;
- warn/error: host logger + file;
- startup ready line: host + file.

Rotation:

- controlled by `independentLogFile.maxFileBytes`;
- rotates through `.1` to `.5`.

## Debug Flags

Use these only while actively investigating:

```bash
GM_DEBUG_CONTEXT_PREVIEW=1
GM_DEBUG_RUNTIME_HOOKS=1
GM_DEBUG_RECALL_TIMING=1
```

Warnings:

- context preview logs may contain sensitive summaries;
- timing logs can be noisy;
- enable them for diagnosis and disable afterward.

## Recall Timing Anatomy

A healthy recall log should make it possible to distinguish:

1. prompt/query construction cost;
2. embedding API latency;
3. vector/FTS seed search cost;
4. graph walk expansion cost;
5. PPR cost;
6. scoring/decay/tier assignment cost;
7. context assembly and status persist cost.

If one step dominates, tune that subsystem rather than raising the global timeout blindly.

## Eligibility Debugging

Eligibility depends on:

- runtime config `enabled`;
- action-specific global switch (`recallEnabled` or `extractionEnabled`);
- session toggle state;
- chat type;
- conversation id;
- allowlist/denylist.

Common mistakes:

| Mistake | Symptom |
|---|---|
| `allowedChatTypes` excludes `group` | Group chats show ineligible. |
| `allowedChatIds` non-empty but missing current id | Only listed chats run automation. |
| `deniedChatIds` includes current id | Automation always skipped. |
| `/gm off all` used in session | Both recall and extraction off until toggled back. |
| wrong session key fallback | Status lines appear under unexpected session bucket. |

## Tool-Based Diagnostics

```text
gm_stats()
gm_search("known distinctive memory")
gm_get_node("exact-node-name")
gm_explore("exact-node-name")
gm_get_hots()
gm_get_scope()
gm_get_scope_hots("scope-name")
```

Use `gm_stats()` for high-level counts and embedding status. Use `gm_get_node()` for exact node provenance and edge inspection.

## Production Incident Checklist

1. Preserve logs.
2. Stop risky maintenance if needed.
3. Back up SQLite database.
4. Capture `/gm status` from affected session.
5. Capture relevant independent log lines.
6. Identify whether issue is eligibility, recall, extraction, maintenance, or DB health.
7. Reproduce on a copy or test database before mutating production.
8. Record the lesson back into Graph Memory after resolution.

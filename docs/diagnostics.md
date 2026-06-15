# Graph Memory Diagnostics

This guide is for debugging Graph Memory behavior without guessing from memory or stale logs.

## First checks

1. Run `/gm status` in the affected session.
2. Check whether the session is eligible: chat type, conversation ID allow/deny lists, and session toggle state.
3. Check the independent log file if enabled: `/tmp/openclaw/graph-memory-YYYY-MM-DD.log`.
4. Check OpenClaw host logs only for warnings/errors or startup lines.
5. Verify current source/runtime files directly when diagnosing code behavior.

## Recall does not trigger

Look for status/debug lines such as:

```text
recall=skipped reason=disabled-or-ineligible
```

Common causes:

- `enabled=false` or `recallEnabled=false`.
- `/gm off all` or `/gm off recall` was used in this session.
- `allowedChatTypes` excludes the current chat type.
- `allowedChatIds` is non-empty and does not include this conversation.
- `deniedChatIds` includes this conversation.
- The hook cannot resolve a stable session key.
- The prompt/history query is empty.

Check the resolved config in source/manifest if defaults recently changed. `allowedChatTypes` should default to `direct`, `group`, `channel`, and `explicit`.

## Recall times out or degrades

Symptoms:

```text
[graph-memory] recall degraded: graph-memory recall timeout after ...ms
recall=timeout
circuit=open
```

Actions:

1. Confirm `recallTimeoutMs` is appropriate. Large KG recall can take several seconds with embedding, vector scan, graph walk, and PPR.
2. Enable timing logs only while debugging (`GM_DEBUG_RECALL_TIMING=1` or runtime debug config).
3. Inspect which phase dominates: embedding, vector search, PageRank candidates, graph walk, PPR, decay, or assembly.
4. Temporarily reduce `recallMaxNodes` or `recallMaxDepth` if latency is unacceptable.
5. If timeouts repeat, wait for `recallCircuitBreakerCooldownMs` or clear/restart the process after confirming operational impact.

The timeout wrapper bounds hook latency but does not cancel underlying synchronous work. If event-loop delay is high, investigate DB/vector/PPR cost.

## Recall returns no dynamic context

This can be normal when no relevant nodes are found.

Check:

- Is embedding configured and healthy? If not, FTS5 fallback should still work.
- Does `gm_search` find related nodes manually?
- Are nodes deprecated or filtered by tiers?
- Are hot/scope-hot stable nodes present even if dynamic recall is empty?
- Is `autoRecallMode="index"` staging a short index instead of returning a large prepend?

## Extraction produces no nodes

Check:

- `extractionEnabled` and session toggle state.
- Eligibility filters; extraction uses the same global/session gate as recall.
- Whether only trivial/noisy messages were present.
- LLM configuration and extraction errors in logs.
- Whether injected `<gm_memory>` context was stripped before persistence.

Use `gm_get_node`, `gm_search`, and DB stats to confirm whether extraction is truly absent or just named differently than expected.

## Stable context is too large

Stable context comes from:

- global `hot` nodes;
- current scope's `scope_hot` nodes;
- compact-active nodes when enabled.

Actions:

1. List hot nodes with `gm_get_hots`.
2. List current scopes with `gm_get_scope`, then scope hots with `gm_get_scope_hots`.
3. Remove unnecessary hot/scope-hot flags if the user approves.
4. Keep hot flags scarce; they are always injected.

## Database grows too large

Graph nodes/edges are semantic memory and are not deleted by ordinary retention. Retention mainly cleans inactive-session raw rows (`gm_messages`, `gm_recalled`).

Check:

- `retention.enabled`, `retention.retentionDays`, `retention.maxDeletePerRun`.
- Whether many sessions remain active/protected.
- Whether `gm_recalled` is polluted by repeated cache-hit logging.
- Whether deprecated nodes should be merged or cleaned after review.

Use `gm_maintain` for normal maintenance. Use destructive cleanup only after inspecting targets and confirming impact.

## Logs

Routine info/debug output should go to the independent plugin log when `independentLogFile.enabled=true`:

```text
/tmp/openclaw/graph-memory-YYYY-MM-DD.log
```

Warnings/errors are still emitted to the host log. If the independent log cannot be written, Graph Memory falls back to the host logger.

## Useful commands/tools

```text
/gm status
gm_stats
gm_search
gm_get_node
gm_get_hots
gm_get_scope
gm_get_scope_hots
gm_maintain
```

For exact runtime state, inspect files, logs, process state, and database content directly. Graph Memory itself is historical memory, not proof of current code or config state.

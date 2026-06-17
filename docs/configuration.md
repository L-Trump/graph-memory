# Graph Memory Configuration

Graph Memory configuration lives at:

```text
plugins.entries.graph-memory.config
```

Runtime defaults come from `src/types.ts` (`DEFAULT_CONFIG`). The manifest schema and UI hints live in `openclaw.plugin.json`. Tests guard the most important default values so these two sources do not drift silently.

## Minimal Config

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

This enables the plugin with defaults. Without embedding, recall uses FTS5 fallback.

## Recommended Config

```json
{
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
```

## Source-of-Truth Rules

When changing configuration:

1. update `src/types.ts` `DEFAULT_CONFIG`;
2. update `openclaw.plugin.json` `configSchema.properties` and `uiHints`;
3. update docs if behavior changes;
4. run config/default tests and full tests.

```bash
npm test
npm run build
```

## Automation Controls

| Key | Type | Default | Impact |
|---|---:|---|---|
| `enabled` | boolean | `true` | Master switch for automatic hooks. Tools remain registered. |
| `recallEnabled` | boolean | `true` | Enables automatic `before_prompt_build` recall. |
| `extractionEnabled` | boolean | `true` | Enables automatic persistence/extraction. |
| `allowedChatTypes` | string[] | `direct, group, channel, explicit` | Chat type eligibility. |
| `allowedChatIds` | string[] | `[]` | If non-empty, only listed conversations run automation. |
| `deniedChatIds` | string[] | `[]` | Denylist; takes priority over allowlist. |
| `statusDebugEnabled` | boolean | `true` | Writes Graph Memory status/debug entries into session status. |

Session-level toggles are separate and controlled by `/gm on/off`.

## Recall Resilience

| Key | Type | Default | Impact |
|---|---:|---|---|
| `recallTimeoutMs` | integer | `20000` | Hook latency budget. It does not cancel already-running synchronous work. |
| `recallCacheTtlMs` | integer | `15000` | Mode-aware recall cache TTL. Set `0` to disable. |
| `recallCircuitBreakerMaxTimeouts` | integer | `3` | Consecutive timeouts before temporary skip. |
| `recallCircuitBreakerCooldownMs` | integer | `60000` | How long to wait before retrying after circuit opens. |

Cache key includes session, `autoRecallMode`, history query, and prompt query.

## Recall and Context Injection

| Key | Type | Default | Impact |
|---|---:|---|---|
| `autoRecallMode` | `full` / `index` | `full` | `full` returns dynamic `prependContext`; `index` writes a compact recall index into the user message. |
| `recallMaxNodes` | integer | `15` | Approximate recalled node budget across L1/L2/L3. |
| `recallMaxDepth` | integer | `2` | Graph walk depth from seeds. Higher values cost more. |
| `compactTurnCount` | integer | `6` | Periodic induction/maintenance cadence in turns. |
| `compactActiveNodesEnabled` | boolean | `false` | After compaction, re-inject compact-active session nodes into the stable layer. |
| `compactActiveNodesMax` | integer | `100` | Maximum compact-active nodes injected when the feature is enabled. |

## Storage and Models

| Key | Type | Default | Impact |
|---|---:|---|---|
| `dbPath` | string | `~/.openclaw/graph-memory.db` | SQLite database path. |
| `embedding` | object | unset | Enables vector search and dedup embeddings. Without it, FTS5 fallback is used. |
| `llm` | object | unset | Optional model override for extraction/induction. |

### SecretRef Example

Use the secret system supported by your OpenClaw deployment. A typical shape is:

```json
{
  "embedding": {
    "apiKey": { "secretRef": "openclaw:graph-memory.embedding.apiKey" },
    "model": "text-embedding-3-small",
    "baseURL": "https://api.openai.com/v1"
  },
  "llm": {
    "apiKey": { "secretRef": "openclaw:graph-memory.llm.apiKey" },
    "model": "gpt-4o-mini",
    "baseURL": "https://api.openai.com/v1"
  }
}
```

Do not commit plaintext API keys.

## Extraction

| Key | Type | Default | Impact |
|---|---:|---|---|
| `extractionRecentTurns` | integer | `3` | Recent user-turn window passed to extraction. |
| `extractionEnabled` | boolean | `true` | Global extraction automation switch. |

Extraction is also gated by session eligibility and per-session toggles.

## Maintenance

| Key | Type | Default | Impact |
|---|---:|---|---|
| `dedupThreshold` | number | `0.9` | Cosine similarity threshold for duplicate candidates. |
| `dedupMaxPendingVectorsPerRun` | integer | `2000` | Pending vector budget per maintenance run. `0` means full scan fallback. |
| `dedupMaxPairsPerRun` | integer | `1000` | Duplicate pair processing cap. |
| `dedupMaxMergesPerRun` | integer | `200` | Actual merge cap per run. |
| `pagerankDamping` | number | `0.85` | Global PageRank damping. |
| `pagerankIterations` | integer | `20` | Global PageRank iterations. |

### Retention

| Key | Type | Default | Impact |
|---|---:|---|---|
| `retention.enabled` | boolean | `true` | Enables inactive-session raw row cleanup. |
| `retention.retentionDays` | integer | `30` | Age threshold. |
| `retention.maxDeletePerRun` | integer | `20000` | Deletion cap per maintenance run. |
| `retention.vacuum` | boolean | `false` | Whether to run SQLite `VACUUM`. Usually keep false for routine runs. |

Retention targets raw bookkeeping rows (`gm_messages`, `gm_recalled`) for inactive sessions. It does not delete semantic nodes/edges.

## Decay

| Key | Type | Default | Impact |
|---|---:|---|---|
| `decayEnabled` | boolean | `true` | Enables access-aware decay scoring. |
| `decay.*` | object | see manifest | Controls recency/frequency/intrinsic weights and type floors. |

Decay changes ranking. It does not delete nodes.

## Logging and Diagnostics

| Key | Type | Default | Impact |
|---|---:|---|---|
| `debugContextPreview` | boolean | `false` | Logs context previews. Use carefully; may include sensitive summaries. |
| `independentLogFile.enabled` | boolean | `true` | Writes routine info/debug logs to plugin-owned JSONL file. |
| `independentLogFile.file` | string | daily `/tmp/openclaw/graph-memory-YYYY-MM-DD.log` | Explicit log path. |
| `independentLogFile.maxFileBytes` | integer | `104857600` | Rotate at size, keeping `.1` through `.5`. |

Environment flags used for debugging include:

- `GM_DEBUG_CONTEXT_PREVIEW=1`
- `GM_DEBUG_RUNTIME_HOOKS=1`
- `GM_DEBUG_RECALL_TIMING=1`

## Tuning Recipes

### Large graph, maintenance too slow

```json
{
  "dedupMaxPendingVectorsPerRun": 500,
  "dedupMaxPairsPerRun": 200,
  "dedupMaxMergesPerRun": 50,
  "pagerankIterations": 10
}
```

### Planned maintenance window, drain dedup faster

```json
{
  "dedupMaxPendingVectorsPerRun": 5000,
  "dedupMaxPairsPerRun": 5000,
  "dedupMaxMergesPerRun": 500
}
```

### Sensitive deployment, direct chats only

```json
{
  "allowedChatTypes": ["direct", "explicit"],
  "allowedChatIds": [],
  "deniedChatIds": ["sensitive-group-id"]
}
```

### Lower prompt churn

```json
{
  "autoRecallMode": "index",
  "recallMaxNodes": 10,
  "recallMaxDepth": 1
}
```

## Validation Checklist

Before deploying config changes:

```bash
openclaw config get plugins.entries.graph-memory
openclaw status
```

Then in a session:

```text
/gm status
gm_stats()
```

Check:

- eligibility is expected;
- recall/extraction toggles are expected;
- database path is correct;
- independent log path is writable;
- no plaintext secrets were committed.

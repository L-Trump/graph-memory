# Graph Memory Configuration

Graph Memory configuration lives under `plugins.entries.graph-memory.config` in OpenClaw. The runtime merges configured values over `DEFAULT_CONFIG` from `src/types.ts`; `openclaw.plugin.json` exposes the same defaults for UI/schema discovery. The test suite checks the most important defaults stay in sync.

## Source of truth

- Runtime defaults: `src/types.ts` `DEFAULT_CONFIG`.
- Manifest/UI defaults: `openclaw.plugin.json` `configSchema.properties.*.default`.
- Effective runtime config: OpenClaw plugin config after secret normalization and `normalizeRuntimeConfig()` coercion.

When changing a default, update both `src/types.ts` and `openclaw.plugin.json`, then run `npm test`.

## Automation controls

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Global switch for automatic hooks. Tools and commands remain registered. |
| `recallEnabled` | boolean | `true` | Enables automatic recall in `before_prompt_build`. |
| `extractionEnabled` | boolean | `true` | Enables automatic message persistence/extraction in write hooks. |
| `allowedChatTypes` | string[] | `["direct","group","channel","explicit"]` | Eligible chat types. Default preserves historical behavior. |
| `allowedChatIds` | string[] | `[]` | Optional allowlist. Non-empty means only listed conversation/chat IDs run automation. |
| `deniedChatIds` | string[] | `[]` | Denylist. Takes priority over allowlist. |
| `statusDebugEnabled` | boolean | `true` | Writes Graph Memory lines into session `pluginDebugEntries` for `/status`. |

Session-level `/gm on/off` toggles are stored separately in OpenClaw keyed plugin state when available.

## Recall resilience

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `recallTimeoutMs` | integer | `20000` | Hook latency budget for dynamic recall. It does not cancel already-running synchronous work. |
| `recallCacheTtlMs` | integer | `15000` | In-memory recall cache TTL. Set `0` to disable. Cache key includes session, `autoRecallMode`, history query, and prompt query. |
| `recallCircuitBreakerMaxTimeouts` | integer | `3` | Consecutive timeouts before recall temporarily skips. |
| `recallCircuitBreakerCooldownMs` | integer | `60000` | Cooldown before retrying a timed-out session. |

## Recall and injection

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `autoRecallMode` | `full`/`index` | `full` | `full` injects dynamic context via `prependContext`; `index` writes a short index into the user message. |
| `recallMaxNodes` | integer | `15` | Approximate total recalled nodes assigned across L1/L2/L3. |
| `recallMaxDepth` | integer | `2` | Graph walk depth from recall seeds. Higher values can increase latency and token load. |
| `compactActiveNodesEnabled` | boolean | `false` | After compaction, inject selected current-session active nodes into stable context. |
| `compactActiveNodesMax` | integer | `100` | Max compact-active nodes to preserve when enabled. |

## Storage and models

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `dbPath` | string | `~/.openclaw/graph-memory.db` | SQLite graph database path. |
| `embedding` | object | unset | Enables vector search. Without it, recall falls back to FTS5. |
| `llm` | object | unset | Optional LLM override for extraction/induction. Otherwise uses OpenClaw provider/model. |

## Extraction and maintenance

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `extractionRecentTurns` | integer | `3` | Recent user-turn window passed to extraction. |
| `compactTurnCount` | integer | `6` | Periodic induction/maintenance cadence in agent turns. |
| `dedupThreshold` | number | `0.9` | Vector dedup cosine similarity threshold. |
| `pagerankDamping` | number | `0.85` | Global PageRank damping factor. |
| `pagerankIterations` | integer | `20` | PageRank iteration count. |
| `retention.enabled` | boolean | `true` | Enables inactive-session cleanup for `gm_messages` and `gm_recalled`. |
| `retention.retentionDays` | integer | `30` | Retention window for inactive session raw rows. |
| `retention.maxDeletePerRun` | integer | `20000` | Per-run cleanup cap. |
| `retention.vacuum` | boolean | `false` | Whether to run SQLite `VACUUM` after cleanup. |

## Decay

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `decayEnabled` | boolean | `true` | Enables access-based decay scoring. |
| `decay.*` | object | see manifest | Overrides recency/frequency/intrinsic weights and type floors. |

Decay changes ranking, not persistence. It lowers stale or low-confidence nodes without deleting them.

## Logging and diagnostics

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `debugContextPreview` | boolean | `false` | Logs stable/dynamic context previews. Use carefully; can be verbose. |
| `independentLogFile.enabled` | boolean | `true` | Writes routine info/debug logs to a plugin-owned file. |
| `independentLogFile.file` | string | daily `/tmp/openclaw/graph-memory-YYYY-MM-DD.log` | Optional explicit path. |
| `independentLogFile.maxFileBytes` | integer | `104857600` | Rotates to `.1` through `.5` when exceeded. |

Environment debug flags currently include `GM_DEBUG_CONTEXT_PREVIEW`, `GM_DEBUG_RUNTIME_HOOKS`, and `GM_DEBUG_RECALL_TIMING`.

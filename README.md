# graph-memory

<p align="center">
  <strong>Knowledge Graph Context Engine for OpenClaw</strong>
</p>

---

## What it does

When conversations grow long, agents lose track of what happened. graph-memory solves three problems at once:

1. **Context explosion** — graph-memory compresses long conversations by replacing raw history with structured knowledge graph nodes
2. **Cross-session amnesia** — Yesterday's bugs, solved problems, all recalled automatically via semantic + graph search
3. **Skill islands** — Isolated learnings get connected: "installed libgl1" and "ImportError: libGL.so.1" linked by a `解决` edge

**It feels like talking to an agent that learns from experience. Because it does.**

## Architecture

```
Message in
  └─ ingest(): save to gm_messages (synchronous, zero LLM)

before_prompt_build hook
  ├─ Input-layer noise filter: skip denial/meta-question/boilerplate messages
  ├─ recallV2(): dual-path recall → tiered nodes
  ├─ saveRecalledNodes(): cache recalled nodes to gm_recalled
  └─ assembleContext(): render KG XML → inject via appendSystemContext

afterTurn hook (async, non-blocking)
  ├─ Input-layer noise filter
  ├─ extract(): LLM extract triples → gm_nodes + gm_edges
  ├─ recordBeliefSignal() + updateNodeBelief(): process beliefUpdates
  ├─ syncEmbed(): async embedding write (non-blocking)
  └─ Periodic (every N turns): topic induction + maintenance

session_end hook
  ├─ finalize(): EVENT → SKILL promotion, 补充遗漏关系, 标记失效节点
  ├─ topic induction
  ├─ runMaintenance(): dedup → PageRank → community detection
  └─ recordBeliefSignal(): session task_completed for all session nodes
```

### ContextEngine interface

Implements OpenClaw's `ContextEngine` interface:

| Method | Description |
|--------|-------------|
| `bootstrap` | Lightweight session init |
| `ingest` | Save messages to gm_messages (sync, zero LLM) |
| `assemble` | Pass-through (KG rendering moved to before_prompt_build) |
| `compact` | Backup extraction path with noise filter + beliefUpdates processing |
| `afterTurn` | Main extraction path (async) |
| `prepareSubagentSpawn` | Share recalled context with subagent |
| `onSubagentEnded` | Cleanup subagent session data |
| `dispose` | Clear session state |

### Hooks

| Hook | When | Purpose |
|------|-------|---------|
| `before_prompt_build` | Before each LLM call | Recall + render KG XML → system prompt |
| `session_end` | Session terminates | Finalize + topic induction + maintenance + belief updates (weight=0.3) |

## Features

### Noise filter (dual-layer)

**Input-layer** (`src/extractor/noise-filter.ts`): Filters messages before LLM extraction
- Agent denial patterns ("I don't have any information")
- Meta-question patterns ("do you remember")
- Strict boilerplate (greetings, HEARTBEAT)
- Short boilerplate (≤10 chars)

**Output-layer** (`src/extractor/extract.ts`): Filters LLM extraction results before DB write
- Duplicate name deduplication
- Hallucination placeholders (content of X, pure punctuation)
- Content similarity deduplication (>65% token overlap)

### Node types

| Type | Meaning |
|------|---------|
| `TASK` | User-requested task with goal, steps, result |
| `SKILL` | Reusable skill with trigger, steps, pitfalls |
| `EVENT` | One-time error with symptom, cause, fix |
| `KNOWLEDGE` | Domain knowledge with scope + caveats |
| `STATUS` | Time-sensitive snapshot (never merged, always new with timestamp) |

### Confidence (置信度) system

Each node has a `belief` score ∈ [0, 1]:
- `1.00` = fully trusted (multiple verifications)
- `0.7~0.99` = trusted, apply directly
- `0.4~0.69` = reference, verify with caution
- `0.00~0.39` = low credibility, must verify before applying

**Signal sources:**
- **Extract LLM**: `beliefUpdates` in extract results (supported/contradicted)
- **Session end**: `task_completed` signal for all session nodes (weight=0.3)
- **gm_record tool**: does not process beliefUpdates (skipped intentionally)

### Tiered recall (assemble injection priority)

| Tier | Priority | Output |
|------|----------|--------|
| `scope_hot` | 1 (highest) | Full content — scope 下永久加载，永远可见 |
| `hot` | 2 | Full content — 每个 session 必定注入 |
| `active` | 3 | Full content — 本轮对话新产生，compact 后需参考上下文 |
| `L1` | 4 | Full content (Top 0~15 by combined score) |
| `L2` | 5 | description only (Top 15~30) |
| `L3` | 6 | name only (Top 30~45) |
| `filtered` | 7 | excluded |

### Dual-path recall

```
Query
  │
  └─ Precise path (generalized path disabled)
       vector/FTS5 search → seed nodes
       → community peer expansion
       → graph walk (N hops)
       → Personalized PageRank ranking
       → Keyword-boosted semantic scoring
```

### Combined scoring

Three-dimension scoring with min-max normalization:

```
combinedScore = semantic_weight × norm_semantic
              + ppr_weight × norm_ppr
              + pagerank_weight × norm_pagerank
```

**Keyword hybrid recall**: Semantic score is boosted by keyword overlap:
```
hybridSemantic = vectorSim × (1 + keywordScore × KEYWORD_WEIGHT)
```
Where `keywordScore` = log-TF weighted overlap between query keywords and node text (name + description + content[0:200]).

Default weights: α=0.5 (semantic), β=0.3 (PPR), γ=0.2 (PageRank), KEYWORD_WEIGHT=0.4.

### Topic induction

Periodic topic induction runs via `compactTurnCount` and at `session_end`. It:
1. Takes session nodes as `sessionNodes`
2. Cross-session recall to find related nodes
3. Forms a local subgraph
4. LLM induces `TOPIC` nodes with:
   - `semantic → TOPIC` edges (node belongs to topic)
   - `TOPIC ↔ TOPIC` edges (topic relationships)

`gm_induce_topics(name)` can also be called manually.

### Edge types

Edges are free-form — the LLM generates the `name` freely (e.g., "使用", "解决", "依赖", "扩展", "冲突"). Each edge has a `description` (one-sentence relationship description).

## Agent tools (17 total)

| Tool | Description |
|------|-------------|
| `gm_search(query)` | Semantic search for relevant nodes |
| `gm_record(content, flags?)` | Manually record knowledge (no beliefUpdates); `flags=["hot"]` marks as hot |
| `gm_stats()` | Graph stats: nodes, edges, communities, PageRank top, belief stats |
| `gm_get_hots()` | Get all hot nodes |
| `gm_maintain()` | Manual trigger: dedup → PageRank → community detection |
| `gm_embedding(name, force?)` | Recompute embedding for one node |
| `gm_reembedding_all(confirm, force?)` | Recompute all embeddings; requires `confirm=true` |
| `gm_remove(name, reason?)` | Soft-delete node (marks deprecated) |
| `gm_induce_topics(name)` | Topic induction centered on a node |
| `gm_get_node(name)` | Full node info: description, content, belief, flags, edges |
| `gm_edit_node(name, description?, content?)` | Edit node; auto re-embeds |
| `gm_set_hot(name)` | Add "hot" flag (append mode) |
| `gm_set_scope_hot(name, scope)` | Add "scope_hot:scope" flag (append mode) |
| `gm_get_flags(name)` | Get all flags for a node |
| `gm_set_flags(name, flags)` | Set (replace) flags |
| `gm_set_scope(scopes)` | Bind scopes to current session |
| `gm_get_scope()` | Get scopes bound to current session |
| `gm_list_scopes()` | List all scopes with session counts |

### Scope hot

Scopes bind context to sessions. Set scopes via `gm_set_scope`. Nodes with matching `scope_hot:scope` flags render before regular `hot` nodes in assemble.

## Installation

### Prerequisites

- OpenClaw (v2026.3.x+)
- Node.js 22+

### Step 1: Install plugin

```bash
pnpm openclaw plugins install graph-memory
```

### Step 2: Activate context engine (critical)

Edit `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "slots": { "contextEngine": "graph-memory" },
    "entries": {
      "graph-memory": {
        "enabled": true,
        "config": {
          "llm": {
            "apiKey": "your-key",
            "baseURL": "https://api.openai.com/v1",
            "model": "gpt-4o-mini"
          },
          "embedding": {
            "apiKey": "your-key",
            "baseURL": "https://api.openai.com/v1",
            "model": "text-embedding-3-small",
            "dimensions": 512
          }
        }
      }
    }
  }
}
```

### Step 3: Restart and verify

```bash
pnpm openclaw gateway --verbose
# Should see:
# [graph-memory] ready | db=~/.openclaw/graph-memory.db | provider=... | model=...
# [graph-memory] vector search ready
```

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `dbPath` | `~/.openclaw/graph-memory.db` | SQLite database path |
| `compactTurnCount` | `6` | Turns between maintenance + topic induction cycles |
| `recallMaxNodes` | `45` | Max nodes injected per recall |
| `recallMaxDepth` | `2` | Graph traversal hops |
| `freshTailCount` | `10` | Fresh tail nodes always included in assemble |
| `dedupThreshold` | `0.90` | Cosine similarity for dedup |
| `pagerankDamping` | `0.85` | PPR damping factor |
| `pagerankIterations` | `20` | PPR iteration count |
| `extractionRecentTurns` | `3` | Recent session turns injected into extract prompt |

### Supported embedding providers

| Provider | baseURL | Model |
|----------|---------|-------|
| OpenAI | `https://api.openai.com/v1` | `text-embedding-3-small` |
| DashScope | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `text-embedding-v4` |
| MiniMax | `https://api.minimax.chat/v1` | `embo-01` |
| Ollama | `http://localhost:11434/v1` | `nomic-embed-text` |

## Development

```bash
git clone https://github.com/adoresever/graph-memory.git
cd graph-memory
npm install
npx vitest run   # all tests pass
```

### Project structure

```
graph-memory/
├── index.ts                     # Plugin entry point + all hooks + 17 tools
├── src/
│   ├── types.ts                 # Type definitions + GmConfig
│   ├── db.ts                    # DB singleton + migrations
│   ├── store.ts                 # SQLite CRUD (nodes/edges/messages/vectors)
│   ├── engine/
│   │   ├── llm.ts              # LLM (fetch-based, SDK-free)
│   │   ├── embed.ts             # Embedding (fetch-based)
│   │   └── induction.ts         # Topic induction engine
│   ├── extractor/
│   │   ├── extract.ts          # Knowledge extraction + beliefUpdates + output-layer noise filter
│   │   └── noise-filter.ts     # Input-layer noise filter (denial/meta/boilerplate)
│   ├── format/
│   │   └── assemble.ts         # Context assembly + KG XML rendering + system prompt
│   ├── recaller/
│   │   ├── recall.ts           # Recall (precise only) + combined scoring + keyword hybrid
│   │   └── score.ts            # Combined scoring functions
│   └── graph/
│       ├── pagerank.ts          # Personalized PageRank + global PageRank
│       ├── community.ts         # Community detection + summaries
│       ├── dedup.ts            # Vector-based dedup
│       └── maintenance.ts       # Orchestrates dedup → PR → community
└── test/                       # vitest tests
```

## Database

SQLite WAL mode at `~/.openclaw/graph-memory.db`.

| Table | Purpose |
|-------|---------|
| `gm_nodes` | Knowledge nodes with confidence, pagerank, community_id, flags |
| `gm_edges` | Typed relationships |
| `gm_messages` | Raw conversation messages |
| `gm_signals` | Signal records (tool_error, skill_invoked, etc.) |
| `gm_vectors` | Embedding vectors |
| `gm_communities` | Community summaries + embeddings |
| `gm_scopes` | Session ↔ scope bindings |
| `gm_recalled` | Per-session recalled node cache |
| `gm_belief_signals` | Belief evidence records (verdict, weight, reason) |
| `gm_recall_feedback` | Recall feedback signals |
| `_migrations` | Migration tracker |

### gm_nodes flags

Flags stored as JSON array strings:
- `"hot"` — always rendered at assemble
- `"scope_hot:xxx"` — rendered when session has scope `xxx` bound
- Any custom string

## License

MIT

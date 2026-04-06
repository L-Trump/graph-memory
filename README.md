# graph-memory

<p align="center">
  <strong>Knowledge Graph Context Engine for OpenClaw</strong>
</p>

---

## What it does

When conversations grow long, agents lose track of what happened. graph-memory solves three problems at once:

1. **Context explosion** — graph-memory compresses long conversations by replacing raw history with structured knowledge graph nodes (~75% token reduction)
2. **Cross-session amnesia** — Yesterday's bugs, solved problems, all recalled automatically via semantic + graph search
3. **Skill islands** — Isolated learnings get connected: "installed libgl1" and "ImportError: libGL.so.1" linked by a `SOLVED_BY` edge

**It feels like talking to an agent that learns from experience. Because it does.**

## Architecture

```
Message in → ingest (zero LLM)
  └─ All messages saved to gm_messages

assemble (zero LLM)
  ├─ Dual-path recall: semantic + community → PPR ranking
  ├─ Graph nodes → XML with community grouping
  ├─ Episodic traces for top nodes
  └─ scope_hot > hot > active > L1 > L2 > L3 tiered injection

afterTurn (async, non-blocking)
  ├─ LLM extracts triples → gm_nodes + gm_edges
  ├─ LLM updates belief for existing nodes (beliefUpdates)
  ├─ Every N turns: PageRank + community detection + summaries
  └─ Every N turns: periodic topic induction

session_end
  ├─ finalize: EVENT → SKILL promotion
  ├─ belief: session task_completed signals
  └─ maintenance: dedup → PageRank → community detection
```

### Node types

| Type | Meaning |
|------|---------|
| `TASK` | User-requested task with goal, steps, result |
| `SKILL` | Reusable skill with trigger, steps, pitfalls |
| `EVENT` | One-time error with symptom, cause, fix |
| `KNOWLEDGE` | Domain knowledge with scope + caveats |
| `STATUS` | Time-sensitive snapshot (never merged, always new) |

### Edge types

Edges are free-form — the LLM generates the `name` freely (e.g., "使用", "解决", "依赖", "扩展", "冲突"). Each edge has a `description` (one-sentence relationship description).

### Tiered recall (assemble injection priority)

| Tier | Priority | Output |
|------|----------|--------|
| `scope_hot` | 1 (highest) | Full content, grouped by scope |
| `hot` | 2 | Full content |
| `active` | 3 | Full content |
| `L1` | 4 | Full content (Top 0~15 by PPR) |
| `L2` | 5 | description only (Top 15~30) |
| `L3` | 6 | name only (Top 30~45) |
| `filtered` | 7 | excluded |

### Dual-path recall

```
Query
  │
  ├─ Precise path (entity-level)
  │    vector/FTS5 search → seed nodes
  │    → community peer expansion
  │    → graph walk (N hops)
  │    → Personalized PageRank ranking
  │
  ├─ Generalized path (community-level)
  │    query vs community summary embeddings
  │    → matched community members
  │    → graph walk (1 hop)
  │    → Personalized PageRank ranking
  │
  └─ Merge & deduplicate → final context
```

### Belief (credibility) system

Each node has a `belief` score ∈ [0, 1]:
- `0.5` = neutral prior (no evidence yet)
- `> 0.5` = supported by usage signals
- `< 0.5` = contradicted by failures

The extract LLM can return `beliefUpdates` when the current conversation provides evidence for or against existing nodes:

```json
"beliefUpdates": [{
  "nodeName": "nixos-system-config-modification-rules",
  "verdict": "supported",    // or "contradicted"
  "weight": 1.0,             // evidence strength
  "reason": "用户确认了修改方法有效"
}]
```

Signals are recorded in `gm_belief_signals` and the node's `belief` score is updated via Bayesian inference. Track `success_count` and `failure_count` per node to understand the evidence base.

### Topic induction

Periodic topic induction runs every N turns (via `compactTurnCount`). It:
1. Takes session nodes as `sessionNodes`
2. Cross-session recall to find related nodes
3. Forms a local subgraph
4. LLM induces `TOPIC` nodes describing themes, with:
   - `semantic → TOPIC` edges (node belongs to topic)
   - `TOPIC ↔ TOPIC` edges (topic relationships)

`gm_induce_topics(name)` can also be called manually at any time.

## Agent tools (17 total)

| Tool | Description |
|------|-------------|
| `gm_search(query)` | Semantic search for relevant nodes |
| `gm_record(content, flags?)` | Manually record knowledge; `flags=["hot"]` marks as hot |
| `gm_stats()` | Graph stats: nodes, edges, communities, PageRank top |
| `gm_get_hots()` | Get all hot nodes (always rendered at assemble) |
| `gm_maintain()` | Manual trigger: dedup → PageRank → community detection |
| `gm_embedding(name, force?)` | Recompute embedding for one node; `force=true` skips hash check |
| `gm_reembedding_all(confirm, force?)` | Recompute all embeddings; requires `confirm=true` |
| `gm_remove(name, reason?)` | Soft-delete node (marks deprecated) |
| `gm_induce_topics(name)` | Topic induction centered on a node |
| `gm_get_node(name)` | Full node info: description, content, belief, flags, edges, signals |
| `gm_edit_node(name, description?, content?)` | Edit node; auto re-embeds |
| `gm_set_hot(name)` | Add "hot" flag (append mode, preserves other flags) |
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
├── index.ts                     # Plugin entry point
├── src/
│   ├── types.ts                 # Type definitions + GmConfig
│   ├── prompts.ts               # (deprecated, moved below)
│   ├── db.ts                    # DB singleton + migrations (m0–m9)
│   ├── belief.ts                # Belief schema migration (m10–m12)
│   ├── store.ts                 # SQLite CRUD (nodes/edges/messages/vectors)
│   ├── engine/
│   │   ├── llm.ts               # LLM (fetch-based, SDK-free)
│   │   ├── embedding.ts          # Embedding (fetch-based)
│   │   └── induction.ts          # Topic induction engine
│   ├── extractor/
│   │   └── extract.ts           # Knowledge extraction + beliefUpdates
│   ├── recaller.ts              # Dual-path recall (precise + generalized + PPR)
│   ├── formatter.ts             # Context assembly + content normalization
│   └── graph/
│       ├── pagerank.ts          # Personalized PageRank
│       ├── community.ts         # Community detection + summaries
│       ├── dedup.ts             # Vector-based dedup
│       └── maintenance.ts       # Orchestrates dedup → PR → community
└── test/                        # vitest tests
```

## Database

SQLite WAL mode at `~/.openclaw/graph-memory.db`.

| Table | Purpose |
|-------|---------|
| `gm_nodes` | Knowledge nodes with belief, pagerank, community_id, flags |
| `gm_edges` | Typed relationships |
| `gm_messages` | Raw conversation messages |
| `gm_signals` | Signal records (tool_error, skill_invoked, etc.) |
| `gm_vectors` | Embedding vectors |
| `gm_communities` | Community summaries + embeddings |
| `gm_scopes` | Session ↔ scope bindings |
| `gm_belief_signals` | Belief evidence records (verdict, weight, reason) |
| `gm_recall_feedback` | Recall feedback signals |
| `_migrations` | Migration tracker |

### Migration history

| Migration | Content |
|-----------|---------|
| m0–m9 | Core tables, messages, signals, FTS5, vectors, communities, edges flexibility, flags |
| m10 | `gm_nodes.belief`, `success_count`, `failure_count`, `last_signal_at` |
| m11 | `gm_belief_signals` table |
| m12 | `gm_recall_feedback` table |

### gm_nodes flags

Flags stored as JSON array strings:
- `"hot"` — always rendered at assemble
- `"scope_hot:xxx"` — rendered when session has scope `xxx` bound
- Any custom string

## License

MIT

# Graph Memory Agent Tools

Graph Memory tools operate on durable semantic memory. Use them when you need prior experience, reusable procedures, user preferences, or project knowledge that may not be present in the current prompt.

## Recommended recall pattern

1. `gm_search(query)` — broad semantic/keyword discovery.
2. `gm_get_node(name)` — inspect the exact node before relying on details.
3. `gm_explore(nodeName)` — inspect neighboring nodes and related edges.
4. Use the result, then optionally record corrections or reusable lessons with `gm_record`.

Do not use graph memory as proof of current file contents, running services, package versions, or config state. Verify mutable facts with live tools.

## Search and inspect

### `gm_search`

Use for questions like:

- “Have we solved this before?”
- “What was the previous workflow?”
- “Any known pitfalls around this plugin?”

Keep queries short and distinctive.

### `gm_get_node`

Use after search when you need exact content, flags, confidence, and edges for one node.

### `gm_explore`

Use when a node is relevant but the surrounding subgraph may contain the real procedure, caveat, or conflict.

## Recording memory

### `gm_record`

Use for durable facts, lessons, procedures, preferences, and conclusions. Write natural language; the extractor creates nodes/edges.

Default flags should be empty. Only set `hot` or `scope_hot:<scope>` when the user explicitly asks.

Good records:

- “When developing graph-memory, edit `~/Codes/graph-memory` only; syncing to extensions requires explicit user authorization.”
- “If recall stops in group chats, check `allowedChatTypes` and manifest/default drift.”

Bad records:

- raw secrets;
- transient tool output;
- huge logs;
- current file state that should be checked live next time.

## Editing and cleanup

- `gm_edit_node` overwrites a node's content/description/type. Inspect first.
- `gm_merge` merges duplicate nodes and deprecates the merged node.
- `gm_remove` soft-deletes a node by marking it deprecated.
- `gm_set_flags` overwrites flags; use carefully.
- `gm_set_hot` and `gm_set_scope_hot` increase injection priority and should remain rare.

## Scope and hot memory

- `hot`: injected in every session.
- `scope_hot:<scope>`: injected only when the session is bound to that scope.
- `gm_set_scope` changes the current session's scopes.
- `gm_get_scope_hots` lists nodes for a scope.

Use scope-hot for project/session-specific durable context. Use global hot only for rules that truly apply everywhere.

## Maintenance and embeddings

- `gm_maintain` runs graph maintenance such as dedup/PageRank recalculation.
- `gm_embedding` recomputes one node's embedding.
- `gm_reembedding_all` can be expensive; confirm before running with `confirm=true`.
- `gm_dream` randomly explores recent subgraphs for maintenance/insight, not ordinary Q&A.
- `gm_induce_topics` summarizes topics around a node and can create higher-level topic structure.

## Safety boundaries

- Do not persist private details into memory unless they are needed for future assistance.
- Do not store raw credentials.
- Do not mark nodes hot unless explicitly requested.
- Prefer live inspection over memory for current code/config/process state.
- When memory conflicts with current evidence, current evidence wins.

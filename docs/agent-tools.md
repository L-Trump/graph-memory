# Graph Memory Agent Tools

Graph Memory exposes 22 `gm_*` tools. They are intended for agent-operated semantic memory workflows: search first, inspect before editing, record durable lessons explicitly, and treat destructive or expensive operations carefully.

## Tool Categories

| Category | Tools |
|---|---|
| Search and inspect | `gm_search`, `gm_get_node`, `gm_explore`, `gm_stats`, `gm_get_flags` |
| Record and edit | `gm_record`, `gm_edit_node`, `gm_remove`, `gm_merge` |
| Hot/scope visibility | `gm_get_hots`, `gm_set_hot`, `gm_set_flags`, `gm_get_scope`, `gm_set_scope`, `gm_get_scope_hots`, `gm_set_scope_hot`, `gm_list_scopes` |
| Embeddings and maintenance | `gm_maintain`, `gm_embedding`, `gm_reembedding_all` |
| Higher-level review | `gm_induce_topics`, `gm_dream` |

## Operating Principles

1. **Search before solving familiar problems.** Use `gm_search` when a problem may have been solved before.
2. **Inspect exact nodes before editing.** Use `gm_get_node` to verify name, content, flags, and edges.
3. **Record durable lessons explicitly.** Use `gm_record` for reusable workflows, preferences, constraints, incidents, and solutions.
4. **Do not overuse hot flags.** Only mark hot/scope-hot when explicitly requested or clearly required by operator policy.
5. **Prefer deprecation over hard deletion.** `gm_remove` marks nodes deprecated.
6. **Confirm expensive operations.** Full re-embedding can be costly on large graphs.
7. **Verify live state directly.** Memory is historical knowledge, not proof of current files/services/config.

## Search and Inspect

### `gm_search(query)`

Use when:

- you encounter an error that may have happened before;
- the user says "之前", "那个", "继续", or references past work;
- you need reusable workflow or preference recall.

Example:

```text
gm_search("graph memory dedup performance bottleneck")
```

Good queries are specific and include domain terms, filenames, errors, or concepts.

### `gm_get_node(name)`

Use for exact inspection after search or when a node name is known.

It should reveal:

- type;
- description/content;
- confidence/belief;
- flags;
- outgoing/incoming edges;
- provenance metadata where available.

Example:

```text
gm_get_node("sqlite-wal-backup")
```

### `gm_explore(nodeName)`

Use to walk the local graph around a node: semantic neighbors plus explicit edges.

Example:

```text
gm_explore("runtime-sync-boundary")
```

### `gm_stats()`

Use for high-level graph health:

- node count;
- edge count;
- hot node count;
- PageRank top nodes;
- embedding status.

### `gm_get_flags(name)`

Use before changing flags to avoid clobbering existing visibility state.

## Record and Edit

### `gm_record(content, flags=[])`

Use for durable knowledge worth remembering beyond the current turn:

- user preferences;
- repeatable procedures;
- debugging lessons;
- project constraints;
- operational boundaries;
- incident summaries;
- decisions and rationale.

Example:

```text
gm_record("When changing Graph Memory config defaults, update src/types.ts and openclaw.plugin.json together, then run config-schema tests.")
```

Flags:

- default `[]` for ordinary memory;
- `hot` only when explicitly requested or policy requires it;
- `scope_hot:<scope>` only when the memory should always render in that scope.

### `gm_edit_node(name, type?, description?, content?)`

Use to correct a known node. Inspect first with `gm_get_node`.

### `gm_remove(name, reason?)`

Soft-deprecates a node. Use for incorrect, sensitive, or obsolete memories.

### `gm_merge(keepName, mergeName)`

Use when two nodes are duplicates. Inspect both first.

Recommended flow:

```text
gm_get_node("candidate-a")
gm_get_node("candidate-b")
gm_merge("canonical-node", "duplicate-node")
```

## Hot and Scope Visibility

### Hot Nodes

Hot nodes render in every eligible session. Keep them rare.

Tools:

```text
gm_get_hots()
gm_set_hot("node-name")
gm_set_flags("node-name", ["hot"])
```

### Scope-Hot Nodes

Scope-hot nodes render only when the session has the matching scope.

Tools:

```text
gm_set_scope(["project-x"])
gm_get_scope()
gm_set_scope_hot("node-name", "project-x")
gm_get_scope_hots("project-x")
gm_list_scopes()
```

Use scope-hot for project/group/lab-specific rules that should not leak into unrelated sessions.

## Embeddings and Maintenance

### `gm_maintain()`

Runs graph maintenance:

- retention cleanup;
- incremental dedup;
- PageRank recompute;
- related maintenance tasks.

Use after significant memory changes or as scheduled maintenance. On large graphs, inspect logs for budget and timing fields.

### `gm_embedding(name, force=false)`

Recomputes embedding for one node. Use after manual edits or when a node's vector is stale.

### `gm_reembedding_all(confirm, force=false)`

Expensive. Use only after explicit confirmation.

Flow:

```text
gm_reembedding_all(confirm=false)
# inspect count/cost
gm_reembedding_all(confirm=true, force=false)
```

## Higher-Level Review

### `gm_induce_topics(name)`

Runs topic induction around a node. Use for organizing a local knowledge area.

### `gm_dream()`

Randomly explores recent/recalled graph neighborhoods for maintenance-like review. Use for discovering merge opportunities, missing relations, or conflicts.

## Common Workflows

### Debugging a repeated issue

```text
gm_search("exact error message or subsystem")
gm_get_node("best-match-node")
gm_explore("best-match-node")
# apply solution, verify with live tools
# after fixing:
gm_record("Problem X was fixed by Y; watch out for Z.")
```

### Recording a user preference

```text
gm_record("The user prefers concise status updates after long-running tool work, including commands run and verification result.")
```

### Correcting a bad memory

```text
gm_search("bad or outdated claim")
gm_get_node("node-name")
gm_edit_node("node-name", description="corrected summary", content="corrected details")
```

Or deprecate:

```text
gm_remove("node-name", "obsolete after configuration migration")
```

### Setting project scope

```text
gm_set_scope(["graph-memory-dev"])
gm_set_scope_hot("graph-memory-sync-boundary", "graph-memory-dev")
gm_get_scope_hots("graph-memory-dev")
```

## Safety Notes

- Do not store raw secrets.
- Do not record private cross-session details unless they are needed as durable knowledge and privacy boundaries allow it.
- Do not mark ordinary memories as hot.
- Do not use memory as evidence for current file/config/service state.
- Confirm before expensive graph-wide operations.

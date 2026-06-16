# OpenClaw Integration Playbook

This playbook helps operators connect Graph Memory to an OpenClaw deployment safely.

## Integration Model

Graph Memory is a hook-only plugin. It does **not** occupy the `contextEngine` slot.

Expected placement:

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

It can run alongside a ContextEngine such as lossless-claw.

## Preflight Checks

Do not guess active paths. Check runtime state first:

```bash
openclaw status
openclaw config get plugins.entries.graph-memory
openclaw config get plugins.load.paths
openclaw config get plugins.slots.contextEngine
```

Confirm:

- plugin entry id is `graph-memory`;
- configured extension path points to the intended runtime build;
- `dbPath` is correct;
- secret references resolve in the Gateway process;
- current OpenClaw version satisfies the peer dependency.

## Source vs Runtime

Recommended workflow:

1. edit source checkout;
2. run tests/build;
3. commit source changes;
4. separately sync build to runtime extension when authorized;
5. restart Gateway only when deploying runtime changes;
6. verify `/gm status` and logs.

Do not edit a running extension directory as the primary development workflow.

## Minimal Smoke Test

After enabling or deploying:

```text
/gm status
gm_stats()
gm_search("graph memory")
```

Expected:

- `/gm status` returns global/recall/extract state;
- `gm_stats()` can read the database;
- `gm_search()` returns either matches or a clean empty result, not a tool failure.

## Eligibility Verification

Test the session where automation should run:

```text
/gm status
```

Check:

- `chatType` matches expectation;
- `eligibility=yes` when automation should run;
- allow/deny lists behave as intended;
- session toggles have not disabled recall/extraction.

## Logging Verification

If independent logging is enabled:

```bash
ls -lh /tmp/openclaw/graph-memory-*.log
tail -n 50 /tmp/openclaw/graph-memory-$(date +%F).log
```

Check that routine info/debug stays in the independent log and warnings/errors remain visible in the host log.

## Backup Before Risky Work

Before migrations, full re-embedding, bulk merge, or manual SQL recovery:

1. stop concurrent maintenance if possible;
2. back up SQLite database consistently;
3. include WAL/SHM files if not using SQLite backup API;
4. verify backup integrity before mutating production.

## Rollback Plan

For runtime deployment:

1. keep previous runtime extension copy or build artifact;
2. keep database backup if schema changed;
3. know how to restore plugin entry config;
4. restart Gateway after rollback;
5. verify `/gm status` and `gm_stats()`.

## Common Integration Mistakes

| Mistake | Result | Fix |
|---|---|---|
| Editing runtime extension directly | Hard to review/reproduce changes | Edit source checkout, build, then sync separately. |
| Wrong `dbPath` | Empty or unexpected memory graph | Inspect config and database stats. |
| Missing Gateway secret env | Embedding/LLM auth failures | Use SecretRef or ensure service process env. |
| `allowedChatTypes` too narrow | Recall skipped in groups/channels | Include expected chat types. |
| Restart skipped after runtime sync | Old code still running | Restart only when intentionally deploying. |
| WAL backup incomplete | Restore misses latest writes | Use SQLite backup API or include `-wal`/`-shm`. |

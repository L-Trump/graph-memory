# Contributing

Thanks for improving Graph Memory. This repository is an OpenClaw plugin package, so changes should keep runtime safety, privacy, and operational predictability in mind.

## Development setup

```bash
npm install
npm test
npm run build
```

The default test command runs the Vitest suite. Some real-database, real-model, or exploratory tests may require explicit environment flags or local credentials; keep normal release gates focused on deterministic tests plus `npm run build` unless your change touches those integrations.

## Change workflow

1. Create changes in the development checkout, not in a running OpenClaw extensions directory.
2. Keep source defaults and manifest defaults in sync when changing configuration:
   - `src/types.ts`
   - `openclaw.plugin.json`
   - relevant tests, especially config/schema tests
3. Add or update tests for behavior changes.
4. Run targeted tests for the touched subsystem.
5. Run `npm test` and `npm run build` before release-sensitive changes.
6. Review `git diff --check` before committing.
7. Syncing a build into a runtime extension and restarting Gateway are separate operational actions, not part of normal source edits.

## Documentation expectations

Update docs when changing user-visible behavior, configuration, tools, or operations:

- `README.md` for project entry-point changes.
- `README_CN.md` for Chinese release documentation when preparing bilingual updates.
- `docs/configuration.md` for config keys/defaults/operational impact.
- `docs/architecture.md` for hook lifecycle, data model, or recall/extraction flow changes.
- `docs/diagnostics.md` for new logs, failure modes, or troubleshooting steps.
- `docs/agent-tools.md` for `gm_*` tool behavior and recommended usage.
- `CHANGELOG.md` for release-facing changes.

## Safety and privacy checklist

Before merging a change, ask:

- Could this persist transient prompt context, raw secrets, or unnecessary private data?
- Could this expose one session's private context in another session?
- Could this make recall/extraction run in chats that should be excluded?
- Could this introduce unbounded work in a hook path or maintenance path?
- Does the operation need explicit user/admin authorization when applied to a runtime extension?

## Commit style

Use concise conventional-style subjects when possible:

- `feat: ...`
- `fix: ...`
- `perf: ...`
- `docs: ...`
- `test: ...`
- `config: ...`

Keep commits scoped. Separate source changes from runtime sync or deployment actions.

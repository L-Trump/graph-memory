# Changelog

All notable changes to Graph Memory should be documented in this file.

This project follows a lightweight changelog format inspired by [Keep a Changelog](https://keepachangelog.com/) and uses semantic versioning where practical.

## [Unreleased]

### Changed

- Reworked README and README_CN into product-grade documentation modeled after mature OpenClaw memory plugins: motivation, capability matrix, quick start, AI-safe install notes, recommended config, architecture, core features, tools, operations, troubleshooting, FAQ, glossary, and safety guidance.
- Expanded architecture, configuration, diagnostics, and agent-tool docs into operator/developer deep dives.

### Added

- Added OpenClaw integration playbook for safe runtime deployment and smoke testing.
- Added release checklist for source, tests, docs, runtime safety, and post-deployment verification.

## [3.0.0] - 2026-06-16

### Added

- Hook-only OpenClaw semantic memory plugin flow documented as the primary architecture.
- Stable and dynamic context layering with `hot`, `scope_hot`, and `L1/L2/L3` recall tiers.
- Runtime controls for global and per-session recall/extraction toggles.
- Independent Graph Memory log file support for routine plugin diagnostics.
- Retention cleanup for inactive-session raw bookkeeping rows.
- Incremental vector dedup maintenance with bounded pending-vector, pair, and merge budgets.
- Documentation pages for architecture, configuration, diagnostics, and agent tools.

### Changed

- README expanded into a mature project entry point with installation, configuration, operations, troubleshooting, FAQ, glossary, compatibility, and privacy guidance.
- `dedupMaxPendingVectorsPerRun` default raised to `2000` for faster backlog drain in large graphs.
- Maintenance logs now expose structured key/value timing and dedup metrics.

### Operational notes

- `gm_maintain()` now reports incremental dedup status fields such as `dedup_pending_before`, `dedup_pending_after`, `dedup_checked`, `dedup_comparisons`, `dedup_pairs`, and `dedup_merged`.
- Retention cleanup affects old raw `gm_messages` / `gm_recalled` rows for inactive sessions; it is not a semantic node/edge deletion policy.
- Runtime sync and Gateway restart remain separate operational actions outside normal source changes.

## Earlier versions

Historical `1.x` and `2.x` changes predate this changelog. Consult git history and release tags for details.

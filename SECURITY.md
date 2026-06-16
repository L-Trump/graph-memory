# Security Policy

Graph Memory stores durable semantic memory. Security and privacy reports are important because the plugin may persist user preferences, project knowledge, workflow details, and limited raw bookkeeping rows.

## Supported versions

The active supported line is the current `3.x` series. Older `1.x` and `2.x` versions are best-effort unless a maintainer explicitly backports a fix.

## Reporting a vulnerability

Please report security issues privately first. If GitHub security advisories are enabled for the repository, use that channel. Otherwise, contact the maintainer listed in `LICENSE` or open a minimal public issue that does not include secrets, exploit details, private transcripts, database dumps, or API keys.

Include, when safe:

- affected version or commit;
- deployment/runtime environment;
- configuration relevant to the issue;
- minimal reproduction steps;
- expected vs actual behavior;
- whether sensitive data may have been persisted or exposed.

## Sensitive data guidance

Do not include any of the following in public reports:

- raw Graph Memory databases;
- transcript excerpts containing private information;
- OpenClaw config files with plaintext secrets;
- provider API keys or SecretRef backing material;
- logs that contain private chat IDs, account IDs, tokens, or prompt content.

If a database or log is required for diagnosis, create a sanitized minimal reproduction instead.

## Security expectations for changes

Changes should preserve these properties:

- automation can be disabled globally and per session;
- chat allow/deny lists are enforced before recall/extraction automation;
- transient injected context and secrets are not intentionally persisted as durable memories;
- runtime hooks and maintenance paths remain bounded by time, count, cache, circuit-breaker, or config limits;
- destructive or deployment operations are kept separate from source edits.

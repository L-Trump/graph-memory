# Release Checklist

Use this checklist before tagging or deploying a Graph Memory release.

## Source Checks

- [ ] `git status` is clean except intentional release changes.
- [ ] Config defaults are synchronized:
  - [ ] `src/types.ts`
  - [ ] `openclaw.plugin.json`
  - [ ] `docs/configuration.md`
- [ ] New user-visible behavior is documented.
- [ ] New config has schema, UI hints, defaults, and tests.
- [ ] New tools or changed tool semantics are reflected in `docs/agent-tools.md`.

## Test Gate

```bash
npm test
npm run build
git diff --check
```

- [ ] Targeted tests pass.
- [ ] Full deterministic tests pass.
- [ ] Build succeeds and updates `dist/index.js` when expected.
- [ ] Known non-fatal test stderr is understood and documented if still present.

## Documentation Gate

- [ ] `README.md` reflects the release.
- [ ] `README_CN.md` is synchronized or clearly marked as lagging.
- [ ] `CHANGELOG.md` has a release entry.
- [ ] Architecture/config/diagnostics docs are updated.
- [ ] Local markdown links and anchors are valid.

Suggested link check script:

```bash
python3 - <<'PY'
from pathlib import Path
import re
for p in [Path('README.md'), Path('README_CN.md'), *Path('docs').glob('*.md')]:
    s = p.read_text()
    missing = []
    for m in re.finditer(r'!\\[[^\\]]*\\]\\(([^)]+)\\)|\\[[^\\]]+\\]\\(([^)]+)\\)', s):
        target = (m.group(1) or m.group(2)).split('#', 1)[0]
        if not target or target.startswith(('http://', 'https://', 'mailto:')):
            continue
        if not (p.parent / target).resolve().exists() and not Path(target).exists():
            missing.append(target)
    if missing:
        print(p, missing)
        raise SystemExit(1)
print('markdown local links ok')
PY
```

## Database/Runtime Safety

- [ ] Schema migrations are backward/forward considered.
- [ ] Large maintenance cost is budgeted.
- [ ] Retention behavior is documented.
- [ ] Backup/rollback instructions are clear.
- [ ] Runtime sync is treated as a separate authorized deployment step.

## Deployment Smoke Test

After runtime sync and Gateway restart:

```text
/gm status
gm_stats()
gm_search("graph memory")
```

- [ ] `/gm status` works.
- [ ] Eligibility is expected in target session(s).
- [ ] Independent log is writable.
- [ ] No host warnings/errors from Graph Memory startup.
- [ ] Recall and extraction behavior match the release notes.

## Post-Release

- [ ] Tag or record release commit.
- [ ] Update tracker/issue status if used.
- [ ] Record operational lessons in Graph Memory if reusable.

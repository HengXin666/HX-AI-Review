# Contributing

## Setup

Use Node 22.19 or newer and the pnpm version pinned in `package.json` (`packageManager`). Install from the committed lockfile:

```sh
pnpm install --frozen-lockfile
```

## Local checks

Run after the change is complete, not while editing:

```sh
pnpm format        # prettier, 4 spaces, width 120
pnpm typecheck     # tsc strict for context-cr, cf-admin worker and pages
pnpm test          # node --test in both packages
pnpm l0            # hx-context-review L0 on this repository's own context files
pnpm quality:code  # hx-agent-code code group, report in scripts/.hx_code_quality/reports/
pnpm quality:docs  # hx-agent-code docs group
```

Use `pnpm --filter context-cr test` or `pnpm --filter cf-admin test` for one package.

## Git and CI

Push CI runs the code, docs and build groups on the exact diff and selects affected tests; PR CI runs the full test suite. Errors block, warnings need review, a missing tool or environment is a failure, never a pass.

## Decisions and exceptions

- Record architecture choices under `docs/decisions/YYYY-MM-DD-<slug>.md` and update `docs/architecture/` in place.
- New dependencies need review; list them in the PR and in `docs/reference/quality/inventory.md`.
- Never edit `scripts/quality/baseline.json` or a caller's context baseline just to make a check pass.
- Keep the HTTP contract `docs/reference/api/cf-admin.yaml` in the same PR as Worker route changes.

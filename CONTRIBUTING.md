# How to contribute

Thanks for deciding to help! efmesh is a young project, the rules are simple.

## Environment

You only need [Bun](https://bun.sh) ≥ 1.3 (runtime, tests, package manager):

```sh
bun install     # dependencies
bun test        # all tests (~4 s)
bun run check   # tsc --noEmit
```

Postgres tests spin up a throwaway cluster via `initdb` in tmp and are
skipped automatically if the Postgres binaries are not on the PATH —
for a full run install `postgresql` locally.

### Git hooks

`bun install` wires [lefthook](https://lefthook.dev) git hooks through the
`prepare` script (run `bunx lefthook install` by hand if you skipped
scripts). They keep the checks fast and local:

- **pre-commit** — `tsc --noEmit`, biome on the staged files, and a
  Cyrillic gate (`scripts/no-cyrillic.ts`: `src/` and `test/` are
  English-only; a deliberate non-ASCII test fixture opts out with a
  `cyrillic-ok` marker on or just above the line).
- **pre-push** — the full `bun test`.

The hooks skip when `$CI` is set (CI runs the same checks) and can be
disabled ad hoc with `LEFTHOOK=0 git commit …`.

## Repository layout

```
SPEC.md            — architecture spec: read before a large change
src/core/          — models, DAG, SQL fragments, interval arithmetic
src/engine/        — engine adapters (DuckDB, Postgres)
src/state/         — state store (bun:sqlite, Postgres)
src/plan/          — fingerprint, planner, executor, audits, janitor, lock
src/cli.ts         — CLI (a thin wrapper over the library)
src/testing/       — testModel for model unit tests
test/              — bun test; one file per area
examples/hospital/ — live example, dogfooded here
```

## Code principles

- **Effect everywhere.** Errors are typed (`Data.TaggedError`), no
  `throw` in business logic; resources are `Layer`/`Scope`; data shape is
  `Schema`. The target version is Effect v4 (beta): we stick to the stable
  subset of the API.
- **SPEC.md is the source of truth.** Behavioral changes are first
  reflected in the spec (or discussed in an issue), then in the code. What
  is implemented is marked in the spec with notes "*Implemented in Fn: …*".
- **A test for every behavior.** A change without a test that failed before
  it is a reason to ask what exactly it fixes.
- **Dogfood.** After a notable change, run the live cycle on the example:
  `cd examples/hospital && bun ../../src/bin.ts apply dev --yes && bun ../../src/bin.ts run dev`.

## Agent skills

Recurring, mistake-prone procedures are captured as in-repo agent skills under
[`.claude/skills/`](./.claude/skills/) (one `SKILL.md` per skill: `release`,
`store-migration`, `fingerprint-change`, `add-model-kind`, `issue-workflow`).
Each is a short checklist of the exact commands and the invariants for that
task. Claude Code loads them by name; humans can read them as runbooks. If you
change how one of these procedures works, update its skill in the same PR.

## Commits and PRs

- Atomic commits in the [Conventional Commits](https://www.conventionalcommits.org/) style:
  `feat(plan): …`, `fix(state): …`, `docs(spec): …` — one finished change
  per commit.
- In the commit body write the "why", not the "what" (which is visible from
  the diff). Document any gotchas you found — they save the next person hours.
- Before a PR: `bun run check && bun test` green. Check exit codes
  honestly — a pipe into `tail` swallows the exit code.

## License

By submitting a PR, you agree that your contribution is licensed under the
project's [MIT](./LICENSE).

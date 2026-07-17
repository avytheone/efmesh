# CLAUDE.md — repository culture

Working agreements for this repository. They apply equally to humans and AI
agents — we expect most development *and* operation of efmesh to happen
through AI agents, and this file is the contract they work under.

## What this is

efmesh is a data-transformation framework in the spirit of sqlmesh, built on
TypeScript + Bun + Effect v4, for **small data lakes** (DuckDB-class data:
gigabytes to a terabyte on one machine). Models are TypeScript modules;
versions are snapshots keyed by fingerprints of canonical SQL ASTs;
environments are virtual views over shared physical storage; a plan is the
diff between the project and an environment.

Where things are decided:

- `SPEC.md` — the architecture contract. §13 is the build history (phases),
  §14 holds open questions with their current verdicts. Substantive design
  decisions land here, not in chat history.
- GitHub Issues + milestones — operational planning. One issue = one
  shippable concern; commits close them with `closes #N`.
- `CHANGELOG.md` — Keep a Changelog, SemVer. User-visible changes only.
- `README.md` — the shopwindow; `README.ru.md` is its maintained Russian
  mirror. Keep them in sync when touching either.

## Language

All project documentation, source comments, commit messages, issues and
user-facing output are **English**. `README.ru.md` is the only maintained
Russian artifact. (Historical commits and comments predating this rule are
being migrated — do not add new Russian text.)

## Code style

- **Effect everywhere.** Effect v4, pinned to an exact beta as a
  peerDependency — never bump the pin casually; a weekly drift CI exists for
  that. Shapes are `Schema`, wiring is `Layer`, services are
  `Context.Service`. No bare `throw` in `src/` — errors are
  `Data.TaggedError` with fields that name the culprit (model, env, file,
  interval) and carry an actionable message.
- Comments state constraints and the *why* — the thing the code cannot say —
  never narrate the next line or justify a change to a reviewer. Match the
  density and tone of the surrounding file.
- The public API is a **whitelist** in `src/index.ts` (no `export *`).
  Adding an export is an API event: deliberate, documented.
- Effect-idiomatic retries/concurrency: the choice of a failure branch must
  live *inside* `Effect.suspend` — a ternary evaluated at call time breaks
  retries (learned the hard way).

## Contracts — things you do not change casually

These are frozen by tests and versioned; breaking them silently is the worst
class of bug this project can have:

- **`FINGERPRINT_VERSION`** (`src/plan/fingerprint.ts`) — the fingerprint
  algorithm. Golden tests (`test/fingerprint-golden.test.ts`) freeze the
  engine canonicalization. A red golden test means canon drift (engine
  upgrade, payload change): do **not** update the hashes; understand the
  drift, bump the version consciously, provide a migration story, and only
  then freeze new values.
- **`STATE_VERSION`** (`src/state/store.ts`) — the store schema. Any schema
  change bumps it and ships a migration in both SQLite and Postgres stores
  (`efmesh migrate`, with a file backup for SQLite). A fresh store
  bootstraps; an old one refuses to open until migrated.
- **`--json` shapes and exit codes** (0 = ok, 1 = error, 2 = awaiting a
  human) — a contract for CI and agents; changes are SemVer events.
- **Locks**: `apply` and `run` of an environment share one cross-process
  lock; janitor has its own. Stale-lock reclaim is ttl-based and tested
  under a real `kill -9` — keep it that way.

## Testing & verification

- `bun test` (all of it) and `bunx tsc --noEmit` must be green before any
  commit. Do not pipe test output through `tail` inside `&&` chains — the
  pipe swallows the exit code.
- Git hooks (lefthook, `lefthook.yml`) are the mechanical source of truth
  for "what green means" and install themselves via the `prepare` script on
  `bun install` (or `bunx lefthook install`). **pre-commit** runs
  `tsc --noEmit`, biome on the staged files, and the Cyrillic gate
  (`scripts/no-cyrillic.ts`: src/ and test/ are English-only, opt out a
  deliberate non-ASCII fixture with a `cyrillic-ok` marker on or above the
  line). **pre-push** runs the full `bun test`. Hooks skip when `$CI` is set
  (CI runs the same checks) and honour `LEFTHOOK=0`. The hooks are a
  backstop, not a substitute for judgement — the constraints below and the
  contract sections above are yours to uphold; hooks cannot.
- Tests that spawn subprocesses or import `effect` from temp dirs must
  create those dirs **inside the repo** (module resolution).
- DuckDB holds a single connection: model-level concurrency is 1 on DuckDB
  by design (statements would interleave into foreign transactions); don't
  "fix" that with a semaphore.
- Dogfood lives in `examples/hospital` (a systemd user timer runs `run`
  hourly); `bench/plan-bench.ts` measures plan/apply at 100/500/2000 models.

## Commits & releases

- Atomic commits: one logical change, message explains the *why*, references
  the issue (`closes #N`). Conventional prefixes: `feat(scope):`,
  `fix:`, `docs:`, `test:`, `perf:`, `release:`.
- Releases: bump `package.json`, move CHANGELOG Unreleased under the
  version, tag `vX.Y.Z`, push the tag — GitHub Actions publishes to npm via
  Trusted Publishing (OIDC, provenance). Hyphenated versions go to the
  `beta` dist-tag, clean versions to `latest`. Never `gh release create` on
  a nonexistent tag (it silently tags HEAD).

## Operating efmesh (for agents running it)

- Prefer `--json` on `plan`/`audit`/`status`/`diff` — stable shapes.
- Exit code 2 is not a failure: it means "changes await a human" (apply
  needs `--yes` in non-TTY, or `run` hit structural changes).
- `run` only advances existing versions; structural changes go through
  `plan`/`apply`. The tick journal (`efmesh status`) records every tick's
  outcome, including unsuccessful ones.
- Never edit the state store by hand; `efmesh migrate` and the CLI are the
  only writers.

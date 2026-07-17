---
name: issue-workflow
description: Land a change against a GitHub issue the efmesh way — atomic commit closing the issue, CHANGELOG for user-visible changes, README/README.ru.md kept in sync, green gates. Use when implementing an issue or any change destined for a commit in this repo.
---

# Issue → commit workflow

One issue = one shippable concern. A commit closes it. Keep the history atomic
and the docs honest.

## Checklist

1. **Scope to the issue.** One logical change per commit. If the work splits into
   independent concerns, that is several commits (only the last carries
   `closes #N`, or split across issues).
2. **A test for the behavior.** A change without a test that failed before it
   invites the question "what does this fix?" Add/extend a `test/*.ts` file for
   the area you touched.
3. **CHANGELOG** (`CHANGELOG.md`): if the change is user-visible, add a bullet
   under `## [Unreleased]` (Keep a Changelog style, English, explains the *why*).
   Internal-only refactors need no entry.
4. **README sync**: if you touch `README.md`, mirror the same change into
   `README.ru.md` (the maintained Russian mirror) — and vice versa. They must
   not drift.
5. **SPEC**: behavioral/architectural changes land in `SPEC.md` first (or an
   issue discussion), then code — mark implemented items in the spec.
6. **English only** in `src/` and `test/` (the Cyrillic gate,
   `scripts/no-cyrillic.ts`, enforces it on pre-commit; opt a deliberate
   non-ASCII fixture out with a `cyrillic-ok` marker on/above the line).
7. **Green before commit:** `bun test` and `bun run check`
   (`biome check .` + `tsc --noEmit`). Do not pipe test output through `tail`
   inside `&&` — the pipe swallows the exit code.
8. **Commit** with a conventional prefix and the issue reference:
   `feat(scope): …` / `fix: …` / `docs: …` / `test: …` / `perf: …`, and
   `closes #N` in the message. The body explains the *why*, not the *what*, and
   documents gotchas for the next person.
9. **Let the hooks run.** lefthook (`lefthook.yml`) runs `tsc`, biome on staged
   files and the Cyrillic gate on **pre-commit**, and full `bun test` on
   **pre-push**. They are a backstop — do not bypass with `LEFTHOOK=0` to dodge
   a real failure; fix the failure.

## Invariants

- Respect the frozen contracts: `FINGERPRINT_VERSION`, `STATE_VERSION`, `--json`
  shapes and exit codes (0 ok / 1 error / 2 awaiting a human), and the locks.
  Touching any is a deliberate, documented, SemVer-aware event — see the
  `fingerprint-change` and `store-migration` skills.
- The public API is a whitelist in `src/index.ts` (no `export *`); adding an
  export is an API event, documented on purpose.
- Atomic commits: never fold an unrelated fix into the issue's commit.

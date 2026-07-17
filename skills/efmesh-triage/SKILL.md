---
name: efmesh-triage
description: >-
  Diagnose what an efmesh environment is doing and why a tick or apply did not
  succeed. Use when an efmesh run/cron tick reported a non-zero exit, an alert
  fired, or you are asked "what is going on with <env>" / "why is <env> behind /
  stuck / failing". Classifies awaiting-human (exit 2) vs lock-held vs a real
  error and gives the next action for each.
---

# efmesh triage

Read machine-readable state only. Never parse human text; use `--json` and exit
codes. All commands: `0` ok, `1` error, `2` awaiting a human (not a failure).

## Step 1 — read the environment state

```
efmesh status <env> --json
```

Shape (contract):

```json
{
  "env": "dev",
  "storeVersion": 5,
  "models": 3,
  "promotedAt": "2026-07-17T16:33:15.086Z",
  "lastPlan": { "id": 1, "env": "dev", "summary": "…json-string…",
                "appliedAt": "…", "appliedBy": "avy" },
  "ticks": [ { "id": 2, "env": "dev", "startedAt": "…", "finishedAt": "…",
               "outcome": "awaiting-human", "detail": "…" } ],
  "lag": [ { "model": "mart.daily_revenue", "doneUpTo": "…", "missing": 0, "failed": 0 } ]
}
```

- `models === 0` → the environment has never been applied. Not an error: the
  first `apply` creates it.
- `ticks` are freshest-first; `ticks[0].outcome` is the last tick's verdict.
- `lag[].missing` > 0 → intervals not yet caught up. `lag[].failed` > 0 → a
  stuck backfill (poisoned intervals) — hand off to the **efmesh-backfill-recovery** skill.
- `lastPlan.summary` and each `ticks[].detail` are JSON-**encoded strings**, not
  nested objects — parse them a second time if you need their internals. `detail`
  is polymorphic by `outcome` (see below); read `outcome` first, `detail` second.

## Step 2 — classify the last tick by `outcome`

`ticks[0].outcome` is exactly one of:

| outcome | meaning | maps to exit | what to do |
|---|---|---|---|
| `ok` | tick succeeded; `detail` is a JSON array of built models | 0 | nothing — healthy |
| `awaiting-human` | unapplied structural changes; `detail` is `"model: category; …"` | 2 | **not a failure.** Structural changes are pending — hand off to **efmesh-safe-apply**. `run` only advances existing versions; it will keep returning 2 until someone applies. |
| `lock-held` | another `apply`/`run` of this env holds the cross-process lock | (tick, not exit) | transient. A concurrent apply/run is in progress. Re-check after it finishes. Stale locks reclaim by ttl automatically after a `kill -9`; do **not** clear locks by hand. |
| `error` | a real failure; `detail` is the error tag | 1 | a genuine problem — Step 3. |

## Step 3 — a live command's exit code (when you ran it yourself)

If you invoked `run`/`apply`/`audit`/etc. and it exited non-zero, classify by
code, never by the message text:

- **exit 2** — awaiting a human. `apply` had changes but no `--yes` in a non-TTY,
  or `run` met unapplied structural changes. Go to **efmesh-safe-apply**. Do not
  retry blindly; re-running `run` will just re-return 2.
- **exit 1** — real error. The single failure screen names the culprit and,
  when one exists, a one-line hint (`→ run \`efmesh migrate\``, `→ add lake: …`,
  `→ wait for the other apply/run to finish`). Common cures:
  - `StateSchemaError` / `FingerprintVersionError` → **efmesh-upgrade** (run `efmesh migrate`).
  - `LockHeldError` → same as `lock-held` above: wait, do not force.
  - `LakeNotConfiguredError` / `ConfigLoadError` → a config problem, not an
    operational one; surface it to the human.
  - For the full trace, re-run the exact command with `--log-level debug`.
- **exit 0** — success.

## Guard rails

- Exit 2 and `awaiting-human` / `lock-held` ticks are **normal states**, not
  incidents. Do not page a human for them; do the documented next action.
- Never edit the state store by hand and never delete a lock file. `efmesh
  migrate` and the CLI are the only writers; stale locks reclaim on a ttl.
- Do not infer health from stdout prose. `status --json` and exit codes are the
  only contract.

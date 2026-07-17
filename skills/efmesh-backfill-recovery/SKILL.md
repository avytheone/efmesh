---
name: efmesh-backfill-recovery
description: >-
  Find and recover failed or missing backfill intervals in an efmesh
  environment. Use when `status --json` shows a model with `failed > 0` or
  `missing > 0`, when a backfill errored, or when asked to catch up / re-run /
  recover intervals for an env. Explains what `run` can and cannot fix.
---

# efmesh backfill-recovery

Intervals are tracked per snapshot: `done` or `failed`. A stuck backfill shows
up in `status --json`. Diagnose with `--json`, never with stdout text.

## Step 1 — find the affected intervals

```
efmesh status <env> --json
```

Read `lag[]` (one entry per `incrementalByTimeRange` model):

```json
"lag": [ { "model": "mart.daily_revenue", "doneUpTo": "2026-07-16T00:00:00.000Z",
           "missing": 1, "failed": 2 } ]
```

- `missing` > 0 — intervals up to "now" not yet computed (a normal gap: time
  passed, or a tick has not run). `run` fills these.
- `failed` > 0 — intervals that errored during a previous backfill (poisoned
  range). `run` will **retry** them on its next tick, because a failed interval
  is not `done` and is therefore still wanted.
- `doneUpTo` — the end of the last `done` interval; `null` means nothing computed.

Also read `ticks[]`: the freshest tick's `outcome` and structured `detail` tell
you whether the last attempt was `ok` (`detail`: `{ "built": [...] }`), `error`
(a real failure — `detail`: `{ "error": "<tag>", "model"?, "interval"?,
"message"? }`, naming the model and interval it died on), `awaiting-human`
(`{ "blockedBy": [...] }`, a structural change pending), or `lock-held`
(`{ "lock": "…" }`, contended). `detail` is a structured object now, not text.

## Step 2 — rerun

```
efmesh run <env> --json
```

`run --json` reports the tick's outcome (carrying `apiVersion`): `{ "env": …,
"outcome": "ok", "processed": ["model", …] }` when it advanced intervals, or
`{ "env": …, "outcome": "awaiting-human", "processed": [], "blockedBy":
["model: category", …] }` on exit 2. `processed` is the models it caught up.

`run` semantics:

- It **only advances existing versions** — it catches up `missing` intervals and
  retries `failed` ones for the versions already promoted to the env.
- It does **not** apply structural changes. If the project has unapplied
  edits, `run` exits `2` and journals an `awaiting-human` tick — go to
  **efmesh-safe-apply** first, then `run`.
- Progress is per-interval in the state store: an interrupted backfill resumes
  from where it stopped; already-`done` intervals are not recomputed.
- For transient failures, `run <env> --retries N` retries a failed batch with
  exponential backoff.

Exit codes: `0` caught up (or nothing to do); `2` structural changes await an
apply; `1` a real error (read the failure screen; `--log-level debug` for the
trace).

## Step 3 — confirm recovery

Re-read `status <env> --json`: success is `lag[].failed === 0` and
`lag[].missing === 0` for the model, plus a fresh `ticks[0].outcome === "ok"`.

## When a range is genuinely poisoned

If the same intervals keep landing in `failed` after retries, the data or the
model logic is wrong for that range — this is a real error (exit 1 / an `error`
tick), not something `run` can retry away. Fix the root cause (bad source data,
a model bug), which is a `breaking` change applied via **efmesh-safe-apply**
(a full backfill recomputes the poisoned history).

> To force-recompute a specific past interval range independent of the version
> diff (e.g. corrected source data for a window that is already `done`), use
> `efmesh restate <env> --model <m> --from <t> --to <t>` (#21). It clears the
> range's interval bookkeeping for the model and its descendants so the next
> `run` recomputes them; `--dry-run --json` previews the targets and intervals
> without mutating the store. Use it when the data is wrong but the model logic
> is unchanged; use a `breaking` re-apply when the logic itself changed.

## Guard rails

- Never hand-edit the `intervals` table to mark something `done`. `run` and
  `apply` are the only writers; a hand-forged `done` serves data that was never
  computed.
- Do not loop `run` against a `2` exit — that means an apply is required, not a
  retry.
- Do not clear locks to "unstick" a run; a `lock-held` tick is a concurrent
  run, and stale locks reclaim on a ttl.

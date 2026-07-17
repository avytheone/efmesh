---
name: efmesh-safe-apply
description: >-
  Apply pending structural changes to an efmesh environment safely and
  headlessly. Use when a plan needs to be reviewed and applied, when `run`
  returned exit 2 / an `awaiting-human` tick, or when asked to promote /
  deploy / apply changes to an env. Covers when `--reclassify` and
  `--forward-only` are appropriate and when they are forbidden.
---

# efmesh safe-apply

`run` only advances existing versions. Structural changes (new/edited models)
go through `plan` → `apply`. Read the plan as `--json`; never parse the plan
screen text.

## Step 1 — preview the plan (changes nothing)

```
efmesh plan <env> --explain --json
```

Shape (contract):

```json
{
  "env": "dev",
  "hasChanges": true,
  "actions": [
    {
      "name": "mart.daily_revenue",
      "change": "breaking",
      "fingerprint": "63da1028…",
      "reclassifiedFrom": "breaking",       // present only when overridden
      "reusedFrom": "d8605e78…",            // present only when physics is inherited
      "build": true,
      "backfill": [ { "start": "2026-01-01T00:00:00.000Z", "end": "2026-07-17T00:00:00.000Z" } ],
      "explain": {
        "diverged": ["where_clause.children[2] (added)"],
        "reason": "the tree diverged outside the SELECT list (…)",
        "cascadeFrom": ["mart.daily_revenue"]   // present for indirect
      }
    }
  ]
}
```

- `hasChanges === false` → nothing to do. `apply` would be a no-op view-swap.
- Read each action's `change`. `explain.reason` / `explain.diverged` say **why**
  the category is what it is (a debugging hint — the AST paths are not a
  versioned contract; the categories are).

## Step 2 — understand the change categories

| `change` | what it means | what rebuilds | retroactive? |
|---|---|---|---|
| `added` | new model | itself | n/a |
| `removed` | gone from project; view dropped at promote | nothing | n/a |
| `breaking` | edited query/logic (WHERE/JOIN/expr, dropped/renamed column) | the model **and all descendants** | yes — full backfill |
| `non-breaking` | strictly-suffix columns appended to the SELECT | only itself | no |
| `indirect` | own AST unchanged; version shifted by a parent (`explain.cascadeFrom`) | may reuse parent physics (`reusedFrom`) | no if reused |
| `forward-only` | reuse old physics + done-intervals; new logic applies from now on | nothing retroactively | no |
| `unchanged` | no change | nothing | n/a |

## Step 3 — apply

Headless (CI, cron, agent) **must** pass `--yes`, or a plan with changes exits
`2` (awaiting a human) rather than applying something nobody saw:

```
efmesh apply <env> --yes
```

`apply` re-plans and applies under one cross-process lock, so exactly the plan
you previewed is what lands. Exit codes:

- `0` — applied (or a no-op view-swap).
- `2` — the plan had changes and no `--yes` in a non-TTY. This is the guard, not
  a bug: re-run with `--yes` only after you have reviewed the `plan --json`.
- `1` — a real error (bad config, engine/state error, a guard-rail refusal).

> Note: `apply` has no `--json` on its result — confirm the outcome with
> `efmesh status <env> --json` (check `lastPlan` and the newest `ticks[0]`)
> and the exit code.

## `--reclassify` — when appropriate, when FORBIDDEN

`--reclassify <model>=breaking|non-breaking[,…]` states the operator's verdict
on top of `--explain`. It governs whether **descendants may reuse physics**; it
is journaled with `applied_by`. It does **not** exempt the model itself from a
rebuild — that is `--forward-only`'s job.

- Appropriate: efmesh was conservative and called a change `breaking`, but you
  know the existing columns' data is unchanged, and you want unchanged
  descendants to reuse their physics instead of a full rebuild.
- FORBIDDEN / refused (exit 1): declaring `non-breaking` a change that **drops
  columns** — it plainly contradicts the AST and efmesh refuses it. Do not try
  to force it; a dropped column is genuinely breaking.
- Inert (silently ignored): reclassify on `unchanged` / `added` / `removed` /
  `indirect`. Only `breaking` ↔ `non-breaking` verdicts are honored.
- Never reclassify to dodge a rebuild you don't understand. When unsure, let
  efmesh stay conservative (breaking) — a needless rebuild is safe; a wrong
  non-breaking serves stale data.

## `--forward-only` — when appropriate, when FORBIDDEN

`--forward-only <model>,…` reuses the old physical table and done-intervals; the
new logic takes effect from now on, history is **not** replayed.

- Appropriate: an `incrementalByTimeRange` model where replaying all history is
  prohibitively expensive and "new logic from now on" is acceptable. New columns
  are added via `ALTER` (history rows get NULL).
- FORBIDDEN / refused (exit 1):
  - Any kind other than `incrementalByTimeRange` (full, view, seed,
    incrementalByUniqueKey, scdType2). Forward-only reuses interval accounting,
    which only that kind has — `ForwardOnlyError`.
  - A change that **drops columns** — reuse cannot express it.
- Do not use forward-only to paper over a genuinely breaking change when
  downstream consumers need corrected history — that is a `breaking` apply
  (full backfill), by design.

## Guard rails

- Never apply a plan you have not read as `--json` first.
- Never pass `--yes` reflexively to clear an exit 2 — read the plan, then decide.
- Exit 2 is "awaiting a human", not a failure: escalate or review, do not retry.
- One env's `apply` and `run` share one lock; a `LockHeldError` (exit 1) or a
  `lock-held` tick means another is running — wait, never clear the lock by hand.

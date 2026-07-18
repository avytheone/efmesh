---
name: add-model-kind
description: Add a new materialization kind (like full/incrementalByTimeRange/scdType2) to efmesh, touching every place a kind is wired. Use when introducing a new ModelKind variant so no executor case, planner rule, or doc is missed.
---

# Adding a model kind

A kind touches fingerprint, executor, planner, contract, diff, the graph legend,
docs and tests. Miss one and you get a silent wrong-physics or a `tsc` failure.
The existing kinds — `full`, `view`, `embedded`, `incrementalByTimeRange`,
`incrementalByUniqueKey`, `scdType2`, `external`, `seed` — are the templates;
follow the closest one (`scdType2` for a stateful table kind,
`incrementalByUniqueKey` for a refresh-every-apply upsert kind).

## Touchpoints (in order)

1. **`src/core/model.ts`**
   - Add the variant to the `ModelKind` union (with its data-affecting fields).
   - Add a constructor to the `kind` builder object.
   - Add config validation in `validateKindConfig` (key columns exist in the
     schema, target compatibility, etc. — mirror the `scdType2`/`uniqueKey`
     branches).
   - If it uses `ctx.start`/`ctx.end`, relax the `usesBounds` guard in
     `assembleModel` (today only `incrementalByTimeRange` may use bounds).
2. **`src/plan/fingerprint.ts` — `kindPayload`**: add a `case` returning the
   metadata that affects data shape (keys, managed columns, etc.). The `switch`
   has no `default`, so `tsc` flags a missing case — that is your safety net.
   Fields that only change execution/history (batch size, lookback) must NOT
   enter the payload.
3. **`src/plan/executor.ts` — `buildOne`**: add a `case` that builds the physics,
   runs `checkContract`, `runAudits`, and `store.upsertSnapshot` (copy the shape
   of the nearest existing case). If the kind needs a DuckDB-only feature, extend
   the `EngineFeatureError` gate near the top of `applyPlan`.
4. **`src/plan/planner.ts`**
   - `REUSABLE_KINDS` — add the tag if its physics can be inherited on indirect
     reuse (materialized, deterministic-by-parents). Leave out view/embedded-like
     kinds.
   - The `refresh` field (`refresh: model.kind._tag === "incrementalByUniqueKey"
     || … === "scdType2"`) — set true if the kind re-runs its query every apply.
   - `backfill`/interval logic stays gated on `incrementalByTimeRange`; a
     non-time-range kind produces no backfill ranges.
   - The forward-only guard rejects everything except `incrementalByTimeRange` —
     extend only if forward-only is meaningful for your kind.
5. **`src/plan/contract.ts`**: if the kind maintains its own columns (like
   scd's `valid_from`/`valid_to`), pass them as the `managed` set so the schema
   contract does not treat efmesh-managed columns as query columns.
6. **`src/plan/diff.ts`**: add the tag to `COMPARABLE_KINDS` and wire its
   matching key (grain vs the kind's own key) so `diff --data` can compare it.
7. **`src/plan/graph-html.ts`**: add a color to `KIND_COLOR` so the kind shows
   in `efmesh graph --html` and its legend.
8. **Docs**: describe the kind in `SPEC.md` §3.1 (materialization kinds), and in
   `README.md`.
9. **Tests**: extend `test/kinds.test.ts` (definition/validation) and add a
   dedicated behavior test modeled on `test/scd.test.ts` (build + reconcile +
   audits), plus planner/executor coverage. A change without a failing-first
   test is suspect.
10. **Green:** `bun test` and `bun run check`. **CHANGELOG** `## [Unreleased]`:
    a user-visible entry for the new kind.

## Invariant

Lean on the exhaustive `switch (kind._tag)` blocks (`kindPayload`, `buildOne`) —
they have no `default`, so `bun run check` (tsc) will name every switch you
forgot. Grep `kind._tag` across `src/` to catch the non-switch call sites
(planner sets, diff, graph legend, contract) that tsc will not flag.

---
name: fingerprint-change
description: Diagnose a red golden fingerprint test and bump FINGERPRINT_VERSION consciously. Use when test/fingerprint-golden.test.ts fails, when an engine/parser upgrade (DuckDB, libpg-query) shifts canonicalization, or when deliberately changing the fingerprint payload.
---

# Fingerprint change / golden-test drift

`FINGERPRINT_VERSION` (`src/plan/fingerprint.ts`, currently **1**) is a
contract. The fingerprint is `sha256` over the canonicalized AST (DuckDB
`json_serialize_sql` / libpg_query), the data-affecting metadata
(`kindPayload`, `grain`, `columns`, `target`), and the sorted parent
fingerprints. Change any input and **every** user's models silently
re-fingerprint, forcing a full warehouse rebuild.

`test/fingerprint-golden.test.ts` freezes concrete hashes (`GOLDEN.raw`,
`.events`, `.daily`, `.postgresCanonSha256`, `.fingerprintVersion`) and asserts
`FINGERPRINT_VERSION === GOLDEN.fingerprintVersion`.

## A red golden test means canon/payload drift — STOP

**Do not just update the hashes.** A red test is the alarm working. Follow this:

1. **Understand the drift.** What moved?
   - a `@duckdb/node-api` bump → `json_serialize_sql` output changed;
   - a `libpg-query` bump → the Postgres canon tree changed
     (`GOLDEN.postgresCanonSha256`);
   - a deliberate edit to the fingerprint payload in `fingerprint.ts`
     (`kindPayload`, `columns`, `grain`, `target`, `parents`, or the
     `JSON.stringify` composition in `modelFingerprint`).
   Confirm which by reading the diff / dependency change — not by guessing.
2. **Is the drift intended?** If a dependency bump changed canon *by accident*
   and you did not mean to, the answer may be to hold the dependency, not to
   re-fingerprint everyone.
3. **If the change is intended, bump the version consciously:**
   - increment `FINGERPRINT_VERSION` in `src/plan/fingerprint.ts`;
   - update `GOLDEN.fingerprintVersion` and re-freeze the new hash values in
     `test/fingerprint-golden.test.ts` (run the test, read the actual values,
     paste them — only *after* steps 1–2).
4. **Migration story.** Snapshots carry `fingerprintVersion` in the state store;
   the planner compares only same-version fingerprints and raises
   `FingerprintVersionError` (a loud halt, model named) rather than declaring
   everything breaking. Document in the CHANGELOG that the version bumped and
   that a re-plan/re-apply rebuilds physics under the new fingerprints. Note it
   in SPEC.md §4 if the algorithm/payload semantics changed.
5. **Green:** `bun test` (the whole golden file, plus `fingerprint.test.ts`) and
   `bun run check`.

## Invariants

- The canon cache key (`canonCacheKey`) already folds in `FINGERPRINT_VERSION`
  and the dialect, so a bumped version can never hand back a stale cached canon —
  do not weaken that key.
- `batchSize`, `lookback`, `start`, `description` deliberately stay OUT of the
  fingerprint (they change execution/history, not data shape). Do not add them.
- Re-freezing hashes without doing steps 1–2 is the failure mode this contract
  exists to prevent.

---
name: efmesh-upgrade
description: >-
  Upgrade the efmesh package and migrate the state store schema safely. Use when
  bumping the efmesh version, when a command failed with StateSchemaError /
  FingerprintVersionError (the store refuses to open until migrated), or when
  asked to update / upgrade efmesh.
---

# efmesh upgrade

The state store schema is versioned. A store older than the installed efmesh
**refuses to open** (`StateSchemaError`, exit 1) until migrated — efmesh never
silently changes someone else's data on open. Migrate deliberately.

## Step 0 — back up first

Before upgrading, back up the state store and the lake/physics together (see the
**efmesh-environment-hygiene** skill, "What to back up"). `efmesh migrate` also
takes its own file backup of a SQLite store, but keep your own.

## Step 1 — bump the package

Update the dependency to the target version in the consuming project, e.g.:

```
bun add @avytheone/efmesh@<version>     # or npm/pnpm equivalent
```

efmesh pins Effect exactly as a peerDependency — install the matching Effect
beta the release expects (a mismatch surfaces at install/typecheck time).

## Step 2 — migrate the state store

```
efmesh migrate --json
```

Shape (contract): `{ "apiVersion": 1, "from": <int>, "to": <int>, "backup"?: "<path>" }`
— like every `--json` payload it carries the top-level `apiVersion` (currently `1`).

- `from === to` → the store was already current; no-op. Exit `0`.
- `from < to` → migrated `from` → `to`. For a SQLite store, `backup` names the
  saved copy of the old store (Postgres stores migrate the `efmesh_state`
  schema in place — no `backup` field).
- Exit `0` on success, `1` on failure (restore from your backup and read the
  failure screen).

## Step 3 — verify

```
efmesh status <env> --json
```

- `storeVersion` in the output should equal the migrate `to`.
- A successful read means the store opened at the new schema. Re-run any command
  that previously failed with `StateSchemaError` / `FingerprintVersionError`; it
  should now succeed.

## On FingerprintVersionError

If commands fail with `FingerprintVersionError` (the fingerprint algorithm
changed between versions), the cure is the same path: `efmesh migrate`, or make
sure the installed efmesh matches the store, then re-apply. The failure screen
prints the exact hint. Do not hand-edit fingerprints or the store.

## Guard rails

- Never edit the state store by hand — `efmesh migrate` and the CLI are the only
  writers.
- Do not downgrade efmesh under a migrated store: a newer schema will not open
  on an older efmesh. Roll back by restoring the pre-migrate backup instead.
- Do not skip the migrate step hoping the store "just works" — an old store
  refuses to open by design; a fresh store bootstraps itself.

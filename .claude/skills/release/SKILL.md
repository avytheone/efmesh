---
name: release
description: Cut an efmesh npm release — bump the version, roll the CHANGELOG, tag, push, and watch Trusted Publishing land on npm. Use when asked to "release", "publish", "cut vX.Y.Z", or ship a new version to npm.
---

# Releasing efmesh

Publishing is automated: pushing a `vX.Y.Z` tag triggers
`.github/workflows/release.yml`, which runs tsc + tests, checks the tag matches
`package.json`, and `npm publish`es via Trusted Publishing (OIDC, provenance —
no tokens). Your job is the commit, the tag, and verification.

The package is scoped: **`@avytheone/efmesh`** (the `bin` is `efmesh`, but the
npm name is scoped). Every `npm view` uses the scoped name.

## Checklist

1. **Green first.** `bun test` and `bun run check` must pass. Working tree clean.
2. **Pick the version** (SemVer). A hyphen (`0.3.0-beta.1`) → `beta` dist-tag;
   a clean version (`0.3.0`) → `latest`. The workflow derives this from the
   version string — do not fight it.
3. **Bump `package.json`** `version` to `X.Y.Z`.
4. **Roll `CHANGELOG.md`**: rename the `## [Unreleased]` heading to
   `## [X.Y.Z] — YYYY-MM-DD` (today's date), and open a fresh empty
   `## [Unreleased]` above it. Keep a Changelog format, user-visible entries only.
5. **Commit** exactly these two files: `release: X.Y.Z`
   (the `release:` conventional prefix, no `closes #N`).
6. **Tag** the release commit: `git tag vX.Y.Z` (annotated or lightweight).
   The tag name is `v` + the exact `package.json` version.
7. **Push commit then tag**: `git push origin main && git push origin vX.Y.Z`.
   Pushing the tag is what fires the publish workflow.
8. **Watch the run**: `gh run watch` (or `gh run list --workflow=release.yml`
   then `gh run watch <id>`). It must go green — a mismatch between the tag and
   `package.json` fails the "Tag version = package version" step by design.
9. **Verify npm**: `npm view @avytheone/efmesh dist-tags` — the new version sits
   under `beta` (hyphenated) or `latest` (clean).
10. **GitHub Release** (optional, done after the tag exists):
    `gh release create vX.Y.Z --notes-from-tag` or with hand-written notes.

## Gates — do not violate

- **Never `gh release create vX.Y.Z` on a tag that does not exist yet** — it
  silently tags HEAD, decoupling the release from your release commit. Create
  and push the git tag first; only then `gh release create` against the existing tag.
- **Tag == `package.json` version**, exactly. The workflow's version-check step
  aborts the publish otherwise.
- **Do not publish by hand** (`npm publish` locally). Publishing is
  OIDC/provenance from CI only; a local publish has no provenance and can use
  the wrong dist-tag.
- The pin `effect@…-beta.N` (peerDependency + devDependency) is a contract —
  a release is not the moment to bump it.

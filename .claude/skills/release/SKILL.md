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
3. **Review `README.md`** — a read, not a find-and-replace. The CHANGELOG is
   current because rolling it is a step; the README is current only because you
   just looked. Do this *before* the bump, while the diff you are shipping is
   still in front of you:
   - **version claims match the version being cut.** The "efmesh is `0.N.x`"
     sentence and the `## Status` heading are the two known ones — find any
     others by reading, not by grepping for the old number, because the next
     stale claim will be phrased differently.
   - **the `## Status` facts still hold**: the test count (`bun test` prints it),
     the codebase size, the phase claims.
   - **every user-visible entry in the CHANGELOG section you are releasing has a
     home in the README** — or a deliberate decision that it does not need one.
     The CHANGELOG says what *changed*; the README says what the thing *is*, so
     a feature living in only one of them must be on purpose. This is the bullet
     that costs real reading, and the drift it catches is the expensive kind: a
     shopwindow quietly describing a smaller product than the one on npm.
   - **the roadmap paragraph names a theme, not a version.** A milestone groups
     work; a version is assigned at release time (CLAUDE.md
     § "Where things are decided", SPEC §11.1).
4. **Bump `package.json`** `version` to `X.Y.Z`.
5. **Roll `CHANGELOG.md`**: rename the `## [Unreleased]` heading to
   `## [X.Y.Z] — YYYY-MM-DD` (today's date), and open a fresh empty
   `## [Unreleased]` above it. Keep a Changelog format, user-visible entries only.
6. **Commit** the release files: `release: X.Y.Z`
   (the `release:` conventional prefix, no `closes #N`). That is `package.json`,
   `CHANGELOG.md`, and `README.md` if step 3 changed it.
7. **Tag** the release commit: `git tag vX.Y.Z` (annotated or lightweight).
   The tag name is `v` + the exact `package.json` version.
8. **Push commit then tag**: `git push origin main && git push origin vX.Y.Z`.
   Pushing the tag is what fires the publish workflow.
9. **Watch the run**: `gh run watch` (or `gh run list --workflow=release.yml`
   then `gh run watch <id>`). It must go green — a mismatch between the tag and
   `package.json` fails the "Tag version = package version" step by design.
10. **Verify npm**: `npm view @avytheone/efmesh dist-tags` — the new version sits
    under `beta` (hyphenated) or `latest` (clean).
11. **GitHub Release** (optional, done after the tag exists):
    `gh release create vX.Y.Z --notes-from-tag` or with hand-written notes.

## Gates — do not violate

- **Never `gh release create vX.Y.Z` on a tag that does not exist yet** — it
  silently tags HEAD, decoupling the release from your release commit. Create
  and push the git tag first; only then `gh release create` against the existing tag.
- **Tag == `package.json` version**, exactly. The workflow's version-check step
  aborts the publish otherwise.
- **Do not skip the README review because the release "is only a fix"**. Drift
  is cumulative and nobody re-reads the shopwindow between releases; a patch is
  the cheapest moment to catch a claim two minors out of date.
- **Do not publish by hand** (`npm publish` locally). Publishing is
  OIDC/provenance from CI only; a local publish has no provenance and can use
  the wrong dist-tag.
- The pin `effect@…-beta.N` (peerDependency + devDependency) is a contract —
  a release is not the moment to bump it.

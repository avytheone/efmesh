---
name: claim-sheet
description: Produce the required short, evidence-backed claim sheet before a release, a substantial merge, or merging a subagent branch. Separate assertions, observed test results, and unchecked feature interactions; refresh it for the exact reviewed SHA.
---

# Change claim sheet

Run before **every release**, **every substantial merge** (public behavior,
contracts, feature interactions, or workflow policy), and **merging any subagent
branch**. Complete the sheet before the decision, then refresh it after changes
or new test results. A completed issue, a green suite, or a convincing rationale
is not the sheet. It neither authorizes a release nor replaces required checks
and review (CLAUDE.md, SPEC §11.1).

Put the merge sheet in the PR body, or link it there. For a release, keep it in
`docs/claims/` and link it from the release review. Keep it short: six numbered
claims plus scope and evidence links, usually about one page. State uncertainty
inside the relevant claim, not in a blanket disclaimer.

## Evidence rules

- Identify base and head SHAs, operation (merge/release), and evidence date.
  For a release, identify the tag/candidate and the previous release too.
- Label statements **observed**, **source-reviewed**, or **not checked**. A test
  file establishes an intended assertion, not that the test ran or passed.
- Give commands, exact tested SHAs, exit/results, skips, and CI links. Distinguish
  a PR head from its tested merge ref; verify their trees when claiming equivalence.
- A failure due to a missing API or tool is not a behavioral red-before. If no
  comparable pre-change failure was observed, say **no observed red-before**.
  Never infer it from an after-only test, its name, a comment, or a green suite.
- For retrospectives, pin historical sources and test definitions to that tag.
  Separate historical runs actually retrieved/replayed from later runs against
  different code. Never present today's CI as the old release's verification.
- Read the actual declarations and diff, not just the CHANGELOG or stale skill
  version numbers. Do not re-freeze goldens to make a claim true.

## Required sheet

1. **Frozen contracts and versions.** For each of `FINGERPRINT_VERSION`,
   `STATE_VERSION`, `--json`/`apiVersion`, exit codes, and locks: touched or
   untouched, evidence, and bump/no-bump reason (or why a numeric bump is not
   applicable). Include the public API/types, manifest version, and dependency
   pins when relevant. Separate package version classification from internal
   contract versions; name migration or compatibility risks explicitly.
2. **Feature combinations.** Name the existing features considered together,
   with concrete cases and evidence. Name relevant pairs **not considered or
   not exercised**, including backend/materialization, redaction, batching,
   concurrency, and old consumers where applicable. Do not imply a full matrix.
3. **Red-before / green-after.** List comparable before/after commands, SHAs,
   results and skips. Otherwise say **no observed red-before** and why. Separate
   source-only review, local results, CI results and historical evidence.
4. **Additive claim.** Identify exactly what is claimed additive and for which
   consumer. Check old callers, object constructors, required public fields,
   and existing return semantics separately from tolerant wire readers. A new
   required field on a public type is not additive. If there is no additive
   claim, say so; apply the existing version policy without inventing an exception.
5. **Learned while testing.** What changed your understanding only when writing
   or running the test? If nothing, say so. Label a source-review discovery or a
   historical author's recorded lesson separately; do not manufacture a test story.
6. **First diagnosis.** State the first concrete command, file, or invariant to
   inspect if this breaks, and what would distinguish the likely causes.

## Review handoff

Audit each assertion against its linked evidence and the unchecked combinations.
Correct unsupported certainty and surface material unresolved risks before the
merge/release decision. An unchecked pair is review input, not automatic proof
of failure or success. Hand off the exact SHA and sheet for independent review;
refresh both if the reviewed change moves.

The [0.5.0 retrospective](../../../docs/claims/0.5.0-retrospective.md) demonstrates
source-only historical evidence and an additive claim that does not hold for
public type constructors.

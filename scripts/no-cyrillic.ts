#!/usr/bin/env bun
// Repo language gate: source and tests are English-only (see CLAUDE.md).
// Rejects staged files under src/ and test/ that contain Cyrillic letters,
// pointing at the exact file and line so the offender is trivial to fix.
// README.ru.md is the single maintained Russian artifact and is exempt
// (it lives at the repo root, not under src/ or test/, but we are explicit).

const ALLOWLIST = new Set(["README.ru.md"]);
const CYRILLIC = /[Ѐ-ӿԀ-ԯ]/;
// Deliberate non-ASCII test fixtures (e.g. asserting that Cyrillic input is
// refused or sanitised) opt out per-line with this greppable marker.
const OPT_OUT = "cyrillic-ok";

// Paths come from lefthook's {staged_files}; normalise and keep only the
// two directories the rule guards.
const files = process.argv.slice(2).filter((path) => {
  const normalized = path.replace(/^\.\//, "");
  if (ALLOWLIST.has(normalized)) return false;
  return normalized.startsWith("src/") || normalized.startsWith("test/");
});

let offending = 0;

for (const file of files) {
  let text: string;
  try {
    text = await Bun.file(file).text();
  } catch {
    // A staged deletion or unreadable path — nothing to police.
    continue;
  }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // The marker may sit on the offending line or as a comment just above it.
    if (lines[i].includes(OPT_OUT) || lines[i - 1]?.includes(OPT_OUT)) continue;
    const match = CYRILLIC.exec(lines[i]);
    if (match) {
      offending++;
      console.error(
        `${file}:${i + 1}: Cyrillic character ${JSON.stringify(match[0])} ` +
          `(U+${match[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}) — ` +
          `src/ and test/ are English-only`,
      );
    }
  }
}

if (offending > 0) {
  console.error(
    `\n${offending} Cyrillic occurrence(s) in staged src/ or test/ files. ` +
      `English-only there; README.ru.md is the sole Russian artifact.`,
  );
  process.exit(1);
}

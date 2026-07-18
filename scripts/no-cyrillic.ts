#!/usr/bin/env bun
// Repo language gate: source and tests are English-only (see CLAUDE.md).
// Rejects staged files under src/ and test/ that contain Cyrillic letters,
// pointing at the exact file and line so the offender is trivial to fix.
// README.ru.md is the single maintained Russian artifact and is exempt
// (it lives at the repo root, not under src/ or test/, but we are explicit).

import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Context, Data, Effect, FileSystem, Layer } from "effect"

const ALLOWLIST = new Set(["README.ru.md"])

// Script=Cyrillic covers the base block plus Supplement and Extended-A/B/C,
// which a hand-written [U+0400-U+04FF] range misses — and it keeps this file
// ASCII, so the gate can never trip over its own pattern.
const CYRILLIC = /\p{Script=Cyrillic}/u

// Deliberate non-ASCII test fixtures (e.g. asserting that Cyrillic input is
// refused or sanitised) opt out per-line with this greppable marker.
const OPT_OUT = "cyrillic-ok"

interface Offence {
  readonly file: string
  readonly line: number
  readonly char: string
}

const codePoint = (char: string): string =>
  `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`

/** The gate failing as one value: every offence, rendered as one screen. */
class CyrillicGateError extends Data.TaggedError("CyrillicGateError")<{
  readonly offences: ReadonlyArray<Offence>
}> {
  override get message(): string {
    const found = this.offences.map(
      ({ file, line, char }) =>
        `${file}:${line}: Cyrillic character ${JSON.stringify(char)} (${codePoint(char)}) — src/ and test/ are English-only`,
    )
    return (
      `${found.join("\n")}\n\n` +
      `${this.offences.length} Cyrillic occurrence(s) in staged src/ or test/ files. ` +
      `English-only there; README.ru.md is the sole Russian artifact.`
    )
  }
}

// Normalise and keep only the two directories the rule guards.
const guarded = (paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  paths.flatMap((path) => {
    const normalized = path.replace(/^\.\//, "")
    if (ALLOWLIST.has(normalized)) return []
    const inScope = normalized.startsWith("src/") || normalized.startsWith("test/")
    return inScope ? [normalized] : []
  })

const scanFile = (
  file: string,
): Effect.Effect<ReadonlyArray<Offence>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return scan(file, yield* fs.readFileString(file))
  }).pipe(
    // A staged deletion or an unreadable path: nothing to police.
    Effect.catchTag("PlatformError", () => Effect.succeed<ReadonlyArray<Offence>>([])),
  )

const scan = (file: string, text: string): ReadonlyArray<Offence> => {
  const lines = text.split("\n")
  const offences: Array<Offence> = []
  for (let i = 0; i < lines.length; i++) {
    // The marker may sit on the offending line or as a comment just above it.
    if (lines[i].includes(OPT_OUT) || lines[i - 1]?.includes(OPT_OUT)) continue
    const match = CYRILLIC.exec(lines[i])
    if (match) offences.push({ file, line: i + 1, char: match[0] })
  }
  return offences
}

/**
 * The file list lefthook passes as {staged_files}. A service, not a read of
 * `process.argv` mid-program: the scan stays a pure function of its input and
 * a test can drive it with a literal list.
 */
export class StagedFiles extends Context.Service<StagedFiles, ReadonlyArray<string>>()(
  "no-cyrillic/StagedFiles",
) {}

/** lefthook passes {staged_files} as argv — the one impure edge of this script. */
const StagedFilesFromArgv = Layer.succeed(StagedFiles, guarded(process.argv.slice(2)))

//
//
//

Effect.gen(function* () {
  const files = yield* StagedFiles
  // forEach preserves input order, so the report reads in staged order however
  // the reads interleave; the cap keeps fd pressure sane on a large commit.
  const found = yield* Effect.forEach(files, scanFile, { concurrency: 16 })
  const offences = found.flat()
  if (offences.length > 0) return yield* new CyrillicGateError({ offences })
}).pipe(
  Effect.catchTag("CyrillicGateError", (error) =>
    Console.error(error.message).pipe(
      Effect.andThen(
        Effect.sync(() => {
          process.exitCode = 1
        }),
      ),
    ),
  ),
  Effect.provide(Layer.mergeAll(StagedFilesFromArgv, BunServices.layer)),
  BunRuntime.runMain,
)

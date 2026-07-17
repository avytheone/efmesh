import { Cause } from "effect"

/**
 * Actionable next step for a failure, when one exists — the recipe the
 * `schedule` command already prints for a missing cron daemon, generalized to
 * every error that has one obvious cure (#13). No entry ⇒ the message already
 * says everything; we do not invent filler advice.
 */
const FAILURE_HINTS: Readonly<Record<string, (error: Record<string, unknown>) => string>> = {
  StateSchemaError: () => "run `efmesh migrate` to bring the state store up to date",
  FingerprintVersionError: () => "run `efmesh migrate` or upgrade efmesh, then re-apply",
  LockHeldError: (error) =>
    `wait for the other apply/run to finish, or clear the stale lock «${String(error["name"])}»`,
  LockLostError: () => "nothing was left half-written; check `efmesh status`, then re-run",
  LakeNotConfiguredError: () => "add `lake: { path: … }` to efmesh.config.ts",
  DucklakeNotConfiguredError: () => "add `ducklake: { catalog: … }` to efmesh.config.ts",
  AttachNotConfiguredError: (error) =>
    `add «${String(error["attach"])}» to \`attach\` in efmesh.config.ts`,
  ConfigLoadError: () => "check the --config path and that it default-exports defineConfig({ … })",
  RunBlockedByChangesError: (error) => `run \`efmesh apply ${String(error["env"])}\``,
}

/** First line of a rendered failure: the tag names the class, the message the culprit + cause. */
const errorHeadline = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const record = error as Record<string, unknown>
    const message = record["message"]
    const detail = typeof message === "string" && message !== "" ? message : "(no detail)"
    return `${String(record["_tag"])}: ${detail}`
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message !== "" ? error.message : "(no detail)"}`
  }
  return String(error)
}

/**
 * The single failure renderer (#13): cause first (the tagged error's derived
 * message names the culprit), an actionable hint where one exists, and the
 * Effect fiber trace ONLY under `--log-level debug` — an operator or agent
 * sees one screen with the real cause, not a stack over an empty message. The
 * exit code stays a frozen contract (0/1/2): the caller sets it, not this.
 */
export const renderFailure = (
  cause: Cause.Cause<unknown>,
  options?: { readonly debug?: boolean },
): string => {
  const error = Cause.squash(cause)
  const lines = [errorHeadline(error)]
  const tag =
    typeof error === "object" && error !== null && "_tag" in error
      ? String((error as Record<string, unknown>)["_tag"])
      : ""
  const hint = FAILURE_HINTS[tag]?.(error as Record<string, unknown>)
  if (hint !== undefined) lines.push(`  → ${hint}`)
  if (options?.debug === true) {
    lines.push("", "── trace (--log-level debug) ──", Cause.pretty(cause))
  } else {
    lines.push("  (re-run with --log-level debug for the full trace)")
  }
  return lines.join("\n")
}

/**
 * Whether the run asked for the full trace. Reused from the already-parsed
 * global `--log-level` flag (values trace/debug/all mean "show me everything")
 * so there is one knob, not a second bespoke verbosity flag.
 */
export const wantsTrace = (argv: ReadonlyArray<string>): boolean => {
  const verbose = new Set(["trace", "debug", "all"])
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg.startsWith("--log-level=")) return verbose.has(arg.slice("--log-level=".length))
    if (arg === "--log-level") return verbose.has((argv[index + 1] ?? "").toLowerCase())
  }
  return false
}

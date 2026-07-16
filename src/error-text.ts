/**
 * Message-building helpers shared by tagged errors (#13). Every error's
 * `message` is DERIVED from its typed fields — no information lives only in a
 * formatted string, and a vacuous message is constructively impossible: the
 * culprit and the underlying cause are always carried in fields and rendered
 * here. Kept out of the public API on purpose (internal plumbing).
 */

/**
 * Human text of an unknown caught value — the engine/syscall/parser's own
 * message. This is the thing the code cannot invent: it must be surfaced from
 * whatever the underlying layer threw, never swallowed.
 */
export const causeText = (cause: unknown): string => {
  if (cause instanceof Error) {
    return cause.message !== "" ? cause.message : cause.name
  }
  if (typeof cause === "string") return cause
  if (cause === undefined) return "unknown cause"
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { readonly message: unknown }).message
    if (typeof message === "string" && message !== "") return message
  }
  return String(cause)
}

/**
 * One-line SQL context for an error message: whitespace collapsed, truncated
 * with an ellipsis. The full statement stays in the error's `sql` field for
 * programmatic consumers; this is only the human-readable tail.
 */
export const sqlSnippet = (sql: string, max = 200): string => {
  const collapsed = sql.replace(/\s+/g, " ").trim()
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed
}

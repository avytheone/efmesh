/**
 * Helper for the heartbeat test (#18): a foreign process that holds the env
 * lock through `withStateLock` — so a forked heartbeat renews the lease while
 * the body runs. The body prints LOCKED (the lock is already held by then) and
 * then hangs forever; only SIGKILL ends it, stopping the heartbeat with it.
 * Arguments: <store-path> <lock-name> <ttlMs>
 */
import { Effect } from "effect"
import { withStateLock } from "../../src/plan/lock.ts"
import { SqliteStateLive } from "../../src/state/sqlite.ts"

const [path, name, ttl] = process.argv.slice(2) as [string, string, string]

await Effect.runPromise(
  withStateLock(
    name,
    Number(ttl),
  )(Effect.sync(() => console.log("LOCKED")).pipe(Effect.andThen(Effect.never))).pipe(
    Effect.provide(SqliteStateLive({ path })),
  ),
)

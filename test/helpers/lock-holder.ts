/**
 * Helper for the kill-9 test (#7): a foreign process that honestly takes the
 * env lock through a file-based store and hangs — like an apply that died
 * mid-work. Arguments: <store-path> <lock-name> <ttlMs>
 */
import { Effect } from "effect"
import { SqliteStateLive } from "../../src/state/sqlite.ts"
import { StateStore } from "../../src/state/store.ts"

const [path, name, ttl] = process.argv.slice(2) as [string, string, string]

await Effect.runPromise(
  Effect.gen(function* () {
    const store = yield* StateStore
    const acquired = yield* store.acquireLock(name, Number(ttl))
    if (!acquired) {
      console.log("BUSY")
      process.exit(3)
    }
    console.log("LOCKED") // signal to the test: safe to kill
    // hang «forever» — the lock will never be released, only SIGKILL
    yield* Effect.promise(() => new Promise(() => {}))
  }).pipe(Effect.provide(SqliteStateLive({ path }))),
)

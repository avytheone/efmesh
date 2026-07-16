/**
 * Помощник kill-9-теста (#7): чужой процесс, который честно берёт env-лок
 * через file-based стор и виснет — как apply, умерший посреди работы.
 * Аргументы: <путь-к-стору> <имя-лока> <ttlMs>
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
    console.log("LOCKED") // сигнал тесту: можно убивать
    // виснем «навсегда» — освобождения лока не будет, только SIGKILL
    yield* Effect.promise(() => new Promise(() => {}))
  }).pipe(Effect.provide(SqliteStateLive({ path }))),
)

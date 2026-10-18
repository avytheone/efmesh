import { compact, type CompactOptions } from "../plan/compact.ts"
import { janitorLockName, withStateLock } from "../plan/lock.ts"

/** CLI commands share a state store; raw compact stays engine-only and cooperative. */
export const compactForCli = (options: CompactOptions) =>
  compact(options).pipe(withStateLock(janitorLockName))

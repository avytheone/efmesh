/**
 * CLI surface of efmesh, split into cohesive modules under `src/cli/`:
 * `config` (config load + engine/state layers), `flags` (flag definitions,
 * their parsers, and the apply-confirmation decision), `json` (the `*ToJson`
 * wire-shape transformers + printJson), `print` (human-facing plan/data-diff
 * printers), `failure` (the single failure screen), `commands/*` (one Command
 * per file, plan+apply paired for their shared printer), and `root` (subcommand
 * assembly). This module is the module's public face — a whitelist barrel of
 * exactly what `bin.ts` and the tests consume; no `export *`.
 */
export { ConfigLoadError } from "./cli/config.ts"
export { decideApply, EXIT_AWAITING_HUMAN, isAffirmative, parseReclassify } from "./cli/flags.ts"
export {
  API_VERSION,
  applyToJson,
  graphToJson,
  janitorToJson,
  lineageToJson,
  migrateToJson,
  planToJson,
  renderToJson,
  restateToJson,
  runToJson,
  scheduleListToJson,
  statusToJson,
  withApiVersion,
} from "./cli/json.ts"
export { renderFailure, wantsTrace } from "./cli/failure.ts"
export { rootCommand } from "./cli/root.ts"

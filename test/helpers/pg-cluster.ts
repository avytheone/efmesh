import { execSync, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * A throwaway Postgres cluster for integration tests: initdb in tmp, TCP on a
 * free port, fsync off — startup ~1 s. Without Postgres binaries in PATH the
 * tests are skipped (see hasPostgres).
 */

export const hasPostgres: boolean = (() => {
  try {
    execSync("initdb --version", { stdio: "ignore" })
    execSync("pg_ctl --version", { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

export interface TestCluster {
  readonly url: string
  readonly stop: () => void
}

const freePort = async (): Promise<number> => {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data: () => {} },
  })
  const port = server.port
  server.stop(true)
  return port
}

export const startCluster = async (): Promise<TestCluster> => {
  const dir = mkdtempSync(join(tmpdir(), "efmesh-pg-"))
  const dataDir = join(dir, "data")
  const port = await freePort()

  execSync(`initdb -D '${dataDir}' -A trust -U efmesh --no-sync -E UTF8`, { stdio: "ignore" })
  const serverOptions = [
    `-c listen_addresses=127.0.0.1`,
    `-c port=${port}`,
    `-c unix_socket_directories='${dir}'`,
    `-c fsync=off`,
    `-c synchronous_commit=off`,
    `-c full_page_writes=off`,
  ].join(" ")
  const started = spawnSync(
    "pg_ctl",
    ["-D", dataDir, "-o", serverOptions, "-l", join(dir, "log"), "-w", "start"],
    { stdio: "ignore" },
  )
  if (started.status !== 0) {
    const log = (() => {
      try {
        return execSync(`cat '${join(dir, "log")}'`).toString()
      } catch {
        return "<no log>"
      }
    })()
    rmSync(dir, { recursive: true, force: true })
    throw new Error(`pg_ctl start failed:\n${log}`)
  }

  return {
    url: `postgres://efmesh@127.0.0.1:${port}/postgres`,
    stop: () => {
      spawnSync("pg_ctl", ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore" })
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

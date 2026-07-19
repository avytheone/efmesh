import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const hasDocker: boolean = (() => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

export interface MinioEndpoint {
  readonly endpoint: string
  readonly host: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly bucket: string
  readonly stop: () => void
}

const freePort = (): number => {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data: () => {} },
  })
  const port = server.port
  server.stop(true)
  return port
}

export const startMinio = async (): Promise<MinioEndpoint> => {
  const root = mkdtempSync(join(tmpdir(), "efmesh-minio-"))
  const bucket = "lake"
  mkdirSync(join(root, bucket))
  const port = freePort()
  const name = `efmesh-minio-${process.pid}-${port}`
  const accessKeyId = "efmesh"
  const secretAccessKey = "efmesh-test-secret"
  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "-d",
      "--name",
      name,
      "-p",
      `127.0.0.1:${port}:9000`,
      "-v",
      `${root}:/data`,
      "-e",
      `MINIO_ROOT_USER=${accessKeyId}`,
      "-e",
      `MINIO_ROOT_PASSWORD=${secretAccessKey}`,
      "minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e",
      "server",
      "/data",
    ],
    { stdio: "ignore" },
  )
  const endpoint = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${endpoint}/minio/health/live`)
      if (response.ok) {
        return {
          endpoint,
          host: `127.0.0.1:${port}`,
          accessKeyId,
          secretAccessKey,
          bucket,
          stop: () => {
            try {
              execFileSync("docker", ["exec", name, "chmod", "-R", "777", "/data"], {
                stdio: "ignore",
              })
              execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" })
            } finally {
              rmSync(root, { recursive: true, force: true })
            }
          },
        }
      }
    } catch {
      // container is still starting
    }
    await Bun.sleep(50)
  }
  execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" })
  rmSync(root, { recursive: true, force: true })
  throw new Error("MinIO did not become healthy")
}

import { Effect } from "effect"
import { EngineError } from "./adapter.ts"
import type { DuckDBCredential, EngineSettingValue } from "./init.ts"

export interface ObjectStoreObject {
  readonly path: string
  readonly lastModified?: string
  readonly size?: number
}

export interface ObjectStore {
  readonly list: (prefix: string) => Effect.Effect<ReadonlyArray<ObjectStoreObject>, EngineError>
  readonly readText: (path: string) => Effect.Effect<string, EngineError>
  readonly writeText: (path: string, content: string) => Effect.Effect<void, EngineError>
  readonly exists: (path: string) => Effect.Effect<boolean, EngineError>
  readonly delete: (path: string) => Effect.Effect<void, EngineError>
  readonly deletePrefix: (prefix: string) => Effect.Effect<number, EngineError>
}

interface S3Path {
  readonly bucket: string
  readonly key: string
}

const parseS3 = (path: string): S3Path => {
  const url = new URL(path)
  if (url.protocol !== "s3:" || url.hostname === "") throw new Error(`not an s3 path: ${path}`)
  return { bucket: url.hostname, key: url.pathname.replace(/^\/+/, "") }
}

const stringValue = (
  values: Readonly<Record<string, EngineSettingValue>>,
  name: string,
): string | undefined => {
  const value = values[name]
  return value === undefined ? undefined : String(value)
}

const booleanValue = (
  values: Readonly<Record<string, EngineSettingValue>>,
  name: string,
): boolean | undefined => {
  const value = values[name]
  if (value === undefined) return undefined
  return value === true || value === "true" || value === 1
}

const endpointOf = (credential: DuckDBCredential): string | undefined => {
  const endpoint = stringValue(credential.values, "ENDPOINT")
  if (endpoint === undefined) return undefined
  if (/^https?:\/\//.test(endpoint)) return endpoint
  return `${booleanValue(credential.values, "USE_SSL") === false ? "http" : "https"}://${endpoint}`
}

/**
 * The operational half of an explicit DuckDB S3 secret. DuckDB owns parquet
 * reads/writes; Bun's signed S3 client publishes manifests and removes keys.
 * Both are built from the same typed credential declaration.
 */
export const s3ObjectStore = (
  credentials: ReadonlyArray<DuckDBCredential>,
): ObjectStore | undefined => {
  const s3Credentials = credentials.filter((credential) => credential.type.toLowerCase() === "s3")
  if (s3Credentials.length === 0) return undefined

  const credentialFor = (path: string): DuckDBCredential =>
    s3Credentials
      .filter((credential) => credential.scope === undefined || path.startsWith(credential.scope))
      .sort((a, b) => (b.scope?.length ?? 0) - (a.scope?.length ?? 0))[0] ?? s3Credentials[0]!

  const clientFor = (path: string): { readonly client: Bun.S3Client; readonly key: string } => {
    const parsed = parseS3(path)
    const credential = credentialFor(path)
    const values = credential.values
    return {
      client: new Bun.S3Client({
        bucket: parsed.bucket,
        ...(stringValue(values, "KEY_ID") !== undefined
          ? { accessKeyId: stringValue(values, "KEY_ID")! }
          : {}),
        ...(stringValue(values, "SECRET") !== undefined
          ? { secretAccessKey: stringValue(values, "SECRET")! }
          : {}),
        ...(stringValue(values, "SESSION_TOKEN") !== undefined
          ? { sessionToken: stringValue(values, "SESSION_TOKEN")! }
          : {}),
        ...(stringValue(values, "REGION") !== undefined
          ? { region: stringValue(values, "REGION")! }
          : {}),
        ...(endpointOf(credential) !== undefined ? { endpoint: endpointOf(credential)! } : {}),
      }),
      key: parsed.key,
    }
  }

  const redacted = <A>(operation: string, path: string, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: () =>
        new EngineError({
          sql: `<object-store ${operation} ${path}>`,
          cause: "object-store operation failed (details redacted)",
        }),
    })

  const list: ObjectStore["list"] = (prefix) => {
    const { client, key } = clientFor(prefix)
    return Effect.gen(function* () {
      const objects: Array<ObjectStoreObject> = []
      let continuationToken: string | undefined
      do {
        const page = yield* redacted("list", prefix, () =>
          client.list({
            prefix: key,
            ...(continuationToken !== undefined ? { continuationToken } : {}),
          }),
        )
        for (const item of page.contents ?? []) {
          objects.push({
            path: `s3://${parseS3(prefix).bucket}/${item.key}`,
            ...(item.lastModified !== undefined ? { lastModified: item.lastModified } : {}),
            ...(item.size !== undefined ? { size: item.size } : {}),
          })
        }
        continuationToken = page.nextContinuationToken
      } while (continuationToken !== undefined)
      return objects
    })
  }

  return {
    list,
    readText: (path) => {
      const { client, key } = clientFor(path)
      return redacted("read", path, () => client.file(key).text())
    },
    writeText: (path, content) => {
      const { client, key } = clientFor(path)
      return redacted("write", path, () =>
        client.write(key, content, { type: "application/json" }),
      ).pipe(Effect.asVoid)
    },
    exists: (path) => {
      const { client, key } = clientFor(path)
      return redacted("exists", path, () => client.exists(key))
    },
    delete: (path) => {
      const { client, key } = clientFor(path)
      return redacted("delete", path, () => client.delete(key))
    },
    deletePrefix: (prefix) =>
      Effect.gen(function* () {
        const objects = yield* list(prefix)
        yield* Effect.forEach(
          objects,
          (object) => {
            const { client, key } = clientFor(object.path)
            return redacted("delete", object.path, () => client.delete(key))
          },
          { concurrency: 8, discard: true },
        )
        return objects.length
      }),
  }
}

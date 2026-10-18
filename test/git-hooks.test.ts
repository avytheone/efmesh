import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  renameSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"

const source = resolve(import.meta.dir, "..")
const root = mkdtempSync(join(source, "efmesh-hooks-test-"))
const clone = join(root, "clone with spaces")
const worktree = join(root, "linked worktree")
const env = { ...process.env, CI: "", LEFTHOOK: "", LEFTHOOK_BIN: "", LEFTHOOK_EXCLUDE: "" }
const run = (cwd: string, args: string[], extra = {}) => {
  const result = spawnSync(args[0]!, args.slice(1), {
    cwd,
    env: { ...env, ...extra },
    encoding: "utf8",
  })
  return { status: result.status, output: result.stdout + result.stderr }
}
const git = (cwd: string, ...args: string[]) => run(cwd, ["git", ...args])
const write = (cwd: string, name: string, text: string) => writeFileSync(join(cwd, name), text)

mkdirSync(clone)
expect(git(clone, "init").status).toBe(0)
expect(git(clone, "config", "user.name", "Hook Test").status).toBe(0)
expect(git(clone, "config", "user.email", "hooks@example.invalid").status).toBe(0)
for (const path of [".githooks", "scripts", "lefthook.yml", "biome.jsonc"]) {
  cpSync(join(source, path), join(clone, path), { recursive: true })
}
write(clone, "tsconfig.json", '{"compilerOptions":{"strict":true},"include":["src"]}\n')
mkdirSync(join(clone, "src"))
write(clone, "src/probe.ts", "export const probe = 1\n")
expect(git(clone, "add", ".").status).toBe(0)
expect(git(clone, "commit", "-m", "Fixture").status).toBe(0)
expect(run(clone, ["sh", "scripts/install-hooks.sh"]).status).toBe(0)
expect(git(clone, "worktree", "add", "--detach", worktree, "HEAD").status).toBe(0)

afterAll(() => rmSync(root, { recursive: true, force: true }))

for (const cwd of [clone, worktree]) {
  describe(cwd === clone ? "clone hooks" : "worktree hooks", () => {
    test("missing local lefthook refuses commits and pushes; opt-outs are explicit", () => {
      const result = git(cwd, "commit", "--allow-empty", "-m", "Must refuse")
      expect(result.status).not.toBe(0)
      expect(result.output).toContain("local lefthook is missing")
      const push = run(cwd, ["git", "hook", "run", "pre-push"])
      expect(push.status).not.toBe(0)
      expect(push.output).toContain("local lefthook is missing")
      for (const [extra, message] of [
        [{ LEFTHOOK: "0" }, "explicitly disabled (LEFTHOOK=0)"],
        [{ CI: "true" }, "skipped in CI"],
      ] as const) {
        for (const hook of ["pre-commit", "pre-push"]) {
          const skipped = run(cwd, ["git", "hook", "run", hook], extra)
          expect(skipped.status).toBe(0)
          expect(skipped.output).toContain(message)
        }
      }
    })

    test("local tools run all commit gates and reject invalid staged files", () => {
      symlinkSync(join(source, "node_modules"), join(cwd, "node_modules"), "dir")
      for (const [contents, gate] of [
        ['export const probe: number = "wrong"\n', "typecheck"],
        ["export const probe = /[]/\n", "biome"],
        // cyrillic-ok: deliberate language-gate probe
        ['export const probe = "Привет"\n', "no-cyrillic"],
      ]) {
        write(cwd, "src/probe.ts", contents!)
        expect(git(cwd, "add", "src/probe.ts").status).toBe(0)
        const rejected = git(cwd, "commit", "-m", "Must reject")
        expect(rejected.status).not.toBe(0)
        expect(rejected.output).toContain(gate!)
      }
      write(cwd, "src/probe.ts", "export const probe = 2\n")
      expect(git(cwd, "add", "src/probe.ts").status).toBe(0)
      const accepted = git(cwd, "commit", "-m", "Valid change")
      expect(accepted.status).toBe(0)
      for (const gate of ["typecheck", "biome", "no-cyrillic"]) {
        expect(accepted.output).toContain(gate)
      }
    }, 30_000)
    test("pre-push runs the test command and preserves its failure", () => {
      const bin = join(cwd, "test-bin")
      mkdirSync(bin)
      const bun = join(bin, "bun")
      for (const status of [23, 0]) {
        writeFileSync(bun, `#!/bin/sh\necho "hook-test-command:$*"\nexit ${status}\n`)
        chmodSync(bun, 0o755)
        const pushed = run(cwd, ["git", "hook", "run", "pre-push"], {
          PATH: `${bin}:${process.env.PATH}`,
        })
        expect(pushed.output).toContain("hook-test-command:test")
        expect(pushed.status === 0).toBe(status === 0)
      }
    })
  })
}

test("prepare refuses to overwrite a custom hook directory", () => {
  expect(git(clone, "config", "core.hooksPath", "custom-hooks").status).toBe(0)
  const result = run(clone, ["sh", "scripts/install-hooks.sh"])
  expect(result.status).not.toBe(0)
  expect(result.output).toContain("refusing to replace")
  expect(git(clone, "config", "--get", "core.hooksPath").output.trim()).toBe("custom-hooks")
})

test("shared hooks fail when an older worktree lacks the runner", () => {
  expect(git(clone, "config", "--unset", "core.hooksPath").status).toBe(0)
  renameSync(join(worktree, "scripts/run-hook.sh"), join(worktree, "scripts/run-hook.saved"))
  for (const hook of ["pre-commit", "pre-push"]) {
    const result = run(worktree, ["git", "hook", "run", hook])
    expect(result.status).not.toBe(0)
    expect(result.output).toContain("run-hook.sh")
  }
})

test("prepare preserves custom hooks", () => {
  const hook = join(clone, ".git/hooks/pre-commit")
  writeFileSync(hook, "#!/bin/sh\necho custom hook\n")
  const result = run(clone, ["sh", "scripts/install-hooks.sh"])
  expect(result.status).not.toBe(0)
  expect(result.output).toContain("refusing to replace custom hook")
})

for (const hook of ["pre-commit", "pre-push"]) {
  for (const dangling of [false, true]) {
    test(`prepare preserves ${hook} symlinks (${dangling ? "dangling" : "existing target"}) without partial writes`, () => {
      const fixture = join(root, `symlink-${hook}-${dangling}`)
      mkdirSync(fixture)
      expect(git(fixture, "init").status).toBe(0)
      for (const path of [".githooks", "scripts"]) {
        cpSync(join(source, path), join(fixture, path), { recursive: true })
      }
      const hooks = join(fixture, ".git/hooks")
      for (const name of ["pre-commit", "pre-push"]) {
        writeFileSync(join(hooks, name), `#!/bin/sh\n# call_lefthook: original ${name}\n`)
        chmodSync(join(hooks, name), 0o750)
      }
      // The simulated shared target lives outside the fixture repo, inside our temp root.
      const target = join(root, `shared-${hook}-${dangling}`)
      const original = "#!/bin/sh\n# call_lefthook: shared hook\n"
      if (!dangling) {
        writeFileSync(target, original)
        chmodSync(target, 0o640)
      }
      const destination = join(hooks, hook)
      rmSync(destination)
      symlinkSync(target, destination)
      const sibling = join(hooks, hook === "pre-commit" ? "pre-push" : "pre-commit")
      const siblingContents = readFileSync(sibling, "utf8")
      const siblingMode = lstatSync(sibling).mode
      const result = run(fixture, ["sh", "scripts/install-hooks.sh"])
      expect(lstatSync(destination).isSymbolicLink()).toBe(true)
      expect(readlinkSync(destination)).toBe(target)
      expect(existsSync(target)).toBe(!dangling)
      if (!dangling) {
        expect(readFileSync(target, "utf8")).toBe(original)
        expect(lstatSync(target).mode & 0o777).toBe(0o640)
      }
      expect(readFileSync(sibling, "utf8")).toBe(siblingContents)
      expect(lstatSync(sibling).mode).toBe(siblingMode)
      expect(result.status).not.toBe(0)
      expect(result.output).toContain("refusing to replace symlink hook")
    })
  }
}

#!/bin/sh
set -eu
hook=$1
shift
if [ "${LEFTHOOK:-}" = "0" ]; then
  echo "efmesh: $hook explicitly disabled (LEFTHOOK=0)" >&2
  exit 0
fi
if [ -n "${CI:-}" ]; then
  echo "efmesh: $hook skipped in CI; run check and test in the workflow" >&2
  exit 0
fi
root=$(git rev-parse --show-toplevel)
cd "$root"
if [ ! -x node_modules/.bin/lefthook ]; then
  echo "efmesh: $hook refused: local lefthook is missing; run bun install --frozen-lockfile in this checkout/worktree" >&2
  exit 1
fi
# Child tools and lefthook's re-staging must resolve this checkout's dependencies.
PATH="$root/node_modules/.bin:$PATH"
export PATH
exec "$root/node_modules/.bin/lefthook" run "$hook" "$@"

#!/bin/sh
set -eu
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "efmesh: hooks not installed outside a Git checkout" >&2
  exit 0
fi
current=$(git config --get core.hooksPath || true)
if [ -n "$current" ]; then
  echo "efmesh: refusing to replace core.hooksPath=$current; reconcile it with the repository hooks before installing" >&2
  exit 1
fi
root=$(git rev-parse --show-toplevel)
hooks=$(git rev-parse --git-path hooks)
# Validate both targets before replacing either; preserve unrelated custom hooks.
for hook in pre-commit pre-push; do
  target="$hooks/$hook"
  if [ -e "$target" ] && ! grep -q -e 'efmesh hook entry point' -e 'call_lefthook' "$target"; then
    echo "efmesh: refusing to replace custom hook $target" >&2
    exit 1
  fi
done
mkdir -p "$hooks"
for hook in pre-commit pre-push; do
  cp "$root/.githooks/$hook" "$hooks/$hook"
  chmod +x "$hooks/$hook"
done
echo "efmesh: installed shared hook entry points for this clone and its worktrees"

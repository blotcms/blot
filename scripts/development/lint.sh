#!/usr/bin/env bash
# Runs ESLint and Prettier at the versions package.json pins. They are
# installed once into the git directory (shared by every worktree), or into
# $LINT_TOOLS_DIR when set (CI), so this works without the repository's
# node_modules, which normally only exist inside the Docker image.
#
#   lint.sh check            What CI runs: ESLint and prettier --check over
#                            the whole repository
#   lint.sh fix [files...]   Format with Prettier, then ESLint --fix. Every
#                            JavaScript file when no files are given
#   lint.sh staged           The pre-commit hook (.githooks/pre-commit): checks
#                            the staged JavaScript files
#   lint.sh claude-hook      Claude Code's PostToolUse hook
#                            (.claude/settings.json): formats and lints the
#                            file an edit touched, reads the hook JSON on stdin
#   lint.sh eslint|prettier [args...]
#
# Install the git hook in a checkout with:
#   git config core.hooksPath .githooks
set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"

pkgs=$(node -p 'const d = require("./package.json").devDependencies; ["eslint", "@eslint/js", "globals", "prettier"].map((n) => n + "@" + d[n]).join(" ")')

if [ -n "${LINT_TOOLS_DIR:-}" ]; then
  dir=$LINT_TOOLS_DIR
else
  common=$(cd "$(git rev-parse --git-common-dir)" && pwd)
  dir="$common/lint-tools/$(echo "$pkgs" | cksum | cut -d' ' -f1)"
fi

if [ ! -d "$dir/node_modules" ]; then
  # Installed beside the target and moved into place, so two worktrees
  # installing at once can't leave a half-installed directory behind
  tmp="$dir.tmp.$$"
  # shellcheck disable=SC2086
  npm install --prefix "$tmp" --no-save --no-audit --no-fund --loglevel=error $pkgs >&2
  mkdir -p "$dir"
  mv "$tmp/node_modules" "$dir/node_modules" 2>/dev/null || true
  rm -rf "$tmp"
fi

# eslint.config.js requires @eslint/js and globals
export NODE_PATH="$dir/node_modules"

eslint() { node "$dir/node_modules/eslint/bin/eslint.js" "$@"; }
prettier() { node "$dir/node_modules/prettier/bin/prettier.cjs" "$@"; }

js_files() { grep -E '\.(c|m)?js$' || true; }

case "${1:-}" in
  check)
    status=0
    eslint . || status=1
    prettier --check --log-level=warn "**/*.{js,mjs,cjs}" || status=1
    exit $status
    ;;

  fix)
    shift
    if [ $# -eq 0 ]; then
      prettier --write --log-level=warn "**/*.{js,mjs,cjs}"
      eslint --fix .
    else
      prettier --write --log-level=warn --ignore-unknown "$@"
      eslint --fix --no-warn-ignored "$@"
    fi
    ;;

  staged)
    files=()
    while IFS= read -r file; do files+=("$file"); done < <(git diff --cached --name-only --diff-filter=ACMR | js_files)
    [ ${#files[@]} -eq 0 ] && exit 0
    status=0
    eslint --no-warn-ignored "${files[@]}" || status=1
    prettier --check --log-level=warn "${files[@]}" || status=1
    if [ $status -ne 0 ]; then
      echo >&2
      echo "Fix with: scripts/development/lint.sh fix ${files[*]}" >&2
      echo "(or commit with --no-verify to skip this check)" >&2
    fi
    exit $status
    ;;

  claude-hook)
    file=$(node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { try { console.log(JSON.parse(s).tool_input.file_path || ""); } catch (e) { console.log(""); } })')
    case "$file" in
      "$root"/*) ;;
      *) exit 0 ;;
    esac
    echo "$file" | js_files | grep -q . || exit 0
    [ -f "$file" ] || exit 0
    prettier --write --log-level=warn "$file" >&2 || true
    # Exit status 2 shows Claude what ESLint reported
    if ! output=$(eslint --fix --no-color --no-warn-ignored "$file" 2>&1); then
      echo "$output" >&2
      exit 2
    fi
    ;;

  eslint)
    shift
    eslint "$@"
    ;;

  prettier)
    shift
    prettier "$@"
    ;;

  *)
    sed -n '2,19p' "$0" >&2
    exit 1
    ;;
esac

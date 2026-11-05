#!/bin/bash
# Usage: offsite-restore-test.sh [--keep] [--dir <parent>] <blogID> [<path>]
#        offsite-restore-test.sh --git [--sample <n>] [--keep] [--dir <parent>] [<blogID>...]
# Restores one blog's folder (or <path> under the blog: git, _thumbnails, ...)
# from the B2 copy that offsite-sync.sh keeps into a scratch directory, then
# compares it file by file with the storage bucket, reading both in full
# (rclone check --download), and prints a summary. Exits 0 only if every file
# matches. Run it on the host as ec2-user, which has the remotes' keys
# (offsite-lib.sh).
#
# Read-only against S3, B2 and Redis: it lists and downloads, and reads the
# time of the last sync with a GET. A file changed or deleted in the bucket
# since that sync differs from its copy, as expected; the summary lists each
# difference with the bucket's time for it, to tell those apart.
#
#   --dir <parent>  where to make the scratch directory (default $TMPDIR or
#                   /tmp; the instance store, /var/instance-ssd, has more room)
#   --keep          leave the restored files there instead of deleting them
#
# With --git it checks git repositories instead: it restores <blogID>/git/ of
# the blogs named, of the gittest blog (handle:gittest in Redis) and of
# --sample <n> (default 5) git blogs picked at random from B2, into
# <scratch>/repos/<blogID>/git/, and runs the store checker in the blot-blue unit on
# them: `node scripts/git/check-store.js --dir <scratch>/repos --all-blogs
# --deep --scratch <scratch>/scratch` (blotcms/blot#2544),
# as uid 1000. Exit 0 is a pass, 1 means findings. The scratch directory is
# made under /var/instance-ssd/tmp unless --dir says otherwise, since the unit
# must see it at the same path (the app's tmp directory is bound in). Without
# the checker in the unit's image, the step is skipped with a message (exit 0).
# A manifest is only ever copied after its packs (offsite-sync.sh), so a
# finding is real, except possibly on a blog pushed to since the last sync
# started: run it again after the next sync before counting it.
#
# BLOT_ROOT prefixes paths, for the tests. Written to run under sh as well as
# bash, for the tests.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=offsite-lib.sh
. "$HERE/offsite-lib.sh"

usage() {
  echo "usage: offsite-restore-test.sh [--keep] [--dir <parent>] <blogID> [<path>]" >&2
  echo "       offsite-restore-test.sh --git [--sample <n>] [--keep] [--dir <parent>] [<blogID>...]" >&2
  exit 2
}
blog_id() { # blog_id <arg>: refuses anything but a blog ID
  case "$1" in blog_*/* | blog_*..*) ;; blog_?*) return 0 ;; esac
  echo "not a blog ID: $1" >&2; exit 2
}

KEEP=
GIT=
SAMPLE=5
PARENT=
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1; shift ;;
    --git) GIT=1; shift ;;
    --sample) [ $# -ge 2 ] || usage; case "$2" in '' | *[!0-9]*) usage ;; esac; SAMPLE=$2; shift 2 ;;
    --dir) [ $# -ge 2 ] || usage; PARENT=$2; shift 2 ;;
    -*) usage ;;
    *) break ;;
  esac
done

FLAGS="--fast-list --transfers 4 --checkers 8 --stats 0 --log-level NOTICE"
UNIT=${BLOT_UNIT:-blot-blue}
CHECKER=scripts/git/check-store.js

# ---- --git ----------------------------------------------------------------
if [ -n "$GIT" ]; then
  for blog; do blog_id "$blog"; done
  [ -n "$(offsite_bucket)" ] || { echo "no bucket in $OFFSITE_BUCKET_FILE: offsite is off on this host" >&2; exit 1; }
  if ! docker exec -u 1000 "$UNIT" test -f "$CHECKER" 2> /dev/null; then
    echo "Skipped: $UNIT has no $CHECKER (not in this image yet), so the git restore cannot be checked"
    exit 0
  fi
  [ -n "$PARENT" ] || PARENT=$ROOT/var/instance-ssd/tmp
  WORK=$(mktemp -d "$PARENT/blot-offsite-restore.XXXXXX")
  if [ -n "$KEEP" ]; then trap 'echo "kept $WORK"' EXIT; else trap 'rm -rf "$WORK"' EXIT; fi
  chmod 755 "$WORK"
  # The checker walks <root>/blog_*/git/, and clones into --scratch for --deep:
  # both on the instance store, where the unit sees them at the same paths.
  mkdir -p "$WORK/repos" "$WORK/scratch"
  setup_remotes > "$WORK/.setup" || { cat "$WORK/.setup" >&2; exit 1; }
  rm -f "$WORK/.setup"

  for blog; do echo "$blog"; done > "$WORK/.blogs"
  gittest=$(redis6-cli GET handle:gittest 2> /dev/null | tr -d '\r') || gittest=
  case "$gittest" in blog_?*) echo "$gittest" >> "$WORK/.blogs" ;; *) echo "No gittest blog in Redis (handle:gittest)" ;; esac
  if [ "$SAMPLE" -gt 0 ]; then
    # Random blogs from B2's top level, keeping those with a git/ directory:
    # a listing each, so at most 20 per blog wanted.
    # shellcheck disable=SC2086
    rclone lsf --dirs-only --max-depth 1 "$OFFSITE_ROOT" 2> /dev/null |
      awk 'BEGIN { srand() } { print rand() "\t" $0 }' | sort | cut -f2- | sed 's|/$||' |
      head -n $((SAMPLE * 20)) > "$WORK/.candidates" || true
    found=0
    while IFS= read -r blog && [ "$found" -lt "$SAMPLE" ]; do
      if rclone lsf --dirs-only --max-depth 1 "$OFFSITE_ROOT/$blog" 2> /dev/null | grep -qx "git/"; then
        echo "$blog" >> "$WORK/.blogs"
        found=$((found + 1))
      fi
    done < "$WORK/.candidates"
    echo "Sampled $found git blogs from B2"
  fi
  sort -u "$WORK/.blogs" > "$WORK/.list"
  [ -s "$WORK/.list" ] || { echo "No git blogs to check" >&2; exit 1; }

  echo "Last recorded sync: $(redis6-cli GET "$OFFSITE_REDIS_KEY" 2> /dev/null | tr -d '\r' || true)"
  while IFS= read -r blog; do
    echo "Restoring $blog/git from B2"
    # shellcheck disable=SC2086
    rclone copy $FLAGS "$OFFSITE_ROOT/$blog/git" "$WORK/repos/$blog/git" ||
      { echo "the restore of $blog/git from B2 failed" >&2; exit 1; }
  done < "$WORK/.list"
  rm -f "$WORK/.blogs" "$WORK/.list" "$WORK/.candidates"
  chmod -R a+rX "$WORK"

  echo "Checking $(ls "$WORK/repos" | wc -l | tr -d ' ') repositories with $CHECKER in $UNIT"
  status=0
  docker exec -u 1000 "$UNIT" node "$CHECKER" --dir "$WORK/repos" --all-blogs --deep --scratch "$WORK/scratch" || status=$?
  case "$status" in
    0) echo "OK: the restored repositories pass the store check" ;;
    1) echo "FAILED: the store check has findings (above). One on a blog pushed to since the last sync started may only be that push: rerun after the next sync" ;;
    2) echo "FAILED: the store check refused its arguments (exit 2): has its usage changed?" ;;
    *) echo "FAILED: the store check exited $status" ;;
  esac
  exit "$status"
fi

# ---- one blog's folder (or another path) ------------------------------------
[ -n "$PARENT" ] || PARENT=${TMPDIR:-/tmp}
[ $# -ge 1 ] && [ $# -le 2 ] || usage
BLOG=$1
SUBPATH=${2:-folder}
blog_id "$BLOG"
case "$SUBPATH" in /* | *..*) echo "the path must be relative, without ..: $SUBPATH" >&2; exit 2 ;; esac
SUBPATH=${SUBPATH%/}

[ -n "$(offsite_bucket)" ] || { echo "no bucket in $OFFSITE_BUCKET_FILE: offsite is off on this host" >&2; exit 1; }
WORK=$(mktemp -d "$PARENT/blot-offsite-restore.XXXXXX")
if [ -n "$KEEP" ]; then trap 'echo "kept $WORK"' EXIT; else trap 'rm -rf "$WORK"' EXIT; fi
setup_remotes > "$WORK/setup" || { cat "$WORK/setup" >&2; exit 1; }

SOURCE="storage:$STORAGE_BUCKET/$BLOG/$SUBPATH"
COPY="$OFFSITE_ROOT/$BLOG/$SUBPATH"

last=$(redis6-cli GET "$OFFSITE_REDIS_KEY" 2> /dev/null | tr -d '\r') || last=
echo "Last recorded sync: ${last:-none} (time, objects, bytes)"
echo "Restoring $BLOG/$SUBPATH from B2 into $WORK/restored"

start=$(date +%s)
# shellcheck disable=SC2086
rclone copy $FLAGS "$COPY" "$WORK/restored" || { echo "the restore from B2 failed" >&2; exit 1; }
mkdir -p "$WORK/restored"
size=$(rclone size --json "$WORK/restored" 2> /dev/null) || size=
echo "Restored $(echo "$size" | sed -n 's/.*"count": *\([0-9]*\).*/\1/p') files," \
  "$(echo "$size" | sed -n 's/.*"bytes": *\([0-9]*\).*/\1/p') bytes, in $(( $(date +%s) - start ))s"

# Byte for byte: the bucket's MD5 ETags and B2's SHA-1s have nothing in
# common, so both sides are read. rclone check exits 1 on any difference.
# shellcheck disable=SC2086
rclone check $FLAGS --download --combined "$WORK/check" "$SOURCE" "$WORK/restored" 2> "$WORK/check-log" || true
if [ ! -s "$WORK/check" ]; then
  echo "Nothing was compared: is $BLOG/$SUBPATH in the bucket? rclone said:" >&2
  head -n 20 "$WORK/check-log" >&2
  exit 1
fi

count() { grep -c "^$1 " "$WORK/check" || true; }
same=$(count =)
differ=$(count '\*')
missing=$(count -)
extra=$(count +)
errors=$(count !)

echo
echo "Compared with the bucket:"
echo "  $same match"
echo "  $differ differ"
echo "  $missing in the bucket but not in the copy"
echo "  $extra in the copy but no longer in the bucket"
echo "  $errors could not be compared"

if [ "$same" -gt 0 ] && [ $((differ + missing + extra + errors)) = 0 ]; then
  echo "OK: the copy of $BLOG/$SUBPATH matches the bucket"
  exit 0
fi

# The bucket's time for each difference (the first 20): one changed after the
# last sync is expected to differ.
grep -v "^= " "$WORK/check" | head -n 20 > "$WORK/differences"
cut -c3- "$WORK/differences" > "$WORK/paths"
# shellcheck disable=SC2086
rclone lsf $FLAGS --use-server-modtime --files-only -R --format tp --separator '  ' \
  --files-from-raw "$WORK/paths" "$SOURCE" > "$WORK/times" 2> /dev/null || true
echo
echo "Differences (= match, * differ, - only in the bucket, + only in the copy, ! error), with the bucket's time:"
# lsf prints "<time, 19 characters>  <path>".
while IFS= read -r line; do
  time=$(awk -v p="${line#??}" 'substr($0, 22) == p { print substr($0, 1, 19); exit }' "$WORK/times")
  echo "  $line${time:+  (bucket: $time)}"
done < "$WORK/differences"
[ "$(grep -vc "^= " "$WORK/check" || true)" -le 20 ] || echo "  ... and more: rerun with --keep and read $WORK/check"
[ "$same" -gt 0 ] || echo "Nothing matched: is $BLOG/$SUBPATH in the bucket, and has it been synced?"
echo "FAILED: compare the times above with the last recorded sync"
exit 1

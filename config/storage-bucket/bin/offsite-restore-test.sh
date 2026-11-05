#!/bin/bash
# Usage: offsite-restore-test.sh [--keep] [--dir <parent>] <blogID> [<path>]
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
# BLOT_ROOT prefixes paths, for the tests. Written to run under sh as well as
# bash, for the tests.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=offsite-lib.sh
. "$HERE/offsite-lib.sh"

usage() { echo "usage: offsite-restore-test.sh [--keep] [--dir <parent>] <blogID> [<path>]" >&2; exit 2; }

KEEP=
PARENT=${TMPDIR:-/tmp}
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1; shift ;;
    --dir) [ $# -ge 2 ] || usage; PARENT=$2; shift 2 ;;
    -*) usage ;;
    *) break ;;
  esac
done
[ $# -ge 1 ] && [ $# -le 2 ] || usage
BLOG=$1
SUBPATH=${2:-folder}
case "$BLOG" in blog_*/* | blog_*..*) echo "not a blog ID: $BLOG" >&2; exit 2 ;; blog_?*) ;; *) echo "not a blog ID: $BLOG" >&2; exit 2 ;; esac
case "$SUBPATH" in /* | *..*) echo "the path must be relative, without ..: $SUBPATH" >&2; exit 2 ;; esac
SUBPATH=${SUBPATH%/}

[ -n "$(offsite_bucket)" ] || { echo "no bucket in $OFFSITE_BUCKET_FILE: offsite is off on this host" >&2; exit 1; }
WORK=$(mktemp -d "$PARENT/blot-offsite-restore.XXXXXX")
if [ -n "$KEEP" ]; then trap 'echo "kept $WORK"' EXIT; else trap 'rm -rf "$WORK"' EXIT; fi
setup_remotes > "$WORK/setup" || { cat "$WORK/setup" >&2; exit 1; }

SOURCE="storage:$STORAGE_BUCKET/$BLOG/$SUBPATH"
COPY="$OFFSITE_ROOT/$BLOG/$SUBPATH"
FLAGS="--fast-list --transfers 4 --checkers 8 --stats 0 --log-level NOTICE"

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

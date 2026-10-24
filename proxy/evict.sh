#!/bin/sh
#
# Keeps the disk cache (proxy/config/diskcache.lua) within its budget. Run
# hourly by worker 0 of every proxy container (diskcache:start); the flock
# lets only one of the containers sharing the cache sweep at a time.
#
#   diskcache-evict <cache directory> <max bytes> <max filesystem use %>
#
# 1. Empties .trash, in case a purge's background removal died.
# 2. Lists the cache once, then deletes:
#    - .tmp files untouched for an hour: fills a dead worker left;
#    - entries with no metadata, an hour old: a fill or eviction that
#      stopped half way;
#    - brotli copies whose body is gone, an hour old: a compression that
#      finished after its entry was refilled.
# 3. If the cache is over <max bytes>, or the filesystem over <max use %>,
#    deletes whole entries (the .meta and every body of a key), least
#    recently read first, until it is 10% under the budget or 5 points under
#    the filesystem limit. "Recently read" is the .meta file's atime: every
#    hit reads it, and relatime updates it about once a day, which is enough
#    to tell a page read this week from one not read for months. Sizes are
#    disk blocks, as df counts them.
#
# Purges rename host directories away while the walk runs, so find's errors
# about vanished files are expected and ignored. Deleting an entry while a
# hit is serving it is safe: a hit that finds its body gone falls through to
# a fill.
#
# Needs GNU find (-printf), from the findutils package.

set -eu

DIR=$1
MAX_BYTES=$2
FS_MAX=$3

[ -d "$DIR" ] || exit 0

exec 9>"$DIR/.evict.lock"

if ! flock -n 9; then
  echo "evict: another sweep is running"
  exit 0
fi

started=$(date +%s)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if [ -d "$DIR/.trash" ]; then
  find "$DIR/.trash" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
fi

# "<atime> <mtime> <bytes> <path>" for every file under <a>/<bc>/<host>/,
# sorted by path so a key's files (<key>.meta, <key>.<id>, <key>.<id>.br)
# are adjacent
find "$DIR" -maxdepth 5 -name .trash -prune -o -type f -path "$DIR/?/??/*/*" \
  -printf '%A@ %T@ %b %p\n' 2>/dev/null | LC_ALL=C sort -k4,4 > "$work/files" || true

# Writes the paths to delete to rm, and "<atime> <bytes> <key path>" for each
# entry to keys
awk -v before="$((started - 3600))" -v rm="$work/rm" -v keys="$work/keys" '
  function flush(  i, f) {
    if (n == 0) return
    if (meta == "") {
      if (newest < before) for (i = 1; i <= n; i++) print path[i] > rm
    } else {
      print atime, bytes, key > keys
      for (i = 1; i <= n; i++) {
        f = path[i]
        if (f ~ /\.br$/ && !(substr(f, 1, length(f) - 3) in present) && mtime[i] < before) print f > rm
      }
    }
    n = 0; bytes = 0; newest = 0; meta = ""; split("", present)
  }
  {
    f = $4
    if (f ~ /\/\.tmp\//) { if ($2 < before) print f > rm; next }
    slash = match(f, /[^\/]*$/)
    name = substr(f, slash)
    k = substr(f, 1, slash - 1) substr(name, 1, index(name, ".") - 1)
    if (k != key) { flush(); key = k }
    n++; path[n] = f; mtime[n] = $2; present[f] = 1
    bytes += $3 * 512
    if ($2 > newest) newest = $2
    if (name ~ /\.meta$/) { meta = f; atime = $1 }
  }
  END { flush(); close(rm); close(keys) }
' "$work/files"
touch "$work/rm" "$work/keys"

# host and file names are [A-Za-z0-9.-], so plain xargs is safe
deleted=$(wc -l < "$work/rm")
xargs -r rm -f -- < "$work/rm"

total=$(awk '{ sum += $2 } END { printf "%.0f", sum }' "$work/keys")
entries=$(wc -l < "$work/keys")

# Bytes to free: down to 90% of the budget, and down to FS_MAX - 5 percent
# of the filesystem
need=$(awk -v total="$total" -v max="$MAX_BYTES" 'BEGIN { n = total - max * 0.9; printf "%.0f", (total > max && n > 0) ? n : 0 }')

set -- $(df -Pk "$DIR" | awk 'NR == 2 { print $2, $3 }')
fs_need=$(awk -v size="$(($1 * 1024))" -v used="$(($2 * 1024))" -v max="$FS_MAX" 'BEGIN { n = used - size * (max - 5) / 100; printf "%.0f", (used > size * max / 100 && n > 0) ? n : 0 }')

[ "$fs_need" -gt "$need" ] && need=$fs_need

evicted=0
freed=0

if [ "$need" -gt 0 ]; then
  sort -n -k1,1 "$work/keys" | awk -v need="$need" '
    freed >= need { exit }
    { freed += $2; print $3 }
    END { printf "%.0f\n", freed > "/dev/stderr" }
  ' > "$work/victims" 2> "$work/freed"

  evicted=$(wc -l < "$work/victims")
  freed=$(cat "$work/freed")

  # the metadata first, so no new hit finds a body that is about to go
  xargs -r sh -c 'for key; do rm -f -- "$key.meta" "$key".*; done' sh < "$work/victims"
fi

echo "evict: entries=$entries bytes=$total deleted=$deleted evicted=$evicted freed=$freed seconds=$(($(date +%s) - started))"

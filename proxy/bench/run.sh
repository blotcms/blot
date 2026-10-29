#!/usr/bin/env bash
# Benchmark the blog cache implementations against a stub upstream: nginx
# proxy_cache (proxy/ at BASE_REF) vs the disk cache (proxy/ in the working
# tree). See README.md.
#
#   bash proxy/bench/run.sh                 # build both images, run, write results.md
#   SKIP_BUILD=1 bash proxy/bench/run.sh    # reuse blot-proxy:bench-* images
#   BASE_REF=v1.2 bash proxy/bench/run.sh   # baseline from another ref
#   ONLY='identity' bash proxy/bench/run.sh # only the cases whose name matches
#   DURATION=30s CONNS=64 THREADS=4 bash proxy/bench/run.sh
set -euo pipefail

cd "$(dirname "$0")/../.."   # repo root, so the build paths below work from anywhere
ROOT=$(pwd)
BENCH="$ROOT/proxy/bench"

DURATION=${DURATION:-20s}
CONNS=${CONNS:-64}
THREADS=${THREADS:-4}
SKIP_BUILD=${SKIP_BUILD:-0}
BASE_REF=${BASE_REF:-origin/master}
ONLY=${ONLY:-.}   # run only the cases whose name matches this regex
WRK_IMAGE=blot-bench-wrk:alpine3.20

# The proxy gets 2 CPUs, or all of them if Docker has fewer (it refuses more)
NCPU=$(docker info --format '{{.NCPU}}')
CPUS=${PROXY_CPUS:-2}
if [ "$CPUS" -gt "$NCPU" ]; then CPUS=$NCPU; fi

NET=blot-bench-net
REDIS=blot-bench-redis
STUB=blot-bench-stub
PROXY=blot-bench-proxy
WRK=blot-bench-wrk
WORK=$(mktemp -d)
RESULTS="$WORK/results.tsv"
: > "$RESULTS"
: > "$WORK/brotli.tsv"

cleanup() {
  docker rm -f "$PROXY" "$WRK" "$STUB" "$REDIS" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---- images ---------------------------------------------------------------

# Render the config of the proxy/ tree under $1, drop the per-host rate limit
# from the GENERATED copy only (hostlimit is per Host header whatever the
# client IP, so the whitelist below does not exempt it; and burst=30 means at
# most 30 requests in the same millisecond, which a single blog.test would
# exceed at ~30k req/s, so raising the rate is not enough), then bake the
# image. proxy/config is not touched. The tree renders with its own
# proxy/build and proxy/config; only mustache and fs-extra come from here.
build_image() { # tree tag source-description
  local tree=$1 tag=$2
  NODE_PATH="$tree/app:$DEPS:${NODE_PATH:-}" FETCH_CDN_IPS=false BLOT_HOST=example.com \
    bash "$tree/proxy/build/build.sh" --skip-confirmation >/dev/null
  sed -i.bak '/limit_req zone=hostlimit burst=30;/d' "$tree/proxy/build/data/latest/openresty.conf"
  rm -f "$tree/proxy/build/data/latest/openresty.conf.bak"
  if grep -q 'limit_req zone=hostlimit burst=30;' "$tree/proxy/build/data/latest/openresty.conf"; then echo "hostlimit still present" >&2; exit 1; fi
  docker build -q --label "bench.source=$3" -f "$tree/proxy/Dockerfile" -t "$tag" "$tree/proxy/" >/dev/null
}

if [ "$SKIP_BUILD" != 1 ]; then
  # node_modules holding mustache and fs-extra (NODE_PATH, or found upwards)
  DEPS=$(dirname "$(dirname "$(node -p 'require.resolve("mustache")')")")
  BASE_SHA=$(git rev-parse --verify "$BASE_REF^{commit}")
  echo "== building proxy images (baseline $BASE_REF = ${BASE_SHA:0:9}, disk cache from the working tree)"
  mkdir "$WORK/base"
  git archive "$BASE_SHA" proxy app/config.js config | tar -x -C "$WORK/base"
  build_image "$WORK/base" blot-proxy:bench-proxycache "$BASE_REF (${BASE_SHA:0:9})"
  build_image "$ROOT" blot-proxy:bench-diskcache "working tree ($(git rev-parse --short HEAD) + local changes)"
fi

# wrk and curl in one small image, built once and pinned to an Alpine release
if ! docker image inspect "$WRK_IMAGE" >/dev/null 2>&1; then
  printf 'FROM alpine:3.20\nRUN apk add --no-cache wrk curl\n' | docker build -q -t "$WRK_IMAGE" - >/dev/null
fi

# ---- shared services ------------------------------------------------------

docker network create "$NET" >/dev/null

# Blog requests are rate limited per client IP unless the IP is in the
# whitelist geo (cdn-ips.conf); whitelist every private range so wrk is exempt
cat > "$WORK/cdn-ips.conf" <<'WL'
10.0.0.0/8 1;
172.16.0.0/12 1;
192.168.0.0/16 1;
WL

docker run -d --name "$REDIS" --network "$NET" redis:7-alpine >/dev/null
docker run -d --name "$STUB" --network "$NET" -v "$BENCH/stub.js:/stub.js:ro" node:24.22.1-alpine node /stub.js >/dev/null
docker run -d --name "$WRK" --network "$NET" "$WRK_IMAGE" sleep infinity >/dev/null
sleep 2
docker logs "$STUB" 2>&1 | head -2

# wrk script for the fill cases: a distinct query string on every request
# (each wrk thread has its own Lua state, so the thread number is in it too)
cat > "$WORK/fill.lua" <<'LUA'
local n = 0
local threads = 0
function setup(thread)
  threads = threads + 1
  thread:set("tid", threads)
end
function request()
  n = n + 1
  return wrk.format("GET", wrk.path .. "?u=" .. tid .. "-" .. n)
end
LUA
docker cp "$WORK/fill.lua" "$WRK:/fill.lua"

# ---- helpers --------------------------------------------------------------

# usage_usec of a container's cgroup (CPU time of every process inside it)
cpu_usec() { docker exec "$1" cat /sys/fs/cgroup/cpu.stat | awk '$1=="usage_usec"{print $2}'; }

# Headers of one request from the wrk container: "<Blot-Cache> <Content-Encoding>"
probe() { # path accept-encoding
  local args=(-s -o /dev/null -D - -H "Host: blog.test")
  [ -n "$2" ] && args+=(-H "Accept-Encoding: $2")
  docker exec "$WRK" curl "${args[@]}" "http://$PROXY$1" | tr -d '\r' | awk '
    tolower($1)=="blot-cache:"{c=$2} tolower($1)=="content-encoding:"{e=$2}
    END{print (c==""?"-":c), (e==""?"identity":e)}'
}

# Wait until the disk cache holds N brotli copies (the page and the large page)
wait_for_br() { # count seconds
  local i n=0
  for ((i = 0; i < $2; i++)); do
    n=$(docker exec "$PROXY" find /var/cache/openresty -name '*.br' -not -path '*/.tmp/*' | wc -l | tr -d ' ')
    [ "$n" -ge "$1" ] && return 0
    sleep 1
  done
  echo "timed out waiting for $1 .br files, found $n" >&2
  return 1
}

# How many of 100 new connections to <path> were answered by compressing on
# the fly (chunked) rather than by sending the stored .br file (it has a
# Content-Length). Each nginx worker has its own open_file_cache, which
# remembers that an entry had no .br for open_file_cache_valid (60s).
count_chunked() { # path
  docker exec "$WRK" sh -c "for i in \$(seq 100); do curl -s -D - -o /dev/null -H 'Host: blog.test' -H 'Accept-Encoding: gzip, deflate, br' http://$PROXY$1; done | tr -d '\r' | grep -ci '^transfer-encoding: chunked'" || true
}

# wrk output -> tab separated: rps p50_ms p99_ms transfer non2xx requests
parse_wrk() {
  awk '
    function ms(v,  n) { n = v + 0; if (v ~ /us$/) return n / 1000; if (v ~ /ms$/) return n; if (v ~ /s$/) return n * 1000; return n }
    /^ +50%/ { p50 = ms($2) }
    /^ +99%/ { p99 = ms($2) }
    /requests in/ { reqs = $1 }
    /Requests\/sec:/ { rps = $2 }
    /Transfer\/sec:/ { xfer = $2 }
    /Non-2xx/ { bad = $NF }
    /Socket errors/ { err = $0 }
    END { printf "%s\t%.2f\t%.2f\t%s\t%d\t%d\t%s\n", rps, p50, p99, xfer, bad, reqs, err }'
}

CASES=(
  "page br+gzip|/page|gzip, deflate, br|br"
  "page gzip|/page|gzip|gzip"
  "page identity|/page||identity"
  "large br+gzip|/large|gzip, deflate, br|br"
  "image br+gzip|/image.jpg|gzip, deflate, br|identity"
)

# One timed wrk run; appends a row to $RESULTS. script: a wrk Lua script in the
# wrk container (see FILLS), or "".
measure() { # impl name path accept-encoding expected-probe script
  local impl=$1 name=$2 path=$3 ae=$4 want_check=$5 script=$6
  [[ $name =~ $ONLY ]] || return 0
  local secs=${DURATION%s}
  local probe_path=$path
  [ -n "$script" ] && probe_path="$path?probe=$RANDOM$RANDOM"
  local check; check=$(probe "$probe_path" "$ae")
  local args=(--latency -H "Host: blog.test"); [ -n "$ae" ] && args+=(-H "Accept-Encoding: $ae")
  [ -n "$script" ] && args+=(-s "$script")

  local p0 w0 s0 p1 w1 s1
  p0=$(cpu_usec "$PROXY"); w0=$(cpu_usec "$WRK"); s0=$(cpu_usec "$STUB")
  local out
  out=$(docker exec "$WRK" wrk -t"$THREADS" -c"$CONNS" -d"$DURATION" "${args[@]}" "http://$PROXY$path")
  p1=$(cpu_usec "$PROXY"); w1=$(cpu_usec "$WRK"); s1=$(cpu_usec "$STUB")

  local parsed; parsed=$(printf '%s\n' "$out" | parse_wrk)
  local reqs; reqs=$(printf '%s' "$parsed" | cut -f6)
  local cpu_req; cpu_req=$(awk -v d=$((p1 - p0)) -v n="$reqs" 'BEGIN{printf "%.1f", n ? d / n : 0}')
  local proxy_cores; proxy_cores=$(awk -v d=$((p1 - p0)) -v s="$secs" 'BEGIN{printf "%.2f", d / (s * 1e6)}')
  local wrk_cores; wrk_cores=$(awk -v d=$((w1 - w0)) -v s="$secs" 'BEGIN{printf "%.2f", d / (s * 1e6)}')
  local stub_cores; stub_cores=$(awk -v d=$((s1 - s0)) -v s="$secs" 'BEGIN{printf "%.2f", d / (s * 1e6)}')
  local flag=ok; [ "$check" = "$want_check" ] || flag="UNEXPECTED($check)"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$impl" "$name" "$parsed" "$cpu_req" "$proxy_cores" "$wrk_cores" "$stub_cores" >> "$RESULTS"
  printf '%s\t%s\n' "$name" "$flag" >> "$WORK/checks-$impl.tsv"
  local max; max=$(printf '%s\n' "$out" | awk '/^ +Latency/{print $4}')
  echo "   $name: $check, $(printf '%s' "$parsed" | cut -f1) req/s, max $max, ${cpu_req} us/req, proxy ${proxy_cores} cores, wrk ${wrk_cores} cores, stub ${stub_cores} cores"
}

# CPU time (user + system, from bash's time) of one brotli compression of the
# stub's pages, run in the disk cache proxy container: what the compressor
# pays once per entry that is read twice, against the lower level proxy_cache
# pays on every hit (level 4 is the brotli_comp_level in static-file.conf).
brotli_cost() {
  local path size q n=5 t
  for path in /page /large; do
    docker exec "$PROXY" curl -s -o /tmp/body "http://$STUB:8090$path"
    size=$(docker exec "$PROXY" wc -c /tmp/body | awk '{print $1}')
    for q in 4 11; do
      t=$(docker exec "$PROXY" bash -c "TIMEFORMAT='%U %S'; time (for i in \$(seq $n); do brotli -q $q -f -o /tmp/body.br /tmp/body; done)" 2>&1)
      printf '%s\t%s\t%s\t%s\t%s\n' "$path" "$size" "$q" "$(docker exec "$PROXY" wc -c /tmp/body.br | awk '{print $1}')" \
        "$(awk -v t="$t" -v n=$n 'BEGIN{split(t, a, " "); printf "%.0f", (a[1] + a[2]) * 1e6 / n}')" >> "$WORK/brotli.tsv"
    done
  done
  docker exec "$PROXY" rm -f /tmp/body /tmp/body.br
  tail -4 "$WORK/brotli.tsv" | awk -F'\t' '{printf "   brotli -q %s of %s (%s B): %s us CPU\n", $3, $1, $2, $5}'
}

# Identity isolates the cost of storing the answer; with br+gzip a miss also
# pays for compressing it on the fly (both implementations alike)
FILLS=(
  "fill page identity|/page||identity"
  "fill page br+gzip|/page|gzip, deflate, br|br"
  "fill large identity|/large||identity"
  "fill large br+gzip|/large|gzip, deflate, br|br"
)

# ---- one run per implementation -------------------------------------------

bench() { # impl image
  local impl=$1 image=$2
  echo "== $impl ($image)"
  docker rm -f "$PROXY" >/dev/null 2>&1 || true
  docker run -d --name "$PROXY" --network "$NET" --cpus="$CPUS" --cap-add SYS_NICE \
    -v "$WORK/cdn-ips.conf:/etc/openresty/cdn-ips.default.conf:ro" \
    -e BLOT_HOST=example.com -e PROXY_UNIT_MAIN="$STUB:8090" -e PROXY_PEER_MAIN="$STUB:8090" \
    -e PROXY_UNIT_WORKER="$STUB:8090" -e PROXY_PEER_WORKER="$STUB:8090" -e PROXY_REDIS_HOST="$REDIS" -e PROXY_RESOLVER=127.0.0.11 \
    -e PROXY_FETCH_CDN_IPS=false "$image" >/dev/null

  local i
  for ((i = 0; i < 60; i++)); do
    docker exec "$WRK" curl -sf -o /dev/null "http://$PROXY/health" && break
    sleep 1
  done

  # Warm every URL: a miss fills the cache, a second request is the first
  # hit. The disk cache makes its brotli copy after that hit (worker 0, one
  # at a time, niced), so wait for every compressible entry's .br file;
  # the timed runs then serve what a long-cached page is served.
  local c
  for c in "${CASES[@]}"; do
    IFS='|' read -r name path ae want <<<"$c"
    probe "$path" "$ae" >/dev/null
  done
  sleep 1
  for c in "${CASES[@]}"; do
    IFS='|' read -r name path ae want <<<"$c"
    probe "$path" "$ae" >/dev/null
  done
  if [ "$impl" = diskcache ]; then
    wait_for_br 2 180
    # a worker that read an entry before its .br existed keeps serving it
    # compressed on the fly until its open_file_cache entry is revalidated
    sleep 65
    local chunked; chunked=$(( $(count_chunked /page) + $(count_chunked /large) ))
    echo "   responses compressed on the fly after the wait (want 0): $chunked of 200"
    [ "$chunked" = 0 ] || { echo "the .br copies are not being served" >&2; exit 1; }
  fi

  for c in "${CASES[@]}"; do
    IFS='|' read -r name path ae want <<<"$c"
    measure "$impl" "$name" "$path" "$ae" "HIT $want" ""
  done

  # on the quiet proxy, before the fills fill the disk
  if [ "$impl" = diskcache ]; then brotli_cost; fi

  # Fills: every request is a distinct URL (wrk's script appends a counter),
  # so every request is a miss that Node answers and the proxy stores. Run
  # last, so the entries it leaves behind do not matter.
  for c in "${FILLS[@]}"; do
    IFS='|' read -r name path ae want <<<"$c"
    measure "$impl" "$name" "$path" "$ae" "MISS $want" "/fill.lua"
  done

  docker logs "$PROXY" 2>&1 | grep -E '\[(error|crit|alert)\]' > "$WORK/errors-$impl.txt" || true
  echo "   proxy error/crit/alert log lines: $(wc -l < "$WORK/errors-$impl.txt" | tr -d ' ')"
}

bench proxycache blot-proxy:bench-proxycache
bench diskcache blot-proxy:bench-diskcache

# ---- report ---------------------------------------------------------------

{
  echo "# Proxy cache benchmark results"
  echo
  echo "Run: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  echo "Machine: $(docker info --format 'Docker {{.ServerVersion}}, {{.NCPU}} CPUs, {{.MemTotal}} bytes memory, {{.OperatingSystem}}, {{.Architecture}}') ; host $(uname -sm), $(sysctl -n hw.ncpu 2>/dev/null || nproc) logical CPUs"
  echo
  echo "Baseline (nginx proxy_cache): $(docker image inspect -f '{{index .Config.Labels "bench.source"}}' blot-proxy:bench-proxycache). Disk cache: $(docker image inspect -f '{{index .Config.Labels "bench.source"}}' blot-proxy:bench-diskcache)."
  echo
  echo "wrk: \`-t$THREADS -c$CONNS -d$DURATION --latency\`, from a separate container on the same network. Proxy limited to \`--cpus=$CPUS\`. The stub upstream and Redis are idle in the hit cases (every request is a cache hit, brotli copies made before timing) and busy in the fill cases (every request a distinct URL)."
  echo
  node "$BENCH/table.js" "$RESULTS" "$WORK"
} | tee "$BENCH/results.md"

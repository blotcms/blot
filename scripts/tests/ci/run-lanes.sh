#!/usr/bin/env bash
# Runs one CI test job's lanes in parallel on this runner (see plan.js for how
# the lanes are chosen and .github/workflows/node.yml for the job).
#
# A lane is a sequence of test runner processes, each running some of one
# suite's spec files, and gets everything a process expects to have to
# itself: its own Docker network, Redis (the runner refuses to start against
# a non-empty database) and MinIO, its own copy of the working tree (some
# specs write into app/; an overlay of the checkout), and its own
# network namespace (the test servers listen on fixed ports). A lane's
# processes run one after another, each in a fresh container against a
# flushed Redis.
#
# Env: LANES (JSON from plan.js --runner: [[{suite, part, files}, ...], ...]),
# IMAGE_TAG, and the BLOT_STRIPE_* secrets. With COVERAGE=1 the processes run
# under nyc (master pushes; pull requests skip it for speed). Writes coverage to ./.nyc_output,
# per-file seconds to ./.test-timings/<job>.json (for timings.json) and a
# table to $GITHUB_STEP_SUMMARY. Exits non-zero if any process failed.
set -uo pipefail

REDIS_IMAGE="redis:6.2.12"
# Keep in step with .github/actions/start-minio and scripts/tests/invoke.sh
MINIO_IMAGE="alpine/minio:RELEASE.2025-10-15T17-29-55Z@sha256:cf23643a6cf9ce159c57643ceb88279e431262282428c9e0bf3a7ef1a97e84b4"
# A spec that starves the event loop stops Jasmine's own timeout firing, so
# cap each process rather than hold the runner.
PROCESS_TIMEOUT="${PROCESS_TIMEOUT:-12m}"
NYC_ARGS="--include=app/**/*.js --exclude=**/tests/** --exclude=**/tests.js --exclude=app/views-built/** --exclude=app/templates/source/**"

# nyc instruments every app file as it loads, which slows the specs down
RUN_TESTS="node scripts/tests"
[ -n "${COVERAGE:-}" ] && RUN_TESTS="nyc --silent --no-clean $NYC_ARGS node scripts/tests"

WORKSPACE="$(pwd)"
# Field separator for the results. Not a tab: `read` folds runs of whitespace
# separators, so an empty field would vanish.
SEP=$'\x1f'
ROOT="${RUNNER_TEMP:-/tmp}/lanes"
LANE_COUNT=$(jq 'length' <<< "$LANES")

rm -rf "$WORKSPACE/.test-timings"; sudo -n rm -rf "$ROOT" 2> /dev/null || rm -rf "$ROOT"
mkdir -p "$ROOT" "$WORKSPACE/.nyc_output" "$WORKSPACE/.test-timings"

lane_tree() {
  if [ -e "$ROOT/$1/use-checkout" ]; then echo "$WORKSPACE"; else echo "$ROOT/$1/tree"; fi
}

start_lane() {
  local lane=$1 dir="$ROOT/$1" tree
  tree=$(lane_tree "$lane")
  mkdir -p "$dir/logs" "$dir/meta" "$dir/.nyc_output"
  # An overlay of the checkout: instant, and the lane's writes land in its
  # own upper directory, never in the checkout the other lanes see. Where it
  # can't mount, the first lane uses the checkout itself and the others a copy.
  mkdir -p "$tree" "$dir/upper" "$dir/work"
  if ! sudo -n mount -t overlay overlay \
    -o "lowerdir=$WORKSPACE,upperdir=$dir/upper,workdir=$dir/work" "$tree" 2> /dev/null; then
    if [ "$lane" = 0 ]; then
      touch "$dir/use-checkout"
    else
      cp -a "$WORKSPACE/app" "$WORKSPACE/scripts" "$WORKSPACE/config" "$WORKSPACE/proxy" "$tree/"
    fi
  fi
  docker network create "lane-$lane" > /dev/null
  docker run -d --name "lane-$lane-redis" --network "lane-$lane" "$REDIS_IMAGE" > /dev/null
  # The runner creates the bucket and waits for MinIO (scripts/tests/util/bucket.js)
  docker run -d --name "lane-$lane-minio" --network "lane-$lane" --user root \
    -e MINIO_ROOT_USER=blot-test -e MINIO_ROOT_PASSWORD=blot-test-secret \
    "$MINIO_IMAGE" server /data --address :9000 > /dev/null
  for i in $(seq 1 30); do
    docker exec "lane-$lane-redis" redis-cli ping > /dev/null 2>&1 && return 0
    sleep 1
  done
  echo "lane $lane: Redis did not start"
}

run_process() {
  local lane=$1 n=$2 suite=$3 part=$4 dir="$ROOT/$1" tree
  local log="$dir/logs/$n.log" name="lane-$lane-test-$n" start status
  tree=$(lane_tree "$lane")

  # Some suites leave keys behind; the next process needs an empty database
  docker exec "lane-$lane-redis" redis-cli flushall > /dev/null

  start=$(date +%s)
  timeout "$PROCESS_TIMEOUT" docker run --rm --name "$name" \
    --network "lane-$lane" \
    -e BLOT_REDIS_HOST="lane-$lane-redis" \
    -e BLOT_STORAGE_BUCKET=blot-test-storage \
    -e BLOT_STORAGE_ENDPOINT="http://lane-$lane-minio:9000" \
    -e BLOT_STORAGE_REGION=us-east-1 \
    -e BLOT_AWS_KEY=blot-test \
    -e BLOT_AWS_SECRET=blot-test-secret \
    -e BLOT_STRIPE_KEY -e BLOT_STRIPE_SECRET -e BLOT_STRIPE_PRODUCT \
    -e BLOT_TEST_TIMINGS="/lane/$n.json" \
    -v "$tree/app:/usr/src/app/app" \
    -v "$tree/scripts:/usr/src/app/scripts" \
    -v "$tree/config:/usr/src/app/config" \
    -v "$tree/proxy:/usr/src/app/proxy" \
    -v "$dir/.nyc_output:/usr/src/app/.nyc_output" \
    -v "$dir/meta:/lane" \
    "$IMAGE_TAG" \
    sh -c "$RUN_TESTS '$suite' --files-from=/lane/$n.files" \
    > "$log" 2>&1
  status=$?
  if [ "$status" = 124 ]; then
    echo "Timed out after $PROCESS_TIMEOUT" >> "$log"
    docker rm -f "$name" > /dev/null 2>&1
  fi

  printf "%s$SEP%s$SEP%s$SEP%s$SEP%s\n" "$n" "$suite" "$part" "$status" "$(( $(date +%s) - start ))" \
    >> "$dir/results"
  echo "lane $((lane + 1)): $suite $part $([ "$status" = 0 ] && echo passed || echo "FAILED ($status)") in $(( $(date +%s) - start ))s"
}

run_lane() {
  local lane=$1 count n
  count=$(jq ".[$lane] | length" <<< "$LANES")
  for n in $(seq 1 "$count"); do
    jq -r ".[$lane][$((n - 1))].files[]" <<< "$LANES" > "$ROOT/$lane/meta/$n.files"
    run_process "$lane" "$n" \
      "$(jq -r ".[$lane][$((n - 1))].suite" <<< "$LANES")" \
      "$(jq -r ".[$lane][$((n - 1))].part" <<< "$LANES")"
  done
}

# Set up every lane before starting any, so the copies and container starts
# don't compete with running specs.
setup_start=$(date +%s)
for lane in $(seq 0 $((LANE_COUNT - 1))); do start_lane "$lane" & done
wait
echo "Lanes set up in $(( $(date +%s) - setup_start ))s"

pids=()
for lane in $(seq 0 $((LANE_COUNT - 1))); do
  run_lane "$lane" &
  pids+=($!)
done
for pid in "${pids[@]}"; do wait "$pid"; done

failed=0
{
  echo "| Lane | Suite | Part | Files | Result | Seconds |"
  echo "|---|---|---|---|---|---|"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

for lane in $(seq 0 $((LANE_COUNT - 1))); do
  dir="$ROOT/$lane"
  cp -a "$dir/.nyc_output/." "$WORKSPACE/.nyc_output/" 2>/dev/null || true
  while IFS="$SEP" read -r n suite part status seconds; do
    label="$suite $part"
    files=$(wc -l < "$dir/meta/$n.files" | tr -d ' ')
    if [ "$status" = 0 ]; then
      echo "::group::✓ $label, $files files (${seconds}s)"
      cat "$dir/logs/$n.log"
      echo "::endgroup::"
      result=passed
    else
      failed=1
      result="**failed**"
      echo "::error::$label failed (exit $status)"
      echo "──────── $label failed (exit $status), lane $((lane + 1)) ────────"
      echo "Spec files:"; sed 's/^/  /' "$dir/meta/$n.files"
      cat "$dir/logs/$n.log"
    fi
    echo "| $((lane + 1)) | $suite | $part | $files | $result | $seconds |" \
      >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  done < "$dir/results"
done

# Every process's per-file seconds, merged
jq -s 'add // {}' "$ROOT"/*/meta/*.json > "$WORKSPACE/.test-timings/${GITHUB_JOB:-test}-${RUNNER_INDEX:-0}.json" 2>/dev/null \
  || echo '{}' > "$WORKSPACE/.test-timings/${GITHUB_JOB:-test}-${RUNNER_INDEX:-0}.json"

for lane in $(seq 0 $((LANE_COUNT - 1))); do
  docker rm -f "lane-$lane-redis" "lane-$lane-minio" > /dev/null 2>&1
  docker network rm "lane-$lane" > /dev/null 2>&1
  mountpoint -q "$ROOT/$lane/tree" 2> /dev/null && sudo -n umount "$ROOT/$lane/tree"
done

exit $failed

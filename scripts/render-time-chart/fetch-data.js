const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

const CONTAINERS = ["blue", "green", "yellow"];

// Must match app/blog/render/renderTimeMetric.js's DAILY_HISTORY_KEY. Not
// imported directly - this script has no reason to load the app's require
// path (it only ever talks to Redis over ssh), so the two are kept in sync
// by convention/comment rather than a shared module.
const DAILY_HISTORY_KEY = "metrics:render-time:daily-p95-history";

// One ssh connection: a read-only LRANGE per container for the last 24h of
// one-minute windows, plus one LRANGE for the all-time daily history -
// cheap. See app/blog/render/renderTimeMetric.js and
// app/scheduler/daily/render-time.js for what writes these.
const REMOTE_SCRIPT = `
set -e
HOST=$(grep BLOT_REDIS_HOST /etc/blot/secrets.env | cut -d= -f2 | tr -d ' ')
for c in ${CONTAINERS.join(" ")}; do
  echo "==$c=="
  redis-cli -h "$HOST" lrange "metrics:render-time:p95:$c" 0 -1
done
echo "==daily=="
redis-cli -h "$HOST" lrange "${DAILY_HISTORY_KEY}" 0 -1
`;

function parseSections(output) {
  const sections = {};
  let current = null;

  for (const line of output.split("\n")) {
    const marker = line.match(/^==(\w+)==$/);
    if (marker) {
      current = marker[1];
      sections[current] = [];
      continue;
    }

    if (!current || !line.trim()) continue;
    sections[current].push(line.trim());
  }

  return sections;
}

// Chart display resolution for the 24h chart. The underlying storage stays
// at 1-minute windows (the daily email's idle-window detection and average
// depend on that cadence) - this only smooths what gets plotted, since a
// raw 1-minute line is too noisy to read at a glance.
const CHART_BUCKET_MS = 5 * 60 * 1000;

// Raw per-container points don't land on the same wall-clock minute (each
// container flushes every 60s from its own process start, not a shared
// clock), so bucket by CHART_BUCKET_MS and average whatever containers
// reported in that bucket into a single point.
function mergeByBucket(containerLists, bucketMs) {
  const buckets = new Map();

  for (const entries of containerLists) {
    for (const { timestampMs, p95Ms } of entries) {
      const bucket = Math.floor(timestampMs / bucketMs) * bucketMs;
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket).push(p95Ms);
    }
  }

  return [...buckets.entries()]
    .map(([timestampMs, values]) => ({
      timestampMs,
      p95Ms: Math.round(values.reduce((sum, n) => sum + n, 0) / values.length),
    }))
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

function decodeLines(lines) {
  return lines
    .map((line) => {
      const [timestampMs, p95Ms] = line.split(":").map(Number);
      return { timestampMs, p95Ms };
    })
    .filter(({ timestampMs, p95Ms }) => !isNaN(timestampMs) && !isNaN(p95Ms));
}

function parse(output) {
  const sections = parseSections(output);

  // The raw lists are capped by entry count (~25h of slack), not age, so a
  // lightly used container can retain points older than the chart's
  // advertised 24h window - drop those rather than stretch the x-axis.
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

  const raw = CONTAINERS.map((container) =>
    decodeLines(sections[container] || []).filter(
      ({ timestampMs }) => timestampMs >= oneDayAgo
    )
  );

  return {
    last24h: mergeByBucket(raw, CHART_BUCKET_MS),
    allTimeDaily: decodeLines(sections.daily || []),
  };
}

// Uses execFile (no local shell) so the remote script's own $ and $(...)
// reach the ssh command untouched, rather than being expanded locally.
async function fetchRenderTimeData() {
  const { stdout } = await execFileAsync("ssh", ["blot", REMOTE_SCRIPT], {
    timeout: 30 * 1000,
    maxBuffer: 10 * 1024 * 1024,
  });

  return parse(stdout);
}

module.exports = { fetchRenderTimeData };

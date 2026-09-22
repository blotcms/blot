const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

const CONTAINERS = ["blue", "green", "yellow"];

// One ssh connection, one redis-cli per container, each a single LRANGE over
// a list capped at ~25h of one-minute windows (~1500 entries) - cheap and
// read-only. See app/blog/render/renderTimeMetric.js for what writes it.
const REMOTE_SCRIPT = `
set -e
HOST=$(grep BLOT_REDIS_HOST /etc/blot/secrets.env | cut -d= -f2 | tr -d ' ')
for c in ${CONTAINERS.join(" ")}; do
  echo "==$c=="
  redis-cli -h "$HOST" lrange "metrics:render-time:p95:$c" 0 -1
done
`;

function parse(output) {
  const data = {};
  let current = null;

  for (const line of output.split("\n")) {
    const marker = line.match(/^==(\w+)==$/);
    if (marker) {
      current = marker[1];
      data[current] = [];
      continue;
    }

    if (!current || !line.trim()) continue;

    const [timestampMs, p95Ms] = line.trim().split(":").map(Number);
    if (isNaN(timestampMs) || isNaN(p95Ms)) continue;

    data[current].push({ timestampMs, p95Ms });
  }

  return data;
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

module.exports = { fetchRenderTimeData, CONTAINERS };

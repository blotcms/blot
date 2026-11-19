// The browser jail's memory, and a watchdog on it for the screenshot job
// (./screenshot.js). The unit's browser cgroup is one limit for the whole
// batch, and its OOM kill takes every page of the batch with it. The watchdog
// watches the job's total memory while a page loads and renders, and gives
// up on that page, closing its context, before the kernel does, so that one
// heavy page costs only itself.

const fs = require("fs/promises");

const MiB = 1024 * 1024;

// A page is given up on at this share of the cgroup's limit, which leaves the
// rest for Chromium's own growth between two polls and for re-encoding the PNG
const THRESHOLD_SHARE = 0.85;
// Where the cgroup's limit isn't known
const FALLBACK_THRESHOLD = 430 * MiB;
const POLL_MS = 250;
const PAGE_SIZE = 4096;

// Inside the jail, /proc/<pid>/cgroup is relative to the jail's cgroup
// namespace, whose root is the browser cgroup (the job joins it before nsjail
// starts): the job's processes are exactly the ones reported as "0::/", and
// every other process in the container is "0::/.." followed by a path.
const JAIL_CGROUP = "0::/";

// The job's limit, passed in by the broker (proxy/unit/sandbox/jail.js) as the
// browser cgroup's memory.max in bytes: absent or "max" where it has none
function thresholdFrom(value, fallback = FALLBACK_THRESHOLD) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return fallback;
  const max = Number(value);
  return max > 0 ? Math.floor(max * THRESHOLD_SHARE) : fallback;
}

// The pids of the processes in the jail, which are the ones the cgroup says
// so for. /proc is the container's and the jail's pid namespace is its own, so
// no pid the job knows (process.pid) can be used, and nothing is summed that
// can't be shown to be in the jail.
async function jailPids(io) {
  const pids = [];
  for (const entry of await io.readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const text = await io.readFile(`/proc/${entry}/cgroup`, "utf8");
      if (text.split("\n").some((line) => line === JAIL_CGROUP))
        pids.push(Number(entry));
    } catch (e) {} // gone since the listing
  }
  return pids;
}

// Bytes of memory of those processes, and of which kind: "pss" (proportional
// set size, from smaps_rollup, which divides a shared page between the
// processes that map it, so the sum is close to what the cgroup is charged) or,
// where a process's smaps_rollup can't be read, "rss" (which counts a shared
// page for each process, and so errs high).
async function processBytes(io) {
  const pids = await jailPids(io);
  if (!pids.length) return null;
  let total = 0;
  let source = "pss";
  for (const pid of pids) {
    try {
      const rollup = await io.readFile(`/proc/${pid}/smaps_rollup`, "utf8");
      const match = /^Pss:\s+(\d+) kB/m.exec(rollup);
      if (!match) throw new Error("no Pss");
      total += Number(match[1]) * 1024;
    } catch (e) {
      try {
        const statm = await io.readFile(`/proc/${pid}/statm`, "utf8");
        total += Number(statm.split(" ")[1]) * PAGE_SIZE;
        source = "rss";
      } catch (e2) {} // gone
    }
  }
  return { bytes: total, source };
}

// { read(), threshold, source }: read() resolves to the job's memory in bytes
// now, or null if it can't tell which processes are the jail's, and sets source to the kind of reading it was; threshold is what a page
// is given up on, a share of the limit the broker passed in the environment.
// io and env are for the specs.
function createMeter({
  io = { readFile: fs.readFile, readdir: fs.readdir },
  env = process.env,
} = {}) {
  const meter = {
    source: "pss",
    threshold: thresholdFrom(env.BLOT_BROWSER_MEMORY_MAX),
    async read() {
      const found = await processBytes(io);
      if (!found) return null; // no way to tell: the page is not judged
      meter.source = found.source;
      return found.bytes;
    },
  };
  return meter;
}

// Polls meter.read() until stop() is called, and calls onExceed(bytes) once
// the first time it reads threshold or more. A read that fails is skipped:
// the watchdog only ever makes a heavy page fail sooner, never a page that
// would have worked.
function watch(meter, onExceed, { pollMs = POLL_MS } = {}) {
  let stopped = false;
  let timer;
  let peak = 0;

  async function poll() {
    if (stopped) return;
    try {
      const bytes = await meter.read();
      if (typeof bytes === "number" && !stopped) {
        peak = Math.max(peak, bytes);
        if (bytes >= meter.threshold) {
          stopped = true;
          return onExceed(bytes);
        }
      }
    } catch (e) {}
    if (!stopped) timer = setTimeout(poll, pollMs);
  }

  timer = setTimeout(poll, 0);

  return {
    peak: () => peak,
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

module.exports = {
  createMeter,
  thresholdFrom,
  watch,
  THRESHOLD_SHARE,
  FALLBACK_THRESHOLD,
  POLL_MS,
};

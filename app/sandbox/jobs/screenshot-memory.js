// The browser jail's memory, and a watchdog on it for the screenshot job
// (./screenshot.js). The unit's browser cgroup is one limit for the whole
// batch, and its OOM kill takes every page of the batch with it. The watchdog
// watches the browser's total memory while a page loads and renders, and gives
// up on that page, closing its context, before the kernel does, so that one
// heavy page costs only itself.

const fs = require("fs/promises");

const MiB = 1024 * 1024;

// A page is given up on at this share of the cgroup's limit, which leaves the
// rest for Chromium's own growth between two polls and for re-encoding the PNG
const THRESHOLD_SHARE = 0.85;
// Where the cgroup's limit can't be read
const FALLBACK_THRESHOLD = 430 * MiB;
const POLL_MS = 250;
const PAGE_SIZE = 4096;

// Where the job may find the cgroup it runs in, if the jail shows it: the
// unit's browser cgroup bound in, or the jail's own cgroup namespace root
const CGROUP_DIRS = ["/sandbox-browser-cgroup", "/sys/fs/cgroup"];

async function number(file, io) {
  const text = (await io.readFile(file, "utf8")).trim();
  if (!/^\d+$/.test(text)) return null;
  return Number(text);
}

// The first of the cgroup directories that has a memory.current to read
async function findCgroup(io, dirs) {
  for (const dir of dirs) {
    try {
      if ((await number(dir + "/memory.current", io)) !== null) return dir;
    } catch (e) {}
  }
  return null;
}

// Bytes of resident memory of this process and all it started (Chromium and
// its children), from /proc, which is what is left where the cgroup is out of
// sight. Resident memory counts a page shared between processes once for each,
// so it errs on the high side.
async function processTreeBytes(io, root) {
  const entries = await io.readdir("/proc");
  const parent = new Map();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = await io.readFile(`/proc/${entry}/stat`, "utf8");
      // pid (comm) state ppid ...: comm may hold spaces and parentheses
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      parent.set(Number(entry), Number(after[1]));
    } catch (e) {} // gone since the listing
  }

  const inTree = new Set([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, ppid] of parent) {
      if (!inTree.has(pid) && inTree.has(ppid)) {
        inTree.add(pid);
        grew = true;
      }
    }
  }

  let total = 0;
  for (const pid of inTree) {
    try {
      const statm = await io.readFile(`/proc/${pid}/statm`, "utf8");
      total += Number(statm.split(" ")[1]) * PAGE_SIZE;
    } catch (e) {}
  }
  return total;
}

// { read(), threshold, source }: read() resolves to the browser's memory in
// bytes now, threshold is what a page is given up on. The cgroup's memory.current
// is exact, and what the kernel's limit is judged against; otherwise the
// processes' resident memory is summed. io is for the specs.
async function createMeter({
  io = { readFile: fs.readFile, readdir: fs.readdir },
  dirs = CGROUP_DIRS,
  pid = process.pid,
  fallbackThreshold = FALLBACK_THRESHOLD,
} = {}) {
  const dir = await findCgroup(io, dirs);

  if (dir) {
    let max = null;
    try {
      max = await number(dir + "/memory.max", io); // "max" if unlimited
    } catch (e) {}
    return {
      source: "cgroup",
      threshold: max ? Math.floor(max * THRESHOLD_SHARE) : fallbackThreshold,
      read: () => number(dir + "/memory.current", io),
    };
  }

  return {
    source: "proc",
    threshold: fallbackThreshold,
    read: () => processTreeBytes(io, pid),
  };
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
  watch,
  processTreeBytes,
  THRESHOLD_SHARE,
  FALLBACK_THRESHOLD,
  POLL_MS,
};

const v8 = require("v8");

// Garbage collection and V8 heap figures for the [STATS] process line
// (scheduler/render-cache-stats), to size --max-old-space-size and the render
// caches from (#2795). heapUsed sampled once a minute lands anywhere in the
// collector's sawtooth; the heap used just after a major collection is the
// live set, the memory the process actually needs. Pauses show whether a
// smaller heap limit would make the collector work harder: render time is
// what a tighter limit would cost.
//
// v8.GCProfiler records the heap as each collection ends, so the figure is
// not inflated by whatever ran before a callback could (a PerformanceObserver
// reads the heap only once the event loop gets to it). It keeps a record per
// collection until stopped, so it is restarted every 10 seconds and its
// records folded into the counters below.
const KINDS = {
  Scavenge: "minor",
  MinorMarkSweep: "minor",
  MarkSweepCompact: "major",
  IncrementalMarking: "incremental",
  ProcessWeakCallbacks: "weakcb",
};
const FOLD_MS = 10 * 1000;

const gc = {};
for (const kind of new Set(Object.values(KINDS)))
  gc[kind] = { count: 0, ms: 0, maxMs: 0 };

// The heap used after each major collection: the most recent, the highest
// since the last snapshot, and the highest since the process started
const afterMajor = { last: 0, sinceSnapshot: 0, ever: 0 };
let profiler;

function fold() {
  if (!profiler) return;
  const result = profiler.stop();
  profiler.start();
  for (const record of (result && result.statistics) || []) {
    const kind = KINDS[record.gcType] || "weakcb";
    const stats = gc[kind];
    const ms = record.cost / 1000; // cost is in microseconds
    stats.count++;
    stats.ms += ms;
    if (ms > stats.maxMs) stats.maxMs = ms;
    if (kind === "major") {
      const used = record.afterGC.heapStatistics.usedHeapSize;
      afterMajor.last = used;
      if (used > afterMajor.sinceSnapshot) afterMajor.sinceSnapshot = used;
      if (used > afterMajor.ever) afterMajor.ever = used;
    }
  }
}

function start() {
  if (profiler || typeof v8.GCProfiler !== "function") return;
  profiler = new v8.GCProfiler();
  profiler.start();
  setInterval(fold, FOLD_MS).unref();
}

// key=value fields: cumulative pause counts and times per kind, the heap
// after major collections, V8's heap limit and contexts (a detached context
// that stays is a leak), and each heap space's used bytes
function fields() {
  fold();
  const heap = v8.getHeapStatistics();
  const out = [
    "heap_limit=" + heap.heap_size_limit,
    "heap_mallocedMemory=" + heap.malloced_memory,
    "heap_peakMallocedMemory=" + heap.peak_malloced_memory,
    "heap_nativeContexts=" + heap.number_of_native_contexts,
    "heap_detachedContexts=" + heap.number_of_detached_contexts,
    "heap_afterMajorGc=" + afterMajor.last,
    "heap_afterMajorGcMax=" + afterMajor.sinceSnapshot,
    "heap_afterMajorGcMaxEver=" + afterMajor.ever,
  ];
  afterMajor.sinceSnapshot = 0;
  for (const space of v8.getHeapSpaceStatistics())
    out.push("heap_space_" + space.space_name + "=" + space.space_used_size);
  for (const [kind, stats] of Object.entries(gc))
    out.push(
      "gc_" + kind + "_count=" + stats.count,
      "gc_" + kind + "_ms=" + Math.round(stats.ms),
      "gc_" + kind + "_maxMs=" + Math.round(stats.maxMs)
    );
  return out;
}

module.exports = { start, fields };

const v8 = require("v8");
const { PerformanceObserver, constants } = require("perf_hooks");

// Garbage collection and V8 heap figures for the [STATS] process line
// (scheduler/render-cache-stats), to size --max-old-space-size and the render
// caches from (#2795). heapUsed sampled once a minute lands anywhere in the
// collector's sawtooth; the heap used just after a major collection is the
// live set, the memory the process actually needs. Pauses show whether a
// smaller heap limit would make the collector work harder: render time is
// what a tighter limit would cost.
const KINDS = {
  [constants.NODE_PERFORMANCE_GC_MAJOR]: "major",
  [constants.NODE_PERFORMANCE_GC_MINOR]: "minor",
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: "incremental",
  [constants.NODE_PERFORMANCE_GC_WEAKCB]: "weakcb",
};

const gc = {};
for (const kind of Object.values(KINDS))
  gc[kind] = { count: 0, ms: 0, maxMs: 0 };

// The heap used after each major collection: the most recent, the highest
// since the last snapshot, and the highest since the process started
let afterMajor = { last: 0, sinceSnapshot: 0, ever: 0 };
let observer;

function start() {
  if (observer) return;
  observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const kind = KINDS[entry.detail && entry.detail.kind] || "weakcb";
      const stats = gc[kind];
      stats.count++;
      stats.ms += entry.duration;
      if (entry.duration > stats.maxMs) stats.maxMs = entry.duration;
      if (kind === "major") {
        // The observer runs soon after the collection, before much new
        // garbage, so this is close to the live set
        const used = v8.getHeapStatistics().used_heap_size;
        afterMajor.last = used;
        if (used > afterMajor.sinceSnapshot) afterMajor.sinceSnapshot = used;
        if (used > afterMajor.ever) afterMajor.ever = used;
      }
    }
  });
  observer.observe({ entryTypes: ["gc"] });
}

// key=value fields: cumulative pause counts and times per kind, the heap
// after major collections, V8's heap limit and contexts (a detached context
// that stays is a leak), and each heap space's used bytes
function fields() {
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

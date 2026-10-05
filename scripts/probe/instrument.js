// In-container instrumentation shared by the probe scripts (render-probe,
// build-probe). Everything that matters for diagnosing a crash is appended
// to .ndjson files in the output directory as it happens, so it survives
// the process dying of an out-of-memory error part-way through.
//
//   const instrument = require("../probe/instrument");
//   const out = instrument.output("/out");
//   const sampler = instrument.startSampler(out, { extra: () => ({ inflight }) });
//   const phases = instrument.measurePhases(out);
//   ...
//   out.writeJSON("summary.json", { ...sampler.summary(), ... });
//
// Shipped to the host with the probe script by ../probe/run.js and mounted at
// /usr/src/app/scripts/probe/, so probe scripts require it relatively.

const fs = require("fs");
const path = require("path");
const v8 = require("v8");
const diagnosticsChannel = require("diagnostics_channel");
const {
  monitorEventLoopDelay,
  PerformanceObserver,
  performance,
} = require("perf_hooks");

const MB = 1024 * 1024;

function round(n) {
  return Math.round(n * 10) / 10;
}

function mb(bytes) {
  return round(bytes / MB);
}

// Milliseconds since this module was loaded (i.e. since the probe started).
const t0 = performance.now();
function now() {
  return Math.round(performance.now() - t0);
}

// The output directory: append(file, record) adds one JSON line, written
// synchronously so nothing is lost to a crash.
function output(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    append(file, record) {
      fs.appendFileSync(path.join(dir, file), JSON.stringify(record) + "\n");
    },
    writeJSON(file, value) {
      fs.writeFileSync(path.join(dir, file), JSON.stringify(value, null, 2));
    },
  };
}

// Samples heap, RSS, external memory, the heap limit and the event loop's
// worst delay every intervalMs into `file`, plus whatever extra() returns.
// Prints a progress line every printEveryMs (print(sample) to customise it).
// Also totals GC pauses; onGC(ms, kind) sees each one, e.g. to log long ones.
function startSampler(
  out,
  { file = "samples.ndjson", intervalMs = 100, printEveryMs = 1000, extra, print, onGC } = {}
) {
  const gc = { count: 0, totalMs: 0, maxMs: 0 };
  const peaks = { heapUsedMB: 0, rssMB: 0, externalMB: 0, eventLoopDelayMaxMs: 0 };

  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();

  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gc.count++;
      gc.totalMs += entry.duration;
      gc.maxMs = Math.max(gc.maxMs, entry.duration);
      if (onGC) onGC(entry.duration, entry.detail && entry.detail.kind);
    }
  });
  observer.observe({ entryTypes: ["gc"] });

  let lastPrint = 0;
  const timer = setInterval(() => {
    const mem = process.memoryUsage();
    const delayMax = loop.max / 1e6;
    loop.reset();

    const sample = {
      t: now(),
      heapUsedMB: mb(mem.heapUsed),
      heapTotalMB: mb(mem.heapTotal),
      heapLimitMB: mb(v8.getHeapStatistics().heap_size_limit),
      externalMB: mb(mem.external),
      rssMB: mb(mem.rss),
      eventLoopDelayMaxMs: Math.round(delayMax),
      gcCount: gc.count,
      ...(extra ? extra() : {}),
    };

    peaks.heapUsedMB = Math.max(peaks.heapUsedMB, sample.heapUsedMB);
    peaks.rssMB = Math.max(peaks.rssMB, sample.rssMB);
    peaks.externalMB = Math.max(peaks.externalMB, sample.externalMB);
    peaks.eventLoopDelayMaxMs = Math.max(peaks.eventLoopDelayMaxMs, sample.eventLoopDelayMaxMs);
    out.append(file, sample);

    if (sample.t - lastPrint >= printEveryMs) {
      lastPrint = sample.t;
      if (print) print(sample);
      else {
        console.log(
          `[${(sample.t / 1000).toFixed(1)}s] heap=${sample.heapUsedMB}/${sample.heapLimitMB}MB` +
            ` rss=${sample.rssMB}MB loopDelayMax=${sample.eventLoopDelayMaxMs}ms`
        );
      }
    }
  }, intervalMs);
  timer.unref();

  return {
    peaks,
    gc,
    stop() {
      clearInterval(timer);
      observer.disconnect();
      loop.disable();
    },
    // Totals for summary.json.
    summary() {
      return {
        elapsedMs: now(),
        peaks,
        gc: { count: gc.count, totalMs: Math.round(gc.totalMs), maxMs: Math.round(gc.maxMs) },
        heapSpaces: heapSpaces(),
      };
    },
  };
}

function heapSpaces() {
  return v8.getHeapSpaceStatistics().map((space) => ({
    name: space.space_name,
    usedMB: mb(space.space_used_size),
  }));
}

// Per-phase memory measurement, for probes that do a sequence of distinct
// steps (rebuild this post, then that one) and want each one's cost:
//
//   phases.start("update /a.md");  ...  phases.end({ error });
//
// Each phase runs under a v8.GCProfiler, which records the heap size before
// and after every GC. GCs also happen inside long synchronous work, so the
// largest "before" size is a close lower bound on the true peak even when
// the event loop never gets a turn; stop() returns the phase's GC count and
// cost synchronously. A sampler every intervalMs adds RSS/external/
// ArrayBuffer peaks, which only it can see, and calls onSample(usage, label)
// (label is null between phases), e.g. to take a heap snapshot at a
// threshold. With --expose-gc, a GC is forced before each phase (so the
// baseline isn't last phase's garbage) and after it (for heapRetainedMB),
// outside the profiler so neither is charged to the phase.
//
// end() appends the result to `file` straight away and returns it.
function measurePhases(out, { file = "phases.ndjson", intervalMs = 25, onSample } = {}) {
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();
  const results = [];
  let current = null;

  function sample() {
    const usage = process.memoryUsage();
    if (current) {
      for (const field of ["heapUsed", "rss", "external", "arrayBuffers"]) {
        current.peak[field] = Math.max(current.peak[field], usage[field]);
      }
    }
    if (onSample) onSample(usage, current ? current.label : null);
  }

  const timer = setInterval(sample, intervalMs);
  timer.unref();

  function start(label) {
    if (current) throw new Error(`Phase ${current.label} has not ended`);
    if (global.gc) global.gc();
    const usage = process.memoryUsage();
    loopDelay.reset();
    const gcProfiler = new v8.GCProfiler();
    gcProfiler.start();
    current = {
      label,
      gcProfiler,
      started: performance.now(),
      before: usage,
      peak: {
        heapUsed: usage.heapUsed,
        rss: usage.rss,
        external: usage.external,
        arrayBuffers: usage.arrayBuffers,
      },
    };
  }

  function end(extra) {
    sample();
    const phase = current;
    current = null;
    if (!phase) throw new Error("No phase to end");

    const gcs = phase.gcProfiler.stop().statistics;
    const heapPeak = Math.max(
      phase.peak.heapUsed,
      ...gcs.map((gc) => gc.beforeGC.heapStatistics.usedHeapSize)
    );

    if (global.gc) global.gc();
    const after = process.memoryUsage();

    const result = {
      t: now(),
      label: phase.label,
      ms: Math.round(performance.now() - phase.started),
      heapBeforeMB: mb(phase.before.heapUsed),
      heapPeakMB: mb(heapPeak),
      heapGrowthMB: mb(heapPeak - phase.before.heapUsed),
      heapRetainedMB: global.gc ? mb(after.heapUsed - phase.before.heapUsed) : null,
      rssPeakMB: mb(phase.peak.rss),
      externalPeakMB: mb(phase.peak.external),
      arrayBuffersPeakMB: mb(phase.peak.arrayBuffers),
      maxLoopDelayMs: round(loopDelay.max / 1e6),
      gcCount: gcs.length,
      gcMs: round(gcs.reduce((total, gc) => total + gc.cost, 0) / 1000),
      ...extra,
    };

    results.push(result);
    out.append(file, result);
    return result;
  }

  return {
    start,
    end,
    results,
    // The label of the phase in progress, or null.
    current: () => (current ? current.label : null),
    stop() {
      clearInterval(timer);
      loopDelay.disable();
    },
  };
}

// Counts Redis commands and approximate reply sizes, by subscribing to
// node-redis' diagnostics channels. These see plain commands and each
// command of a pipeline (node-redis:command), and MULTI/EXEC transactions
// (node-redis:batch: counted under MULTI, as many commands as the
// transaction held, without their names). Commands answered from the
// client-side cache never reach Redis and aren't counted.
//
// scope() is called as each command starts, in the caller's async context
// (e.g. to read an AsyncLocalStorage store), and its result is passed to
// onCommand(scope, name, count, replyBytes, ms) when the command finishes.
//
// An older release's node-redis may publish nothing on these channels; then
// the totals stay at zero and summary() says so.
function trackRedis({ scope, onCommand } = {}) {
  const totals = { commands: 0, replyBytes: 0, byCommand: {} };
  const pending = new WeakMap();

  function subscribe(channel, getName, getCount) {
    diagnosticsChannel.tracingChannel(channel).subscribe({
      start(context) {
        if (getName(context) === null) return;
        pending.set(context, { started: performance.now(), scope: scope ? scope() : undefined });
      },
      asyncEnd(context) {
        const command = pending.get(context);
        if (!command) return;
        pending.delete(context);

        const name = getName(context);
        const count = getCount(context);
        const bytes = approxSize(context.result);
        const ms = performance.now() - command.started;
        const entry = (totals.byCommand[name] = totals.byCommand[name] || {
          count: 0,
          replyBytes: 0,
          ms: 0,
        });
        entry.count += count;
        entry.replyBytes += bytes;
        entry.ms += ms;
        totals.commands += count;
        totals.replyBytes += bytes;
        if (onCommand) onCommand(command.scope, name, count, bytes, ms);
      },
    });
  }

  subscribe(
    "node-redis:command",
    (context) => String(context.command || "?").toUpperCase(),
    () => 1
  );
  // Pipelines are already counted command by command above.
  subscribe(
    "node-redis:batch",
    (context) => (context.batchMode === "MULTI" ? "MULTI" : null),
    (context) => context.batchSize || 0
  );

  return {
    totals,
    summary() {
      return {
        ...(totals.commands
          ? {}
          : { note: "no commands seen: this release's node-redis may not publish them" }),
        commands: totals.commands,
        replyMB: mb(totals.replyBytes),
        byCommand: Object.fromEntries(
          Object.entries(totals.byCommand).map(([name, c]) => [
            name,
            { count: c.count, ms: Math.round(c.ms), replyMB: mb(c.replyBytes) },
          ])
        ),
      };
    },
  };
}

function approxSize(value) {
  if (value == null) return 0;
  if (typeof value === "string") return value.length;
  if (Buffer.isBuffer(value)) return value.length;
  if (Array.isArray(value)) {
    let n = 0;
    for (const item of value) n += approxSize(item);
    return n;
  }
  if (value instanceof Map) {
    let n = 0;
    for (const [key, item] of value) n += approxSize(key) + approxSize(item);
    return n;
  }
  if (typeof value === "object") {
    let n = 0;
    for (const key of Object.keys(value)) n += key.length + approxSize(value[key]);
    return n;
  }
  return 8;
}

module.exports = {
  round,
  mb,
  now,
  output,
  startSampler,
  heapSpaces,
  measurePhases,
  trackRedis,
};

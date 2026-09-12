const os = require("os");
const { performance } = require("perf_hooks");

const MB = 1024 * 1024;

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, p) {
  if (!values.length) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(p * sorted.length) - 1;
  const clamped = Math.max(0, Math.min(sorted.length - 1, index));

  return sorted[clamped];
}

function summarizeDurations(values) {
  const cleaned = values.filter((value) => Number.isFinite(value) && value >= 0);

  if (!cleaned.length) {
    return {
      count: 0,
      total: 0,
      mean: 0,
      min: 0,
      max: 0,
      p50: 0,
      p95: 0,
    };
  }

  return {
    count: cleaned.length,
    total: cleaned.reduce((sum, value) => sum + value, 0),
    mean: average(cleaned),
    min: Math.min(...cleaned),
    max: Math.max(...cleaned),
    p50: percentile(cleaned, 0.5),
    p95: percentile(cleaned, 0.95),
  };
}

class PhaseMonitor {
  constructor(options = {}) {
    this.sampleIntervalMs = Number(options.sampleIntervalMs) || 250;
    this.cpuCoreCount =
      typeof os.availableParallelism === "function"
        ? os.availableParallelism()
        : os.cpus().length;

    this.timer = null;
    this.startedAt = 0;
    this.endedAt = 0;
    this.startCpu = null;
    this.lastCpu = null;
    this.lastSampleAt = 0;
    this.startResourceUsage = null;
    this.cpuPercentSamples = [];
    this.rssSamples = [];
    this.heapUsedSamples = [];
  }

  start() {
    this.startedAt = performance.now();
    this.startCpu = process.cpuUsage();
    this.lastCpu = process.cpuUsage();
    this.lastSampleAt = this.startedAt;

    if (typeof process.resourceUsage === "function") {
      this.startResourceUsage = process.resourceUsage();
    }

    this.captureSample();

    this.timer = setInterval(() => {
      this.captureSample();
    }, this.sampleIntervalMs);

    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  captureSample() {
    const now = performance.now();

    const currentCpu = process.cpuUsage();
    const userMicros = currentCpu.user - this.lastCpu.user;
    const systemMicros = currentCpu.system - this.lastCpu.system;
    const cpuMs = (userMicros + systemMicros) / 1000;
    const elapsedMs = Math.max(1, now - this.lastSampleAt);

    this.lastCpu = currentCpu;
    this.lastSampleAt = now;

    this.cpuPercentSamples.push((cpuMs / elapsedMs) * 100);

    const memoryUsage = process.memoryUsage();

    this.rssSamples.push(memoryUsage.rss / MB);
    this.heapUsedSamples.push(memoryUsage.heapUsed / MB);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.captureSample();

    this.endedAt = performance.now();

    const wallMs = this.endedAt - this.startedAt;
    const cpuUsage = process.cpuUsage(this.startCpu);
    const totalCpuMs = (cpuUsage.user + cpuUsage.system) / 1000;

    let maxRssResourceMb = 0;
    let fsReadOps = 0;
    let fsWriteOps = 0;

    if (typeof process.resourceUsage === "function") {
      const endResourceUsage = process.resourceUsage();
      maxRssResourceMb = endResourceUsage.maxRSS / 1024;

      // fsRead/fsWrite are cumulative-since-process-start block I/O counts
      // (getrusage's ru_inblock/ru_oublock), so a phase's share is the delta
      // against the snapshot taken in start(). Counts blocks, not bytes —
      // useful as a relative regression signal, not an absolute size.
      if (this.startResourceUsage) {
        fsReadOps = Math.max(
          0,
          endResourceUsage.fsRead - this.startResourceUsage.fsRead
        );
        fsWriteOps = Math.max(
          0,
          endResourceUsage.fsWrite - this.startResourceUsage.fsWrite
        );
      }
    }

    return {
      timing_ms: {
        total: wallMs,
      },
      cpu: {
        user_ms: cpuUsage.user / 1000,
        system_ms: cpuUsage.system / 1000,
        avg_percent: wallMs > 0 ? (totalCpuMs / wallMs) * 100 : 0,
        peak_percent: this.cpuPercentSamples.length
          ? Math.max(...this.cpuPercentSamples)
          : 0,
        avg_percent_of_machine:
          wallMs > 0 && this.cpuCoreCount > 0
            ? ((totalCpuMs / wallMs) * 100) / this.cpuCoreCount
            : 0,
      },
      disk_io: {
        fs_read_ops: fsReadOps,
        fs_write_ops: fsWriteOps,
        total_ops: fsReadOps + fsWriteOps,
      },
      memory_mb: {
        avg_rss: average(this.rssSamples),
        peak_rss: this.rssSamples.length ? Math.max(...this.rssSamples) : 0,
        avg_heap_used: average(this.heapUsedSamples),
        peak_heap_used: this.heapUsedSamples.length
          ? Math.max(...this.heapUsedSamples)
          : 0,
        max_rss_resource: maxRssResourceMb,
      },
    };
  }
}

module.exports = {
  PhaseMonitor,
  summarizeDurations,
  percentile,
  average,
};

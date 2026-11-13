import os from "os";

// The macserver process's CPU and memory, and the host's, for /stats.
//
// CPU is a percentage of one core (200 is two cores flat out), as top and ps
// report it: cpu_percent since the previous call (Blot asks every minute), and
// cpu_percent_average since the process started. The first call, with nothing
// to compare with, gives the average for both.

const percentOfOneCore = (cpuMicros, elapsedMs) =>
  elapsedMs > 0 ? Math.round(cpuMicros / 10 / elapsedMs) : 0;

const total = ({ user, system }) => user + system;

export function createProcessStats({
  cpuUsage = () => process.cpuUsage(),
  memoryUsage = () => process.memoryUsage(),
  uptime = () => process.uptime(),
  now = () => Date.now(),
  host = os,
} = {}) {
  let last = null;

  return () => {
    const cpu = cpuUsage();
    const time = now();
    const uptimeMs = uptime() * 1000;
    const average = percentOfOneCore(total(cpu), uptimeMs);
    const recent = last
      ? percentOfOneCore(total(cpu) - total(last.cpu), time - last.time)
      : average;

    last = { cpu, time };

    return {
      cpu_percent: recent,
      cpu_percent_average: average,
      cpu_count: host.cpus().length,
      load_average: host.loadavg()[0],
      memory_rss_bytes: memoryUsage().rss,
      host_memory_free_bytes: host.freemem(),
      host_memory_total_bytes: host.totalmem(),
      uptime_seconds: Math.round(uptimeMs / 1000),
    };
  };
}

export default createProcessStats();

// Writes two days of synthetic collector logs for the compare.js spec: a
// "baseline" (2026-10-07) and a "squeeze" on 2026-10-08 12:00-16:00 in which
// CPU 0 does everything, latency is 3x worse and the app logs slow heartbeats.
// A BGSAVE runs in every other minute. Layout matches fetch.sh's output:
//   <dir>/redis/{redis-sample,latency-redis-local}.log
//   <dir>/app/{latency-app-to-redis,app-lock}.log
const fs = require("fs");
const path = require("path");

const iso = (t) => new Date(t).toISOString().slice(0, 19) + "Z";
const START = Date.UTC(2026, 9, 7, 0, 0);
const SQUEEZE_FROM = (36 * 60) | 0; // minute index of 2026-10-08T12:00
const SQUEEZE_TO = 40 * 60;

module.exports = function writeSyntheticLogs(dir) {
  fs.mkdirSync(path.join(dir, "redis"), { recursive: true });
  fs.mkdirSync(path.join(dir, "app"), { recursive: true });
  const sample = [], local = [], remote = [], locks = [];
  let mem = 1000;
  for (let m = 0; m < 48 * 60; m++) {
    const t = START + m * 60000;
    const squeeze = m >= SQUEEZE_FROM && m < SQUEEZE_TO;
    const bg = m % 2 === 0 ? 1 : 0;
    const k = squeeze ? 3 : 1;
    mem += (squeeze ? 1 : 0) + (m % 60 < 5 ? 3 : m % 60 < 10 ? -3 : 0);
    // The sample at T covers the minute before it; the probe is stamped with its start.
    sample.push(
      `${iso(t + 60000)} dt=60 cpu0_busy=${20 * k + bg * 10} cpu0_usr=10 cpu0_sys=5 cpu0_irq=1 cpu0_si=${4 * k} ` +
        `cpu1_busy=${squeeze ? 0.5 : 15} cpu1_si=${squeeze ? 0 : 2} netrx0=${1000 * k} netrx1=${squeeze ? 0 : 900} ` +
        `nettx0=500 nettx1=400 psi10=${(0.5 * k * k).toFixed(2)} psi60=1.00 rcpu_sys=1.00 rcpu_usr=2.00 ` +
        `rcpu_csys=${bg * 5}.00 rcpu_cusr=0.00 bgsave=${bg} bgsaves=${bg} bg_active=${bg} bgsave_sec=${squeeze ? 45 : 30} ` +
        `bgsave_status=ok fork_us=${squeeze ? 90000 : 60000} cow_b=5242880 cmds=${6000 * k} in_b=9000000 out_b=18000000 ` +
        `ops=100 conns_new=3 clients=60 slowlen=0 slowid=-1 slow_new=0 latmon=off tcpmem=${mem}`
    );
    const probe = (label, f) =>
      `${iso(t)} label=${label} n=1090 err=0 reconn=0 conn_ms=0.200 p50=0.100 p90=0.200 p99=${(0.5 * f * (1 + bg) * k).toFixed(3)} ` +
      `p999=${(2 * f * (1 + bg) * k).toFixed(3)} max=${(5 * f * (1 + bg) * k * (m % 7 === 0 ? 20 : 1)).toFixed(3)} max_sec=12 ` +
      `gt10=${bg * k} gt50=0 gt100=0 gt1000=0 burst_ms=${(20 * k * (1 + bg)).toFixed(1)} burst_n=17857`;
    local.push(probe("redis-local", 1));
    remote.push(probe("app-to-redis", 2));
    if (squeeze && m % 10 === 0) locks.push(`${iso(t)} container=green slow=${m % 20 ? 1 : 3} compromised=0`);
  }
  const write = (file, lines) => fs.writeFileSync(path.join(dir, file), lines.join("\n") + "\n");
  write("redis/redis-sample.log", sample);
  write("redis/latency-redis-local.log", local);
  write("app/latency-app-to-redis.log", remote);
  write("app/app-lock.log", locks);
};

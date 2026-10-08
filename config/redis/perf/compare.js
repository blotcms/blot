#!/usr/bin/env node
// Usage: node compare.js --baseline <from>..<to> --test <from>..<to>
//          [--match-hours] [--data <dir>] [--redis-dir <dir>] [--app-dir <dir>]
//
// Prints a side-by-side summary of the logs fetch.sh copied into
// data/redis-perf/<host>/ for two time windows (UTC, [from, to)):
//   --baseline 2026-10-07T00:00..2026-10-08T00:00 --test 2026-10-08T13:00..16:00
// A time is YYYY-MM-DD, YYYY-MM-DDTHH or YYYY-MM-DDTHH:MM; the end of a window
// may be just HH or HH:MM, meaning that time on the start's date (or the next
// day if it is not later). --match-hours keeps only the baseline minutes whose
// UTC hour of day is one the test window covers, so a 24h baseline is compared
// with the same hours of the day as the test (the :00 backups, the evening
// traffic, ...) rather than with its quietest hours too.
//
// Every distribution reads "p50 / p90 / p99 / max" over the one-minute
// samples of the window. The latency lines are also split into the minutes in
// which a BGSAVE was running (redis-sample.log's bg_active=1) and the rest.
// No dependencies; plain node.
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const args = { data: path.join(__dirname, "..", "..", "..", "data", "redis-perf") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--match-hours") args.matchHours = true;
    else if (/^--(baseline|test|data|redis-dir|app-dir)$/.test(a)) {
      if (argv[i + 1] === undefined) throw new Error(a + " needs a value");
      args[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i];
    } else throw new Error("unknown argument " + a);
  }
  if (!args.baseline || !args.test) throw new Error("--baseline and --test are required");
  return args;
}

// "2026-10-08", "2026-10-08T13", "2026-10-08T13:30" (UTC) -> ms, or null
function parseTime(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::(\d{2}))?)?Z?$/.exec(s);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
}

function parseWindow(spec) {
  const parts = spec.split("..");
  if (parts.length !== 2) throw new Error("window must look like <from>..<to>: " + spec);
  const from = parseTime(parts[0]);
  if (from === null) throw new Error("bad start time: " + parts[0]);
  let to = parseTime(parts[1]);
  if (to === null) {
    const m = /^(\d{1,2})(?::(\d{2}))?Z?$/.exec(parts[1]);
    if (!m) throw new Error("bad end time: " + parts[1]);
    const day = from - (from % 86400000);
    to = day + +m[1] * 3600000 + +(m[2] || 0) * 60000;
    if (to <= from) to += 86400000;
  }
  if (to <= from) throw new Error("window ends before it starts: " + spec);
  return { spec, from, to };
}

// ------------------------------------------------------------------ parsing

// "<ts> k=v k=v ..." -> { t, f }. x becomes null, numbers become numbers.
function parseLine(line) {
  const tok = line.trim().split(/\s+/);
  const t = Date.parse(tok[0]);
  if (!tok[0] || isNaN(t)) return null;
  const f = {};
  for (const kv of tok.slice(1)) {
    const eq = kv.indexOf("=");
    if (eq < 1) continue;
    const v = kv.slice(eq + 1);
    f[kv.slice(0, eq)] = v === "x" ? null : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  }
  return { t, f };
}

// Reads <file>.1 (rotated) then <file>; missing files are just empty.
function readLog(file) {
  const out = [];
  for (const p of [file + ".1", file]) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const r = line && parseLine(line);
      if (r) out.push(r);
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

// The directory holding <name>: the one given, or the only sub-directory of root that has it.
function findDir(root, given, name, option) {
  if (given) return given;
  if (!fs.existsSync(root)) return null;
  const found = fs.readdirSync(root).sort().map((d) => path.join(root, d)).filter(
    (p) => fs.statSync(p).isDirectory() && (fs.existsSync(path.join(p, name)) || fs.existsSync(path.join(p, name + ".1")))
  );
  if (found.length > 1) throw new Error("more than one directory under " + root + " has " + name + " (" + found.map((p) => path.basename(p)).join(", ") + "): pass " + option + " to say which");
  return found[0] || null;
}

function load(args) {
  const redisDir = findDir(args.data, args.redisDir, "redis-sample.log", "--redis-dir");
  const appDir = findDir(args.data, args.appDir, "latency-app-to-redis.log", "--app-dir");
  const rd = (dir, name) => (dir ? readLog(path.join(dir, name)) : []);
  const lockRecords = rd(appDir, "app-lock.log").map((r) => ({ t: r.t, container: r.f.container, slow: r.f.slow || 0, compromised: r.f.compromised || 0 }));
  return {
    samples: rd(redisDir, "redis-sample.log"),
    probes: { "redis-local": rd(redisDir, "latency-redis-local.log"), "app-to-redis": rd(appDir, "latency-app-to-redis.log") },
    locks: lockRecords,
    hasLocks: !!appDir && fs.existsSync(path.join(appDir, "app-lock.log")),
  };
}

// --------------------------------------------------------------- statistics

const nums = (arr) => arr.filter((v) => typeof v === "number" && isFinite(v));

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function fmtNum(v) {
  if (v === null || v === undefined || isNaN(v)) return "-";
  if (Number.isInteger(v)) return String(v);
  const a = Math.abs(v);
  if (a >= 1000) return String(Math.round(v));
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

// "p50 / p90 / p99 / max (n)" of an array of numbers
function dist(arr) {
  const v = nums(arr).sort((a, b) => a - b);
  if (!v.length) return "-";
  return [0.5, 0.9, 0.99].map((q) => fmtNum(quantile(v, q))).concat(fmtNum(v[v.length - 1])).join(" / ");
}

const sum = (arr) => nums(arr).reduce((a, b) => a + b, 0);
const mean = (arr) => {
  const v = nums(arr);
  return v.length ? sum(v) / v.length : null;
};
const per = (a, b) => (typeof a === "number" && typeof b === "number" && b > 0 ? a / b : null);

// ------------------------------------------------------------------ windows

function inWindow(win, t) {
  if (t < win.from || t >= win.to) return false;
  return !win.hours || win.hours.has(new Date(t).getUTCHours());
}

function hoursOf(win) {
  const hours = new Set();
  for (let t = win.from - (win.from % 3600000); t < win.to; t += 3600000) hours.add(new Date(t).getUTCHours());
  return hours;
}

// A sample is stamped with the end of the dt seconds it covers; the window
// it belongs to is the one holding the middle of that interval.
function sampleTime(s) {
  return typeof s.f.dt === "number" ? s.t - s.f.dt * 500 : s.t;
}

// One-minute samples only: install-time (short) and after-a-gap (long)
// intervals have counters that do not belong to one minute of the window.
const MIN_DT = 30;
const MAX_DT = 90;
const isGap = (s) => typeof s.f.dt === "number" && s.f.dt > MAX_DT;

// Index the samples by the minute they cover. A sample taken at T with dt
// seconds covers (T - dt, T]; its midpoint falls in the minute the probe that
// started at that minute ran in. Short (install) or very long (gap) intervals
// do not join.
function sampleIndex(samples) {
  const idx = new Map();
  for (const s of samples) {
    const dt = s.f.dt;
    if (typeof dt !== "number" || dt < MIN_DT || dt > MAX_DT) continue;
    idx.set(Math.floor(sampleTime(s) / 60000), s);
  }
  return idx;
}

const notOk = (s) => typeof s.f.bgsave_status === "string" && s.f.bgsave_status !== "ok";

// The samples at which a BGSAVE had failed since the sample before: the status
// is not ok and the last known status (an x does not reset it) was ok or unknown.
// Over all the samples, so a window that starts in a streak of err counts none.
function failedSaveSamples(samples) {
  const failed = new Set();
  let wasOk = true;
  for (const s of samples) {
    if (typeof s.f.bgsave_status !== "string") continue;
    if (notOk(s) && wasOk) failed.add(s);
    wasOk = !notOk(s);
  }
  return failed;
}

// ------------------------------------------------------------------- report

// rows: [label, text] pairs; a null label is a section heading.
function report(win, data, ctx) {
  const rows = [];
  const head = (t) => rows.push([null, t]);
  const row = (label, text) => rows.push([label, text]);

  const inWin = data.samples.filter((s) => inWindow(win, sampleTime(s)));
  const samples = inWin.filter((s) => !(typeof s.f.dt === "number" && (s.f.dt < MIN_DT || s.f.dt > MAX_DT)));
  const col = (name) => samples.map((s) => s.f[name]);
  const secs = (name) => samples.map((s) => per(s.f[name], s.f.dt)); // per second

  head("Window");
  row("one-minute samples", String(samples.length));
  if (inWin.some(isGap)) row("samples dropped (gap over " + MAX_DT + "s)", String(inWin.filter(isGap).length));

  // ---- latency probes
  for (const label of ctx.labels) {
    const all = data.probes[label].filter((r) => inWindow(win, r.t));
    head("Latency probe: " + label + " (PING every 50ms; ms)");
    row("probe minutes", String(all.length));
    if (!all.length) continue;
    const g = (name, rs) => (rs || all).map((r) => r.f[name]);
    const pings = sum(g("n"));
    const frac = (name) => {
      const c = sum(g(name));
      return fmtNum(c) + " (" + (pings ? fmtNum((100 * c) / pings) : "-") + "%)";
    };
    row("p50 per minute", dist(g("p50")));
    row("p99 per minute", dist(g("p99")));
    row("p99.9 per minute", dist(g("p999")));
    row("max per minute", dist(g("max")));
    row("pings over 10ms", frac("gt10"));
    row("pings over 50ms", frac("gt50"));
    row("pings over 100ms", frac("gt100"));
    row("pings over 1s", frac("gt1000"));
    row("minutes with max over 1s", String(nums(g("max")).filter((v) => v > 1000).length));
    row("errors / reconnects", sum(g("err")) + " / " + sum(g("reconn")));
    row("connect time", dist(g("conn_ms")));
    row("250KB burst (burst_ms)", dist(g("burst_ms")));
    row("minutes with failed burst", String(all.filter((r) => r.f.burst_ms === null && r.f.burst_n !== null).length));
    row("probe runs cut by hard timeout", String(all.filter((r) => r.f.timeout === 1).length));

    // by BGSAVE running in that minute
    let unknown = 0;
    const buckets = { "BGSAVE running": [], "no BGSAVE": [] };
    for (const r of all) {
      const s = ctx.index.get(Math.floor(r.t / 60000));
      if (!s || s.f.bg_active === null || s.f.bg_active === undefined) unknown++;
      else buckets[s.f.bg_active ? "BGSAVE running" : "no BGSAVE"].push(r);
    }
    for (const name of Object.keys(buckets)) {
      const rs = buckets[name];
      row("[" + name + "] minutes", String(rs.length));
      if (!rs.length) continue;
      row("  p99 per minute", dist(g("p99", rs)));
      row("  p99.9 per minute", dist(g("p999", rs)));
      row("  max per minute", dist(g("max", rs)));
      row("  pings over 10ms", fmtNum(sum(g("gt10", rs))) + " of " + fmtNum(sum(g("n", rs))));
      row("  pings over 100ms", fmtNum(sum(g("gt100", rs))));
      row("  burst_ms", dist(g("burst_ms", rs)));
    }
    if (unknown) row("minutes with no matching sample", String(unknown));
  }

  // ---- BGSAVE
  head("BGSAVE");
  const done = samples.filter((s) => s.f.bgsaves === 1);
  row("saves completed", String(done.length));
  row("minutes with a save running", samples.length ? fmtNum((100 * samples.filter((s) => s.f.bg_active === 1).length) / samples.length) + "%" : "-");
  row("duration, s", dist(done.map((s) => s.f.bgsave_sec)));
  row("fork time, ms", dist(done.map((s) => (s.f.fork_us === null ? null : s.f.fork_us / 1000))));
  row("copy-on-write, MB", dist(done.map((s) => (s.f.cow_b === null ? null : s.f.cow_b / 1048576))));
  // rdb_last_bgsave_status stays err until the next good save, so count the
  // samples where it went to err, and separately the minutes it was in err.
  row("failed saves (status went to err)", String(samples.filter((s) => ctx.failedSaves.has(s)).length));
  row("minutes with last save failed", String(samples.filter((s) => notOk(s)).length));

  // ---- CPU
  head("CPU, % of each CPU (per minute)");
  for (const cpu of ctx.cpus) {
    for (const [k, name] of [["busy", "busy"], ["usr", "user"], ["sys", "system"], ["si", "softirq"], ["irq", "irq"], ["steal", "steal"]]) {
      if (k === "steal" && !(sum(col(cpu + "_steal")) > 0)) continue;
      row(cpu + " " + name, dist(col(cpu + "_" + k)));
    }
  }
  for (const cpu of ctx.cpus) {
    const n = cpu.replace("cpu", "");
    row("NET_RX/s on " + cpu, dist(secs("netrx" + n)));
    row("NET_TX/s on " + cpu, dist(secs("nettx" + n)));
  }
  const hasPsi = samples.some((s) => s.f.psi10 !== undefined && s.f.psi10 !== null);
  row("CPU pressure some avg10, %", hasPsi ? dist(col("psi10")) : "not available");
  row("CPU pressure some avg60, %", hasPsi ? dist(col("psi60")) : "not available");

  // ---- Redis
  head("Redis");
  const pct = (a, b) => samples.map((s) => (s.f[a] === null || s.f[b] === null || !s.f.dt ? null : (100 * (s.f[a] + s.f[b])) / s.f.dt));
  row("server CPU, % of one CPU", dist(pct("rcpu_sys", "rcpu_usr")));
  row("fork child CPU, % of one CPU", dist(pct("rcpu_csys", "rcpu_cusr")));
  row("commands/s", dist(secs("cmds")));
  row("net in, KB/s", dist(secs("in_b").map((v) => (v === null ? null : v / 1024))));
  row("net out, KB/s", dist(secs("out_b").map((v) => (v === null ? null : v / 1024))));
  row("connected clients", dist(col("clients")));
  row("new connections/min", dist(col("conns_new")));
  row("new slowlog entries (total)", fmtNum(sum(col("slow_new"))));

  // ---- TCP memory
  head("TCP memory (pages)");
  const mem = samples.filter((s) => s.f.tcpmem !== null && s.f.tcpmem !== undefined);
  const v = mem.map((s) => s.f.tcpmem);
  const last = v.length - 1;
  row("min / mean / max", v.length ? fmtNum(Math.min(...v)) + " / " + fmtNum(mean(v)) + " / " + fmtNum(Math.max(...v)) : "-");
  // Drift: the change within each hour, so windows that skip hours still make sense.
  const byHour = new Map();
  for (const s of mem) {
    const h = Math.floor(s.t / 3600000);
    if (!byHour.has(h)) byHour.set(h, []);
    byHour.get(h).push(s.f.tcpmem);
  }
  const drifts = [...byHour.values()].filter((a) => a.length >= 2).map((a) => a[a.length - 1] - a[0]);
  row("change within an hour: mean / min / max", drifts.length ? fmtNum(mean(drifts)) + " / " + fmtNum(Math.min(...drifts)) + " / " + fmtNum(Math.max(...drifts)) : "-");
  row("first -> last in window", v.length ? fmtNum(v[0]) + " -> " + fmtNum(v[last]) + " (" + (v[last] - v[0] >= 0 ? "+" : "") + fmtNum(v[last] - v[0]) + ")" : "-");

  // ---- app lock heartbeats
  head("App sync-lock lines (all containers)");
  if (!data.hasLocks) row("[LOCK] lines", "no app-lock.log fetched");
  else {
    const ls = data.locks.filter((r) => inWindow(win, r.t));
    row("[LOCK] slow heartbeat lines", String(sum(ls.map((r) => r.slow))));
    row("minutes with a slow heartbeat", String(new Set(ls.filter((r) => r.slow).map((r) => r.t)).size));
    row("[LOCK COMPROMISED] lines", String(sum(ls.map((r) => r.compromised))));
    for (const c of ["blue", "green", "yellow"]) {
      const n = sum(ls.filter((r) => r.container === c).map((r) => r.slow));
      if (n) row("  slow heartbeats, " + c, String(n));
    }
  }
  return rows;
}

// Lines up two reports by section and label, not by position: a row that one
// window leaves out (no steal, an empty probe, ...) must not shift the others.
// The order is the baseline's; a row only the test has goes right after the row
// that precedes it in the test report.
function merge(a, b) {
  const keyed = (rows) => {
    let section = "";
    return rows.map(([label, text]) => {
      if (label === null) section = text;
      return { key: section + "\n" + (label === null ? "" : label), label, text };
    });
  };
  const merged = keyed(a).map((r) => ({ key: r.key, label: r.label, a: r.text, b: null }));
  let prev = null;
  for (const r of keyed(b)) {
    let at = merged.findIndex((m) => m.key === r.key);
    if (at < 0) {
      at = prev === null ? 0 : merged.findIndex((m) => m.key === prev) + 1;
      merged.splice(at, 0, { key: r.key, label: r.label, a: null, b: null });
    }
    merged[at].b = r.text;
    prev = r.key;
  }
  return merged;
}

function table(baseWin, testWin, a, b, data) {
  const rows = merge(a, b);
  const w0 = Math.max(...rows.map((r) => (r.label || "").length), 20);
  const w1 = Math.max(...rows.map((r) => (r.a || "").length), 24, "baseline".length);
  const lines = [];
  lines.push("".padEnd(w0) + "  " + "baseline".padEnd(w1) + "  test");
  lines.push("window".padEnd(w0) + "  " + windowLabel(baseWin).padEnd(w1) + "  " + windowLabel(testWin));
  for (const r of rows) {
    if (r.label === null) lines.push("", "== " + (r.a === null ? r.b : r.a) + " ==");
    else lines.push(r.label.padEnd(w0) + "  " + (r.a === null ? "-" : r.a).padEnd(w1) + "  " + (r.b === null ? "-" : r.b));
  }
  if (data.hasLocks) lines.push("", "Lock counts come from docker logs, which start when a container was created: a deploy during the test empties them.");
  return lines.join("\n");
}

function windowLabel(win) {
  const iso = (t) => new Date(t).toISOString().slice(0, 16) + "Z";
  const hrs = (win.to - win.from) / 3600000;
  return iso(win.from) + ".." + iso(win.to) + " (" + fmtNum(hrs) + "h" + (win.hours ? ", hours " + [...win.hours].sort((x, y) => x - y).join(",") : "") + ")";
}

function main(argv) {
  const args = parseArgs(argv);
  const baseline = parseWindow(args.baseline);
  const test = parseWindow(args.test);
  if (args.matchHours) baseline.hours = hoursOf(test);

  const data = load(args);
  const labels = Object.keys(data.probes).filter((l) => data.probes[l].length);
  const cpus = [];
  for (const s of data.samples) {
    for (const k of Object.keys(s.f)) {
      const m = /^(cpu\d+)_busy$/.exec(k);
      if (m && !cpus.includes(m[1])) cpus.push(m[1]);
    }
  }
  cpus.sort();
  const ctx = { labels, cpus, index: sampleIndex(data.samples), failedSaves: failedSaveSamples(data.samples) };
  if (!data.samples.length && !labels.length) throw new Error("no logs found under " + args.data + " (run fetch.sh first, or pass --data / --redis-dir / --app-dir)");

  return table(baseline, test, report(baseline, data, ctx), report(test, data, ctx), data);
}

module.exports = { main, parseWindow, parseLine, quantile };

if (require.main === module) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (e) {
    console.error("error: " + e.message);
    process.exit(1);
  }
}

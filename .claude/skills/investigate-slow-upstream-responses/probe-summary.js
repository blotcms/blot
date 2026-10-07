#!/usr/bin/env node
// Summarise a render-probe run: per request, the duration, Redis commands and
// reply size, and the costliest phases; then, if the run used --cpu-prof, the
// functions with the most self time.
//
//   node probe-summary.js data/render-probe/<run> [--phases 6] [--functions 25]

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const opt = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i === -1 ? dflt : parseInt(args[i + 1], 10);
};
if (!dir) {
  console.log("Usage: node probe-summary.js data/render-probe/<run> [--phases 6] [--functions 25]");
  process.exit(1);
}

const ndjson = (file) => {
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);
};

const requests = ndjson("requests.ndjson");
const phases = ndjson("phases.ndjson");
const byReq = {};
for (const p of phases) if (p.req) (byReq[p.req] = byReq[p.req] || []).push(p);

console.log("## Requests (first of each URL is cold, later ones warm)\n");
for (const r of requests) {
  const top = (byReq[r.id] || [])
    .slice()
    .sort((a, b) => b.ms - a.ms)
    .slice(0, opt("phases", 6))
    .map((p) => `${p.name} ${p.ms}ms`)
    .join(", ");
  console.log(
    `${r.id.padEnd(9)} ${String(r.status).padEnd(3)} ${String(r.ms).padStart(6)}ms ` +
      `redis=${String(r.redisCommands).padStart(5)} (${r.redisReplyMB}MB) ${r.url}`
  );
  if (top) console.log(`          ${top}`);
}

const gcs = phases.filter((p) => !p.req);
if (gcs.length) console.log(`\n${gcs.length} non-request phases (GC pauses >100ms etc.): ` + gcs.slice(0, 5).map((p) => `${p.name} ${p.ms}ms`).join(", "));

const profiles = fs.readdirSync(dir).filter((f) => f.endsWith(".cpuprofile"));
for (const file of profiles) {
  const prof = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  const dt = {};
  for (let i = 0; i < prof.samples.length; i++) {
    const delta = prof.timeDeltas[i] || 0;
    dt[prof.samples[i]] = (dt[prof.samples[i]] || 0) + delta;
  }
  const self = {};
  let total = 0;
  for (const node of prof.nodes) {
    const t = (dt[node.id] || 0) / 1000;
    if (!t) continue;
    total += t;
    const cf = node.callFrame;
    const file = (cf.url || "").replace(/^.*\/(app|node_modules)\//, "$1/");
    const key = `${cf.functionName || "(anonymous)"} ${file}${file ? ":" + (cf.lineNumber + 1) : ""}`;
    self[key] = (self[key] || 0) + t;
  }
  console.log(`\n## CPU profile ${file}: ${Math.round(total)}ms sampled, top self time\n`);
  Object.entries(self)
    .sort((a, b) => b[1] - a[1])
    .slice(0, opt("functions", 25))
    .forEach(([k, t]) => console.log(`${String(Math.round(t)).padStart(7)}ms ${((t * 100) / total).toFixed(1).padStart(5)}%  ${k}`));
}

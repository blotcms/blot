// Turns a results.jsonl from run.js into markdown tables.
//
//   node scripts/benchmarks/git-store/report.js [results.jsonl]
//
// Where a run was repeated, the latest row for each (suite, repo, profile,
// phase, change) is the one shown.
const fs = require("fs");
const os = require("os");
const path = require("path");

const file = process.argv[2] || process.env.GIT_STORE_SPIKE_RESULTS || path.join(process.env.GIT_STORE_SPIKE_WORK || path.join(os.tmpdir(), "git-store-spike"), "results.jsonl");
const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

const latest = new Map();
for (const row of rows) {
  const key = [row.suite, row.repo, row.profile, row.phase, row.change, row.behindPushes, row.scenario, row.case, row.pushes, row.packs].join("|");
  latest.set(key, row);
}

const num = (n) => (typeof n === "number" ? (Math.abs(n) >= 100 ? Math.round(n).toLocaleString("en-US") : String(Math.round(n * 10) / 10)) : n === undefined || n === null ? "" : String(n));
const mb = (bytes) => (typeof bytes === "number" ? num(bytes / 1048576) : "");

const COLUMNS = {
  advertise: [["repo"], ["profile"], ["phase"], ["ms", "ms", num], ["requests", "requests", num], ["bytesIn", "MB in", mb]],
  clone: [["repo"], ["profile"], ["phase"], ["ms", "s", (v) => num(v / 1000)], ["requests", "requests", num], ["bytesIn", "MB in", mb], ["packBytes", "pack MB", mb], ["objects", "objects", num], ["skipped", "dupes skipped", num], ["rssPeakMB", "peak RSS MB", num], ["trailerOk", "checksum ok"]],
  "clone-git": [["repo"], ["profile"], ["cloneOk", "git clone ok"], ["fsckOk", "fsck --strict ok"], ["objects", "objects", num], ["ms", "ms", num]],
  fetch: [["repo"], ["profile"], ["phase"], ["behindPushes", "pushes behind"], ["ms", "ms", num], ["requests", "requests", num], ["bytesIn", "MB in", mb], ["packBytes", "pack MB", mb], ["floor"], ["walked", "commits walked", num], ["packsSent", "packs sent", num]],
  "fetch-git": [["repo"], ["profile"], ["ok"], ["commitsBefore", "commits before", num], ["commitsAfter", "commits after", num], ["ms", "ms", num], ["requests", "requests", num], ["bytesIn", "MB in", mb]],
  materialize: [["repo"], ["profile"], ["phase"], ["change"], ["paths", "paths", num], ["matchesDiffTree", "= diff-tree"], ["ms", "ms", num], ["requests", "requests", num], ["bytesIn", "MB in", mb], ["rssPeakMB", "peak RSS MB", num]],
  push: [["repo"], ["profile"], ["phase"], ["change"], ["ok"], ["packBytesIn", "pack bytes", num], ["thinBaseCandidates", "bases wanted", num], ["thinBasesFetched", "bases fetched", num], ["ms", "ms", num], ["requests", "requests", num], ["gets", "GETs", num], ["heads", "HEADs", num], ["puts", "PUTs", num], ["bytesIn", "MB in", mb], ["bytesOut", "MB out", mb], ["manifestBytes", "manifest B", num]],
  "push-verify": [["repo"], ["profile"], ["cloneOk", "git clone ok"], ["fsckOk", "fsck --strict ok"], ["objects", "objects", num]],
  commit: [["repo"], ["profile"], ["phase"], ["ms", "ms", num], ["requests", "requests", num], ["gets", "GETs", num], ["heads", "HEADs", num], ["puts", "PUTs", num], ["bytesIn", "KB in", (v) => num(v / 1024)], ["bytesOut", "KB out", (v) => num(v / 1024)], ["manifestBytes", "manifest B", num]],
  commit300: [["profile"], ["commits", "commits", num], ["ms", "total s", (v) => num(v / 1000)], ["perCommitMedianMs", "median ms", num], ["perCommitP95Ms", "p95 ms", num], ["requests", "requests", num], ["bytesOut", "MB out", mb], ["bytesIn", "MB in", mb], ["manifestBytesBefore", "manifest B before", num], ["manifestBytesAfter", "manifest B after", num], ["packsBefore", "packs before", num], ["leftBehind", "manifest objects", (v) => num(v.manifests)], ["leftBehind", "manifest objects, MB", (v) => mb(v.manifestBytes)], ["leftBehind", "packs after", (v) => num(v.packs)]],
  after300: [["profile"], ["phase"], ["ms", "ms", num], ["requests", "requests", num], ["bytesIn", "KB in", (v) => num(v / 1024)]],
  index: [["repo"], ["profile"], ["phase"], ["packs", "packs", num], ["objects", "objects", num], ["cacheMB", "cache MB", num], ["requestsPerLookup", "requests/lookup", num], ["kbPerLookup", "KB/lookup", num], ["msPerLookup", "ms/lookup", num], ["cacheMB_used", "cache used MB", num]],
  history: [["repo"], ["profile"], ["commits", "commits", num], ["historyPackBytes", "history pack KB", (v) => num(v / 1024)], ["historyIdxBytes", "idx KB", (v) => num(v / 1024)], ["bytesPerCommit", "bytes/commit", num], ["requests", "requests", num], ["ms", "ms (fetch + walk)", num], ["floor"]],
  growth: [["pushes", "pushes", num], ["manifestBytes", "manifest bytes", num], ["manifestBytesWithoutSnapshots", "without snapshots", num], ["manifestObjects", "manifest objects", num], ["allManifestObjectsBytes", "all manifest objects, MB", mb]],
  failure: [["scenario"], ["case"], ["outcome"], ["ok"], ["errors"], ["hung"], ["wrong"], ["requestAttempts", "request attempts", num], ["objectVisible"], ["objectIntact"], ["incompleteUploadsLeft", "incomplete uploads left"], ["gitCloneExit", "git exit"], ["gitFsckOk", "fsck ok"], ["trials"], ["acknowledged"], ["rejected"], ["rejectedButLanded", "rejected but landed"], ["acknowledgedButMissing", "acked but missing"]],
};

const out = [];
for (const [suite, columns] of Object.entries(COLUMNS)) {
  const list = [...latest.values()].filter((row) => row.suite === suite);
  if (!list.length) continue;
  const used = columns.filter(([name]) => list.some((row) => row[name] !== undefined));
  out.push("### " + suite, "", "| " + used.map(([name, label]) => label || name).join(" | ") + " |", "|" + used.map(() => "---").join("|") + "|");
  for (const row of list) out.push("| " + used.map(([name, , format]) => (format ? format(row[name]) : row[name] === undefined ? "" : String(row[name]))).join(" | ") + " |");
  out.push("");
}
console.log(out.join("\n"));

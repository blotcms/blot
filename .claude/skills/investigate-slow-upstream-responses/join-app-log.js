#!/usr/bin/env node
// Join slow nginx requests to the app containers' own log lines by request id.
//
//   ssh blot "for c in blue green yellow; do docker logs blot-container-\$c 2>&1; done \
//     | grep -E '^\[[^]]+\] \[[a-z-]+\] [0-9a-f]{32} ([0-9]{3} [0-9.]+ |Connection closed)'" > app.log
//   node join-app-log.js access.log.gz app.log [--threshold 0.1] [--host <host>] [--top 40]
//
// For each slow page request (st ≥ threshold, long-lived routes skipped):
//   app      the app's own duration (request-logger.js response line)
//   queued   st − app: time before the app's middleware ran, i.e. waiting
//            behind other work on the same process
//   elu      event-loop utilisation over the request: ~1 CPU-bound, ~0 I/O
//   slowest  the longest gap between req.log steps and the step it led to
//            (only on lines logged after that field was added)

const fs = require("fs");
const readline = require("readline");
const { parseLine, classify, read, median, ms, shortUA } = require("./triage");

const RESPONSE = /^\[[^\]]+\] \[([a-z-]+)\] ([0-9a-f]{32}) (\d{3}) ([0-9.]+) (\S+) elu=([0-9.]+)(?: slowest=\+(\d+)ms:(".*"))?/;
const CLOSED = /^\[[^\]]+\] \[([a-z-]+)\] ([0-9a-f]{32}) Connection closed by client/;

function parseArgs(argv) {
  const opts = { files: [], threshold: 0.1, top: 40 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--threshold") opts.threshold = parseFloat(argv[++i]);
    else if (a === "--host") opts.host = argv[++i];
    else if (a === "--top") opts.top = parseInt(argv[++i], 10);
    else opts.files.push(a);
  }
  return opts;
}

async function readApp(file) {
  const byId = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    let m = RESPONSE.exec(line);
    if (m) {
      byId.set(m[2], {
        container: m[1],
        status: +m[3],
        app: parseFloat(m[4]),
        elu: parseFloat(m[6]),
        slowest: m[7] ? `+${m[7]}ms ${JSON.parse(m[8])}` : "",
      });
      continue;
    }
    m = CLOSED.exec(line);
    if (m && !byId.has(m[2])) byId.set(m[2], { container: m[1], closed: true });
  }
  return byId;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.files.length < 2) {
    console.log(fs.readFileSync(__filename, "utf8").split("\n\n")[0].replace(/^#.*\n/, "").replace(/^\/\/ ?/gm, ""));
    return;
  }
  const appFile = opts.files.pop();
  const app = await readApp(appFile);

  const slow = [];
  await read(opts.files, (r) => {
    if (r.st < opts.threshold) return;
    if (opts.host && r.host !== opts.host) return;
    if (classify(r.hostPath).kind !== "page") return;
    slow.push(r);
  });

  const joined = slow.filter((r) => app.has(r.id));
  const rows = joined.map((r) => ({ r, a: app.get(r.id) }));
  const done = rows.filter(({ a }) => !a.closed);
  const queued = done.filter(({ r, a }) => r.st - a.app > r.st / 2);
  const own = done.filter(({ r, a }) => r.st - a.app <= r.st / 2);
  const cpu = own.filter(({ a }) => a.elu >= 0.8);
  const io = own.filter(({ a }) => a.elu < 0.3);

  console.log(`Slow page requests: ${slow.length}; found in app log: ${joined.length} (the rest predate the containers' logs, or are cache-layer only)`);
  console.log(`  closed by client before the app answered: ${rows.length - done.length}`);
  console.log(`  mostly queued (st − app > st/2): ${queued.length}`);
  console.log(`  mostly the app's own time: ${own.length} — CPU-bound (elu ≥ 0.8) ${cpu.length}, I/O-bound (elu < 0.3) ${io.length}`);

  const steps = {};
  for (const { a } of own) {
    if (!a.slowest) continue;
    const step = a.slowest.replace(/^\+\d+ms /, "").replace(/\d+/g, "N").slice(0, 50);
    (steps[step] = steps[step] || []).push(parseInt(a.slowest.slice(1), 10));
  }
  const stepRows = Object.entries(steps).sort((x, y) => y[1].length - x[1].length);
  if (stepRows.length) {
    console.log(`\n## Slowest step of requests that were mostly their own time`);
    for (const [step, gaps] of stepRows.slice(0, 15))
      console.log(`  ${String(gaps.length).padStart(5)}× median +${median(gaps)}ms  ${step}`);
  }

  console.log(`\n## Slowest by app time (own cost first)`);
  console.log(`  ${"st".padStart(6)} ${"app".padStart(6)} ${"queued".padStart(6)}  elu  container status id url [slowest step]`);
  rows
    .sort((x, y) => (y.a.app || 0) - (x.a.app || 0))
    .slice(0, opts.top)
    .forEach(({ r, a }) => {
      if (a.closed) return console.log(`  ${ms(r.st).padStart(6)} ${"closed".padStart(6)} ${"".padStart(6)}       ${a.container} ${r.id} ${r.url.slice(0, 90)}`);
      console.log(
        `  ${ms(r.st).padStart(6)} ${ms(a.app).padStart(6)} ${ms(Math.max(0, r.st - a.app)).padStart(6)}  ${a.elu.toFixed(2)} ${a.container} ${a.status} ${r.id} ${r.url.slice(0, 90)} ua=${shortUA(r.ua)}${a.slowest ? ` [${a.slowest}]` : ""}`
      );
    });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

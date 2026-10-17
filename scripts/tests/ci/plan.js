// Splits node.yml's TEST_SUITES between the CI test jobs. Each job runs a few
// lanes in parallel (scripts/tests/ci/run-lanes.sh); a lane is a sequence of
// test runner processes, each running some of one suite's spec files.
//
// Every test job runs this itself (the matrix is just the job numbers, so
// jobs needn't wait for a planning job), so the plan must be deterministic:
// it depends only on TEST_SUITES, the checked-out spec files and timings.json.
//
//  1. Each spec file is weighted by its seconds in timings.json. A file
//     missing from it gets its suite's leftover seconds split evenly (a
//     suite-level entry, keyed by the suite as written in TEST_SUITES), or
//     DEFAULT_FILE.
//  2. Suites are placed heaviest first, each suite's files longest first,
//     each file kept on a lane already running its suite while that lane is
//     within an even share of the work, else put where it finishes soonest. A
//     lane runs one process per suite it was given, each costing
//     PROCESS_OVERHEAD (container start, module loading).
//  3. The lanes are dealt out to the jobs longest first, snaking, so jobs
//     end at about the same time.
//
// Usage (TEST_SUITES in the environment):
//   node scripts/tests/ci/plan.js --runners=10 --lanes=2 --runner=3
//     prints runner 3's lanes as JSON: [[{ suite, part, files }, ...], ...]
//   node scripts/tests/ci/plan.js --runners=10 --lanes=2
//     prints the whole plan, for reading
//   node scripts/tests/ci/plan.js --suites
//     prints the distinct suite paths (JSON), for node.yml's check that every
//     spec file is run
//
// TEST_SUITES format, one per line: "<path>[|<exclude>,<exclude>...]".
// Refresh timings.json from a test run: see scripts/tests/ci/README.

const fs = require("fs");
const listSpecFiles = require("../util/listSpecFiles");
const timings = require("./timings.json");

const DEFAULT_FILE = 5;
const PROCESS_OVERHEAD = 6;

function parseArgs(argv) {
  const flags = {};
  for (const arg of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
  }
  return flags;
}

function parseSuites(text) {
  return text
    .split("\n")
    .map((raw) => raw.replace(/^\s*-?\s*/, "").trim())
    .filter(Boolean)
    .map((line) => {
      // A ":<shards>" suffix from the old format is ignored
      const key = line.split(":")[0];
      const [suite, ...excludes] = key.split("|");
      return { key, suite, excludes: excludes.join(",").split(",").filter(Boolean) };
    });
}

// Files under a tests/ directory that declare no specs (shared helpers, fake
// servers) are left out: a process given only those would fail with "No specs
// found", and the specs that need them require them anyway.
function declaresSpecs(file) {
  return /\b(describe|it)\s*\(/.test(fs.readFileSync(file, "utf8"));
}

function weighFiles(suite) {
  const files = listSpecFiles(suite.suite, suite.excludes).filter(declaresSpecs);
  const known = files.filter((f) => timings[f] !== undefined);
  const unknown = files.length - known.length;
  const knownSeconds = known.reduce((sum, f) => sum + timings[f], 0);
  const fallback =
    timings[suite.key] !== undefined && unknown
      ? Math.max(1, (timings[suite.key] - knownSeconds) / unknown)
      : DEFAULT_FILE;
  return files.map((file) => ({
    file,
    seconds: timings[file] !== undefined ? timings[file] : fallback,
  }));
}

function plan(suites, runners, lanesPerRunner) {
  const lanes = Array.from({ length: runners * lanesPerRunner }, () => ({
    seconds: 0,
    bySuite: new Map(),
  }));

  // A file stays with its suite - on the lightest lane already running it -
  // while that lane stays within an even share of the work; otherwise it goes
  // where it would finish soonest, counting PROCESS_OVERHEAD if that lane has
  // to start a process for its suite. Ties go to the lower lane, and suites
  // and files are ordered by name too, so every job computes the same plan.
  // Heaviest suite first, then each suite's files longest first, so a suite's
  // files are placed together and fill the lanes it already runs on.
  const bySeconds = (a, b) => b.seconds - a.seconds || (a.name < b.name ? -1 : 1);
  const files = suites
    .map((suite) => {
      const weighed = weighFiles(suite).map((f) => ({ ...f, name: f.file, suite: suite.suite }));
      return { name: suite.key, files: weighed, seconds: weighed.reduce((t, f) => t + f.seconds, 0) };
    })
    .sort(bySeconds)
    .flatMap((suite) => suite.files.sort(bySeconds));

  const processes = new Set(files.map((f) => f.suite)).size;
  const work = files.reduce((sum, f) => sum + f.seconds, 0);
  const share = (work + processes * PROCESS_OVERHEAD) / lanes.length;
  const endOn = (lane, f) =>
    lane.seconds + f.seconds + (lane.bySuite.has(f.suite) ? 0 : PROCESS_OVERHEAD);

  for (const f of files) {
    let best = null;
    for (const lane of lanes)
      if (lane.bySuite.has(f.suite) && endOn(lane, f) <= share)
        if (!best || lane.seconds < best.seconds) best = lane;
    if (!best)
      for (const lane of lanes) if (!best || endOn(lane, f) < endOn(best, f)) best = lane;
    const end = endOn(best, f);
    if (!best.bySuite.has(f.suite)) best.bySuite.set(f.suite, []);
    best.bySuite.get(f.suite).push(f.file);
    best.seconds = end;
  }

  // Label each suite's processes "i/n" across all lanes, for the logs
  const partCount = {};
  for (const lane of lanes)
    for (const suite of lane.bySuite.keys()) partCount[suite] = (partCount[suite] || 0) + 1;
  const partIndex = {};
  const planned = lanes
    .filter((lane) => lane.bySuite.size)
    .map((lane) => ({
      seconds: lane.seconds,
      items: [...lane.bySuite.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([suite, laneFiles]) => {
          partIndex[suite] = (partIndex[suite] || 0) + 1;
          const part = `${partIndex[suite]}/${partCount[suite]}`;
          return { name: `${suite} ${part}`, suite, part, files: laneFiles.sort() };
        }),
    }));

  // Deal the lanes out longest first, snaking across the jobs, so jobs end
  // at about the same time
  const byRunner = Array.from({ length: runners }, () => []);
  planned
    .sort((a, b) => b.seconds - a.seconds)
    .forEach((lane, i) => {
      const round = Math.floor(i / runners);
      const r = round % 2 === 0 ? i % runners : runners - 1 - (i % runners);
      byRunner[r].push(lane);
    });
  return byRunner;
}

if (require.main === module) {
  const flags = parseArgs(process.argv.slice(2));
  const suites = parseSuites(process.env.TEST_SUITES || "");
  if (!suites.length) throw new Error("TEST_SUITES is empty");

  if (flags.suites) {
    console.log(JSON.stringify([...new Set(suites.map((s) => s.suite))].sort()));
    process.exit(0);
  }

  const runners = parseInt(flags.runners, 10);
  const lanes = parseInt(flags.lanes, 10);
  if (!(runners >= 1) || !(lanes >= 1)) throw new Error("Pass --runners=N --lanes=N");
  const byRunner = plan(suites, runners, lanes);

  if (flags.runner) {
    const mine = byRunner[parseInt(flags.runner, 10) - 1] || [];
    console.log(
      JSON.stringify(
        mine.map((lane) =>
          lane.items.map(({ suite, part, files }) => ({ suite, part, files }))
        )
      )
    );
  } else {
    byRunner.forEach((runnerLanes, r) => {
      const longest = Math.max(0, ...runnerLanes.map((l) => l.seconds));
      console.log(`runner ${r + 1} (~${Math.round(longest)}s):`);
      runnerLanes.forEach((lane, i) =>
        console.log(
          `  lane ${i + 1} (~${Math.round(lane.seconds)}s): ` +
            lane.items.map((p) => p.name).join(", ")
        )
      );
    });
  }
}

module.exports = { parseSuites, plan };

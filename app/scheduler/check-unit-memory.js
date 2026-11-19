// Emails the admin when a unit or its sandbox runs out of memory, or is about
// to (blotcms/blot#2795):
//
// - An oom_kill counter rising in a unit's cgroup (blot-blue, blot-green) or in
//   a sandbox cgroup (blot-sandbox-<unit>, blot-sandbox-<unit>-browser): the
//   kernel killed a process in it. The counter is cumulative per cgroup, so a
//   lower value means the container was replaced (a deploy) and starts a new
//   baseline. At most one email per name per OOM_MIN_INTERVAL: kills in
//   between are counted in the next email.
// - A unit's anon+shmem, the memory that can't be reclaimed, over
//   MEMORY_ALERT of its limit. Page cache is left out, since the cgroup
//   reclaims it. Emailed when it starts and when it clears.
// - The sample no longer being updated, which means the monitoring stopped.
//
// The host's sampler (config/host/scripts/unit-mem-log.sh, cron, every minute)
// stores its latest sample at SAMPLE_KEY, since the units can't read each
// other's cgroups. Host memory is not checked here: check-redis-host.js does.
//
// Print the report without sending email:
//   NODE_PATH=app node app/scheduler/check-unit-memory.js
const SAMPLE_KEY = "blot:unit-mem:latest";
const STATE_KEY = "blot:unit-mem:alerts";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const MEMORY_ALERT = 0.85;
const MEMORY_CLEAR = 0.8;
// The sampler runs every minute and the check every 5.
const STALE_MS = 10 * MINUTE;
// A stale reading must hold for this many checks in a row: after Redis was
// away, the sampler needs a minute to catch up.
const STALE_CHECKS = 2;
const OOM_MIN_INTERVAL = HOUR;

const MiB = 1024 * 1024;
const mib = (bytes) => Math.round(bytes / MiB) + " MiB";
const percent = (fraction) => Math.round(fraction * 100) + "%";
const minutes = (ms) => Math.round(ms / MINUTE) + " minutes";
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// "2026-11-19T10:00:45Z name=blot-blue anon=B shmem=B limit=B oom_kill=N" per
// line: { time, containers: { name: { anon, shmem, limit, oom } } }, with the
// time of the newest line. Lines that can't be read are skipped; null if none
// can be.
function parseSample(value) {
  if (!value) return null;

  const containers = {};
  let time = 0;

  String(value)
    .split("\n")
    .forEach((line) => {
      const [stamp, ...pairs] = line.trim().split(/\s+/);
      const fields = {};
      pairs.forEach((pair) => {
        const i = pair.indexOf("=");
        if (i > 0) fields[pair.slice(0, i)] = pair.slice(i + 1);
      });
      const at = Date.parse(stamp);
      const numbers = ["anon", "shmem", "limit", "oom_kill"].map((key) =>
        /^\d+$/.test(fields[key] || "") ? Number(fields[key]) : null
      );

      if (!at || !/^[\w-]+$/.test(fields.name || "")) return;
      if (numbers.includes(null)) return;

      time = Math.max(time, at);
      containers[fields.name] = {
        anon: numbers[0],
        shmem: numbers[1],
        limit: numbers[2],
        oom: numbers[3],
      };
    });

  return time ? { time, containers } : null;
}

// Sandbox cgroups have a limit of their own but come and go with each job, so
// only the units are judged on anon+shmem.
const isUnit = (name) => !name.startsWith("blot-sandbox-");

async function check(deps = {}) {
  const {
    now = Date.now(),
    client = require("models/client"),
    keep = unwritten,
  } = deps;

  // sendCommand keeps these off the client-side cache: the sample is written
  // by another client
  const [sampleValue, stateValue] = await Promise.all([
    client.sendCommand(["GET", SAMPLE_KEY]),
    client.sendCommand(["GET", STATE_KEY]),
  ]);

  let state;
  try {
    state = JSON.parse(stateValue) || {};
  } catch (e) {
    state = {};
  }
  // The state a run could not write to Redis (see run()), if it is newer
  if (keep.state && (keep.state.updatedAt || 0) > (state.updatedAt || 0))
    state = keep.state;
  state = {
    updatedAt: state.updatedAt || 0,
    // { name: { count, mailedAt } }: the oom_kill count last emailed (or first
    // seen) for each cgroup
    oom: state.oom || {},
    // { condition: when it started }
    alerts: state.alerts || {},
    staleChecks: state.staleChecks || 0,
  };

  const sample = parseSample(sampleValue);
  const age = sample ? now - sample.time : null;
  const report = {
    now,
    sample,
    age,
    kills: [],
    memory: {},
    started: [],
    cleared: [],
    state,
  };
  const alerts = { ...state.alerts };
  const oom = { ...state.oom };
  let staleChecks = state.staleChecks;

  // No sample at all: the host's script isn't installed yet. Nothing to judge.
  if (sample) {
    if (age <= STALE_MS) staleChecks = 0;
    else staleChecks += 1;

    const stale = staleChecks >= STALE_CHECKS;
    const set = (name, on) => {
      if (on && !(name in alerts)) {
        alerts[name] = now;
        report.started.push(name);
      } else if (!on && name in alerts) {
        delete alerts[name];
        report.cleared.push(name);
      }
    };

    set("sample-stale", stale);

    // A stale sample says nothing about memory now
    if (age <= STALE_MS) {
      Object.keys(sample.containers).forEach((name) => {
        const { anon, shmem, limit, oom: count } = sample.containers[name];

        // Rising counter. The first sight of a cgroup is a baseline, unless
        // an earlier run has already read the sample, in which case the
        // cgroup is new since and a kill in it counts from zero.
        const previous = oom[name];
        if (!previous) {
          if (state.updatedAt && count > 0) {
            report.kills.push({ name, from: 0, to: count });
            oom[name] = { count, mailedAt: now };
          } else {
            oom[name] = { count, mailedAt: 0 };
          }
        } else if (count < previous.count) {
          // Replaced: a new counter
          oom[name] = { count, mailedAt: previous.mailedAt };
        } else if (
          count > previous.count &&
          now - previous.mailedAt >= OOM_MIN_INTERVAL
        ) {
          report.kills.push({ name, from: previous.count, to: count });
          oom[name] = { count, mailedAt: now };
        }
        // else: nothing new, or held back, with the baseline kept so the
        // kills count in the next email

        if (isUnit(name) && limit > 0) {
          const fraction = (anon + shmem) / limit;
          report.memory[name] = { used: anon + shmem, limit, fraction };
          const was = `memory:${name}` in alerts;
          set(
            `memory:${name}`,
            fraction >= (was ? MEMORY_CLEAR : MEMORY_ALERT)
          );
        }
      });

      // A unit that is gone (mid-deploy) has no memory to be near the limit
      Object.keys(alerts).forEach((name) => {
        const unit = name.replace(/^memory:/, "");
        if (name.startsWith("memory:") && !(unit in sample.containers))
          set(name, false);
      });
    }
  }

  report.send =
    report.started.length > 0 ||
    report.cleared.length > 0 ||
    report.kills.length > 0;
  report.nextState = {
    updatedAt: now,
    oom,
    alerts,
    staleChecks,
  };

  return report;
}

const titleOf = (name) =>
  name === "sample-stale"
    ? "Unit memory sample stale"
    : `${name.replace(/^memory:/, "")} memory near its limit`;

function explain(name, report) {
  if (name === "sample-stale") {
    return `the host's sample of unit memory is ${minutes(report.age)} old: \`unit-mem-log.sh\` stopped running from \`/etc/cron.d/blot-unit-mem\`, or Redis refused its write`;
  }

  const { used, limit, fraction } = report.memory[name.replace(/^memory:/, "")];
  return `anon+shmem (memory that can't be reclaimed) is ${mib(used)} of the ${mib(limit)} limit (${percent(fraction)}). Past the limit the kernel kills a process in the unit`;
}

// What the email template renders
function view(report) {
  const kills = report.kills.map((kill) => ({
    title: `${kill.name} out of memory`,
    message: `oom_kill rose from ${kill.from} to ${kill.to}: the kernel killed ${plural(kill.to - kill.from, "process")} in this cgroup`,
  }));
  const started = report.started.map((name) => ({
    title: titleOf(name),
    message: explain(name, report),
  }));
  const alerts = kills.concat(started);
  const recovered = report.cleared.map((name) => ({ title: titleOf(name) }));

  const readings = Object.keys(report.memory).map((name) => {
    const { used, limit, fraction } = report.memory[name];
    return `${name}: anon+shmem ${mib(used)} of ${mib(limit)} (${percent(fraction)})`;
  });
  if (report.sample) readings.push(`Sampled ${minutes(report.age)} ago`);

  return {
    summary: alerts.length
      ? alerts.map((a) => a.title).join(", ")
      : "recovered: " + recovered.map((r) => r.title).join(", "),
    hasAlerts: alerts.length > 0,
    alerts,
    hasRecovered: recovered.length > 0,
    recovered,
    readings,
    thresholds: {
      memory: percent(MEMORY_ALERT),
      stale: minutes(STALE_MS),
      oomInterval: Math.round(OOM_MIN_INTERVAL / HOUR) + " hour",
    },
  };
}

// The latest state that could not be written to Redis, kept in this process
// until a write succeeds
const unwritten = { state: null };

// Runs the check, emails what started, cleared or was killed, and saves the
// state. deps.sendEmail(view) must reject on failure; then nothing is saved,
// so the next run tries again. Resolves to { report, sent }.
async function run(deps = {}) {
  const sendEmail = deps.sendEmail || (async () => {});
  const client = deps.client || require("models/client");
  const keep = deps.keep || unwritten;
  const report = await check({ ...deps, client, keep });

  if (report.send) await sendEmail(view(report));

  if (JSON.stringify(report.nextState) !== JSON.stringify(report.state)) {
    try {
      await client.sendCommand([
        "SET",
        STATE_KEY,
        JSON.stringify(report.nextState),
      ]);
      keep.state = null;
    } catch (err) {
      // The email is out; without the new state the next run would send it
      // again, so use it from here until a write gets through.
      keep.state = report.nextState;
      console.log(
        "Unit memory check: could not save its state to Redis:",
        err && err.message
      );
    }
  }

  return { report, sent: report.send };
}

module.exports = run;
module.exports.check = check;
module.exports.view = view;
module.exports.parseSample = parseSample;
module.exports.SAMPLE_KEY = SAMPLE_KEY;
module.exports.STATE_KEY = STATE_KEY;
module.exports.MEMORY_ALERT = MEMORY_ALERT;
module.exports.MEMORY_CLEAR = MEMORY_CLEAR;
module.exports.STALE_MS = STALE_MS;
module.exports.OOM_MIN_INTERVAL = OOM_MIN_INTERVAL;

if (require.main === module) {
  check()
    .then((report) => {
      console.log(JSON.stringify({ ...report, view: view(report) }, null, 2));
      process.exit();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

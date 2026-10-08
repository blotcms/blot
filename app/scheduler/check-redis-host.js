// Warns the operator before the Redis host hits a limit (blotcms/blot#2041):
//
// - The kernel's TCP memory count nearing tcp_mem[1], where TCP memory
//   pressure starts. A kernel bug once leaked this count upwards until bursts
//   to Redis were dropped. Only the Redis host can read the count, so its
//   5-minute cron (config/redis/bin/tcpmem-log.sh) stores each sample in Redis
//   at SAMPLE_KEY, and this check reads it. A sample that stops arriving means
//   that monitoring stopped, which is alerted too.
// - Redis's memory nearing maxmemory. With noeviction, writes fail at the
//   limit. maxmemory being unset is alerted too, but only on a host that
//   cutover has marked active: the hand-built host it replaces has none.
//
// Conditions are states, emailed once when they start and once when they
// clear (with a few points of hysteresis, so a reading hovering at a threshold
// does not flap). A rise in the host's TCP memory pressure counter is an
// event, emailed each time. What has been emailed is kept in Redis at
// STATE_KEY, so it survives restarts and deploys.
//
// When Redis itself is unreachable this check fails quietly: that outage is
// /redis-health's to report, not this check's.
//
// Print the report without sending email or saving anything:
//   NODE_PATH=app node app/scheduler/check-redis-host.js
const SAMPLE_KEY = "blot:redis-host:tcpmem";
const STATE_KEY = "blot:redis-host:alerts";

const MINUTE = 60 * 1000;

// Leaked or not, healthy use is a tiny fraction of tcp_mem[1] (dozens of
// sockets with empty queues), and the leak drifted up over months, so half
// leaves weeks of warning and is far above any real load.
const TCP_MEM_ALERT = 0.5;
const TCP_MEM_CLEAR = 0.45;

// Leaves room to raise maxmemory or move to a bigger instance before writes
// fail. maxmemory is ~70% of RAM, so 80% of it is ~56% of RAM, still clear of
// the copy-on-write a background save needs.
const MAXMEMORY_ALERT = 0.8;
const MAXMEMORY_CLEAR = 0.75;

// The host samples every 5 minutes, so this is three missed samples.
const STALE_MS = 20 * MINUTE;

// The check runs every 5 minutes. A sample can only be judged stale if the
// previous check also read Redis within this long: after an outage (or a
// restart of this process) the host needs one cron run to catch up, or every
// outage over 20 minutes would end with a false stale alert.
const CONTINUOUS_MS = 11 * MINUTE;

const TITLES = {
  "tcp-mem": "TCP memory nearing tcp_mem[1]",
  "tcp-pressure": "TCP memory pressure",
  "sample-stale": "TCP memory sample stale",
  maxmemory: "Redis memory nearing maxmemory",
  "maxmemory-unset": "maxmemory not set",
};

const percent = (fraction) => Math.round(fraction * 100) + "%";
const gb = (bytes) => (bytes / 1024 / 1024 / 1024).toFixed(2) + "GB";
const minutes = (ms) => Math.round(ms / MINUTE) + " minutes";

// "2026-10-07T12:00:00Z mem=123 tcp_mem=1,2,3 sockets=25 pressures=0 ...
// host=ip-10-0-0-1 active=1" (tcpmem-log.sh). Null if it can't be read.
function parseSample(value) {
  if (!value) return null;

  const [stamp, ...pairs] = String(value).trim().split(/\s+/);
  const fields = {};
  pairs.forEach((pair) => {
    const i = pair.indexOf("=");
    if (i > 0) fields[pair.slice(0, i)] = pair.slice(i + 1);
  });

  const time = Date.parse(stamp);
  const mem = Number(fields.mem);
  const tcpMem = String(fields.tcp_mem || "").split(",").map(Number);

  if (!time || !fields.mem || !(mem >= 0)) return null;
  if (tcpMem.length !== 3 || !tcpMem.every((n) => n > 0)) return null;

  const pressures = Number(fields.pressures);

  return {
    time,
    mem,
    tcpMem,
    sockets: Number(fields.sockets),
    pressures: fields.pressures !== "" && pressures >= 0 ? pressures : null,
    host: String(fields.host || "unknown").replace(/[^\w.-]/g, ""),
    active: fields.active === "1",
  };
}

// The INFO memory fields we need. maxmemory is compared with used_memory less
// what Redis leaves out of it (replica output buffers, the AOF buffer), as
// Redis does, so a replica's full sync doesn't look like the dataset growing.
function parseMemory(text) {
  const fields = {};
  String(text)
    .split(/\r?\n/)
    .forEach((line) => {
      const i = line.indexOf(":");
      if (i > 0) fields[line.slice(0, i)] = line.slice(i + 1).trim();
    });

  const used = Number(fields.used_memory);
  if (!(used >= 0) || fields.maxmemory === undefined) {
    throw new Error("INFO memory has no used_memory or maxmemory");
  }

  return {
    used: used - (Number(fields.mem_not_counted_for_evict) || 0),
    maxmemory: Number(fields.maxmemory) || 0,
  };
}

// Is the state on? A fraction above `alert` turns it on; one that was on stays
// on until it drops below `clear`.
const above = (fraction, wasOn, alert, clear) => fraction >= (wasOn ? clear : alert);

// Reads everything and works out each condition. A condition is true, false,
// or undefined when it can't be told right now (no fresh sample), which leaves
// its state alone.
async function check(deps = {}) {
  const {
    now = Date.now(),
    client = require("models/client"),
    lastCheckAt = null,
  } = deps;

  // sendCommand keeps these off the client-side cache: the sample changes
  // every 5 minutes, written by another client.
  const [sampleValue, stateValue, info] = await Promise.all([
    client.sendCommand(["GET", SAMPLE_KEY]),
    client.sendCommand(["GET", STATE_KEY]),
    client.sendCommand(["INFO", "memory"]),
  ]);

  let state;
  try {
    state = JSON.parse(stateValue) || {};
  } catch (e) {
    state = {};
  }
  state = { alerts: state.alerts || {}, pressures: state.pressures || null };

  const was = (name) => name in state.alerts;
  const memory = parseMemory(info);
  const sample = parseSample(sampleValue);
  const age = sample ? now - sample.time : null;
  const continuous = lastCheckAt !== null && now - lastCheckAt <= CONTINUOUS_MS;
  const conditions = {};
  let pressures = state.pressures;
  let pressureRise = null;

  // No sample at all: the host's script isn't installed yet. Nothing to judge.
  if (sample) {
    if (age <= STALE_MS) conditions["sample-stale"] = false;
    else if (continuous) conditions["sample-stale"] = true;
  }

  const fresh = conditions["sample-stale"] === false;

  if (fresh) {
    sample.fraction = sample.mem / sample.tcpMem[1];
    conditions["tcp-mem"] = above(sample.fraction, was("tcp-mem"), TCP_MEM_ALERT, TCP_MEM_CLEAR);
    conditions["maxmemory-unset"] = sample.active && memory.maxmemory === 0;

    // The counter is per host and since boot: a new host, or a reboot, starts
    // a new baseline without an alert.
    if (sample.pressures !== null) {
      const sameHost = pressures && pressures.host === sample.host;
      if (sameHost && sample.pressures > pressures.count) {
        pressureRise = { from: pressures.count, to: sample.pressures };
      }
      pressures = { host: sample.host, count: sample.pressures };
    }
  }

  if (memory.maxmemory > 0) {
    memory.fraction = memory.used / memory.maxmemory;
    conditions.maxmemory = above(memory.fraction, was("maxmemory"), MAXMEMORY_ALERT, MAXMEMORY_CLEAR);
  } else {
    conditions.maxmemory = false;
  }

  const started = Object.keys(conditions).filter((name) => conditions[name] && !was(name));
  const cleared = Object.keys(conditions).filter((name) => conditions[name] === false && was(name));

  const alerts = { ...state.alerts };
  started.forEach((name) => (alerts[name] = now));
  cleared.forEach((name) => delete alerts[name]);

  return {
    now,
    sample,
    age,
    memory,
    conditions,
    started,
    cleared,
    pressureRise,
    state,
    nextState: { alerts, pressures },
  };
}

function message(name, report) {
  const { sample, memory, age, pressureRise } = report;

  switch (name) {
    case "tcp-mem":
      return `${sample.mem} pages, ${percent(sample.fraction)} of tcp_mem[1] (${sample.tcpMem[1]}) on ${sample.host}`;
    case "tcp-pressure":
      return `TCPMemoryPressures rose from ${pressureRise.from} to ${pressureRise.to} on ${sample.host}: the kernel was rationing TCP buffers, so bursts to Redis may have been dropped`;
    case "sample-stale":
      return `the last sample from ${sample.host} is ${minutes(age)} old`;
    case "maxmemory":
      return `${gb(memory.used)} of ${gb(memory.maxmemory)} (${percent(memory.fraction)})`;
    case "maxmemory-unset":
      return `maxmemory is 0 on ${sample.host}, which cutover marked active`;
  }
}

// What the email template renders
function view(report) {
  const { sample, memory, age } = report;
  const alerts = report.started.slice();
  if (report.pressureRise) alerts.push("tcp-pressure");

  const item = (name) => ({ title: TITLES[name], message: message(name, report) });
  const recovered = report.cleared.map((name) => ({ title: TITLES[name] }));

  const summary = alerts.length
    ? alerts.map((name) => TITLES[name]).join(", ")
    : "recovered: " + recovered.map((r) => r.title).join(", ");

  const readings = [];
  if (sample) {
    readings.push(
      `TCP memory on ${sample.host}: ${sample.mem} pages, ` +
        `${percent(sample.mem / sample.tcpMem[1])} of tcp_mem[1] (tcp_mem ${sample.tcpMem.join(" ")}), ` +
        `${sample.sockets} sockets, pressures=${sample.pressures}, sampled ${minutes(age)} ago`
    );
  }
  readings.push(
    memory.maxmemory
      ? `Redis memory: ${gb(memory.used)} of maxmemory ${gb(memory.maxmemory)} (${percent(memory.used / memory.maxmemory)})`
      : `Redis memory: ${gb(memory.used)}, no maxmemory`
  );

  return {
    summary,
    hasAlerts: alerts.length > 0,
    alerts: alerts.map(item),
    hasRecovered: recovered.length > 0,
    recovered,
    readings,
    thresholds: {
      tcpMem: percent(TCP_MEM_ALERT),
      maxmemory: percent(MAXMEMORY_ALERT),
      stale: minutes(STALE_MS),
    },
  };
}

// Runs the check, emails what started, rose or cleared, and saves the state.
// deps.sendEmail(view) must reject on failure; then nothing is saved, so the
// next run tries again. Resolves to { report, sent }.
async function run(deps = {}) {
  const sendEmail = deps.sendEmail || (async () => {});
  const client = deps.client || require("models/client");
  const report = await check({ ...deps, client });
  const send = report.started.length > 0 || report.cleared.length > 0 || !!report.pressureRise;

  if (send) await sendEmail(view(report));

  if (JSON.stringify(report.nextState) !== JSON.stringify(report.state)) {
    await client.sendCommand(["SET", STATE_KEY, JSON.stringify(report.nextState)]);
  }

  return { report, sent: send };
}

module.exports = run;
module.exports.check = check;
module.exports.view = view;
module.exports.parseSample = parseSample;
module.exports.parseMemory = parseMemory;
module.exports.SAMPLE_KEY = SAMPLE_KEY;
module.exports.STATE_KEY = STATE_KEY;

if (require.main === module) {
  // As if the previous check ran just now, so a stale sample is reported
  check({ lastCheckAt: Date.now() })
    .then((report) => {
      console.log(JSON.stringify({ ...report, view: view(report) }, null, 2));
      process.exit();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

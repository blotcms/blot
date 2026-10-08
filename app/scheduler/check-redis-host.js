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
// - A failed background save. With stop-writes-on-bgsave-error yes Redis
//   refuses every write until a save succeeds.
// - Events since the last check (redis-host-events.js): errors that mean Redis
//   refused writes, other errors in bulk, rejected connections, a restart or
//   switch to another host, and slow commands.
//
// Conditions are states, emailed once when they start and once when they
// clear (with a few points of hysteresis, so a reading hovering at a threshold
// does not flap). A rise in the host's TCP memory pressure counter is an
// event, like those above. What has been emailed, and the counters events are
// measured from, are kept in Redis at STATE_KEY, so they survive restarts and
// deploys.
//
// Nothing can flood the inbox: a condition's emails are at least
// CONDITION_MIN_INTERVAL apart and an event type's at least EVENT_COOLDOWN
// apart, with what happened in between merged into the next one.
//
// When Redis itself is unreachable this check fails quietly: that outage is
// /redis-health's to report, not this check's.
//
// Print the report without sending email or saving anything:
//   NODE_PATH=app node app/scheduler/check-redis-host.js
const {
  SLOWLOG_ENTRIES,
  SLOWLOG_ALERT_US,
  ERROR_ALERT_COUNT,
  parseInfo,
  observe,
  detect,
  merge,
} = require("./redis-host-events");

const SAMPLE_KEY = "blot:redis-host:tcpmem";
const STATE_KEY = "blot:redis-host:alerts";
const README_URL = "https://github.com/blotcms/blot/blob/master/config/redis/README.md";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// Rate limits. A condition (a state: memory high, save failing, sample stale)
// is emailed when it starts and when it clears, but not twice within this long
// for the same condition: a start or clear that comes sooner waits, and is
// sent if it still holds. If it changed state more than once meanwhile the
// email says it is flapping. The first email about a condition is immediate.
const CONDITION_MIN_INTERVAL = HOUR;

// An event (something that happened: errors, a restart, slow commands, a TCP
// pressure rise) is emailed at most once per this long for each type, the
// first one immediately. Ones that happen meanwhile are merged and sent when
// it ends. Errors that mean Redis refuses writes get a shorter wait, since
// they are what an operator needs to hear about again.
const EVENT_COOLDOWN = {
  default: 6 * HOUR,
  "errors-critical": HOUR,
};
const eventCooldown = (type) => EVENT_COOLDOWN[type] || EVENT_COOLDOWN.default;

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
  "bgsave-failed": "Redis background save failing, writes will be refused",
  "errors-critical": "Redis refused writes (OOM, MISCONF)",
  errors: "Redis errors",
  rejected: "Redis rejected connections",
  restart: "Redis restarted or switched host",
  slowlog: "Slow Redis commands",
};

const percent = (fraction) => Math.round(fraction * 100) + "%";
const gb = (bytes) => (bytes / 1024 / 1024 / 1024).toFixed(2) + "GB";
const minutes = (ms) => Math.round(ms / MINUTE) + " minutes";

// "<used>/<total>" in bytes (the host's disk fields), or null.
function parseDisk(value) {
  const match = /^(\d+)\/(\d+)$/.exec(value || "");
  return match && Number(match[2]) > 0 ? { used: Number(match[1]), total: Number(match[2]) } : null;
}

// "2026-10-07T12:00:00Z mem=123 tcp_mem=1,2,3 sockets=25 pressures=0 ...
// host=ip-10-0-0-1 active=1 ram_total=<bytes> ram_avail=<bytes>
// disk_root=<used>/<total> disk_backups=<used>/<total>" (tcpmem-log.sh). The
// last four (all in bytes) are for the daily email: they are null if the host
// did not report them, and disk_backups is omitted when /backups is not a
// mount. Null if it can't be read.
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
    ramTotal: Number(fields.ram_total) > 0 ? Number(fields.ram_total) : null,
    ramAvailable: /^\d+$/.test(fields.ram_avail || "") ? Number(fields.ram_avail) : null,
    diskRoot: parseDisk(fields.disk_root),
    diskBackups: parseDisk(fields.disk_backups),
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

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const duration = (ms) => (ms >= HOUR ? plural(Math.round(ms / HOUR), "hour") : minutes(ms));
const commas = (n) => Number(n).toLocaleString("en-US");
const ms = (us) => commas(Math.round(us / 1000)) + "ms";
const counts = (byType) =>
  Object.keys(byType)
    .sort((a, b) => byType[b] - byType[a])
    .map((type) => `${type} ${commas(byType[type])}`)
    .join(", ");
// A command in an email: inside a code span, so nothing in it is markup.
const code = (command) => "`" + String(command).replace(/`/g, "'") + "`";

// Reads everything and works out each condition and event. A condition is
// true, false, or undefined when it can't be told right now (no fresh
// sample), which leaves its state alone.
//
// What is emailed is rate limited, so a condition that flaps or an error that
// repeats cannot fill the inbox:
// - A condition's start or clear is held back until CONDITION_MIN_INTERVAL has
//   passed since the last email about that condition. It is still true or
//   false then, or it was a blip and nothing is sent. The email says so if the
//   condition changed state more than once in between.
// - An event is emailed at most once per EVENT_COOLDOWN of its type; ones that
//   happen in between are merged (counts added, slowest commands kept) and
//   sent together when the cooldown ends.
async function check(deps = {}) {
  const {
    now = Date.now(),
    client = require("models/client"),
    lastCheckAt = null,
  } = deps;

  // sendCommand keeps these off the client-side cache: the sample changes
  // every 5 minutes, written by another client. One INFO (the default
  // sections hold memory, persistence, stats, errorstats and keyspace) and one
  // SLOWLOG GET: both are cheap.
  const [sampleValue, stateValue, infoText, slowlogReply] = await Promise.all([
    client.sendCommand(["GET", SAMPLE_KEY]),
    client.sendCommand(["GET", STATE_KEY]),
    client.sendCommand(["INFO"]),
    client.sendCommand(["SLOWLOG", "GET", String(SLOWLOG_ENTRIES)]),
  ]);

  let state;
  try {
    state = JSON.parse(stateValue) || {};
  } catch (e) {
    state = {};
  }
  state = {
    alerts: state.alerts || {},
    pressures: state.pressures || null,
    // { name: { at, flaps } }: when the last email about a condition or event
    // type was sent, and how often a condition changed state since
    mail: state.mail || {},
    // { condition: last value }, to count those changes
    seen: state.seen || {},
    // { event type: data } waiting for its cooldown
    pending: state.pending || {},
    // The counters seen last time (redis-host-events.js)
    observed: state.observed || null,
  };

  const was = (name) => name in state.alerts;
  const fields = parseInfo(infoText);
  const memory = parseMemory(infoText);
  const sample = parseSample(sampleValue);
  const age = sample ? now - sample.time : null;
  const continuous = lastCheckAt !== null && now - lastCheckAt <= CONTINUOUS_MS;
  const conditions = {};
  let pressures = state.pressures;
  let pressureRise = null;

  const redis = {
    version: fields.redis_version || null,
    uptime: Number(fields.uptime_in_seconds) || 0,
    saveStatus: fields.rdb_last_bgsave_status || null,
    lastSave: Number(fields.rdb_last_save_time) * 1000 || null,
  };

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

  // With stop-writes-on-bgsave-error yes (redis.conf), a failed save makes
  // Redis refuse every write until one succeeds.
  if (redis.saveStatus) conditions["bgsave-failed"] = redis.saveStatus !== "ok";

  // Conditions: start and clear, no more often than CONDITION_MIN_INTERVAL
  const mail = { ...state.mail };
  const seen = { ...state.seen };
  const started = [];
  const cleared = [];
  const flaps = {};

  Object.keys(conditions).forEach((name) => {
    const value = conditions[name];
    if (value === undefined) return;

    const last = mail[name] || { at: 0, flaps: 0 };
    const changes = last.flaps + (name in seen && seen[name] !== value ? 1 : 0);
    const wanted = value !== was(name);
    const open = now - last.at >= CONDITION_MIN_INTERVAL;
    seen[name] = value;

    if (wanted && open) {
      (value ? started : cleared).push(name);
      flaps[name] = changes;
      mail[name] = { at: now, flaps: 0 };
    } else if (changes || mail[name]) {
      // Nothing to say, or not allowed to yet. A condition that has settled
      // back to what was last emailed has no flapping to report.
      mail[name] = { at: last.at, flaps: !wanted && open ? 0 : changes };
    }
  });

  const alerts = { ...state.alerts };
  started.forEach((name) => (alerts[name] = now));
  cleared.forEach((name) => delete alerts[name]);

  // Events: what happened since the last check, at most one email per type
  // per cooldown
  const { events, observed } = detect(state.observed, observe(fields, slowlogReply), { sample });
  if (pressureRise) events["tcp-pressure"] = pressureRise;

  const pending = { ...state.pending };
  const due = {};
  const held = {};

  new Set([...Object.keys(pending), ...Object.keys(events)]).forEach((type) => {
    let data = pending[type];
    if (events[type]) data = data ? merge[type](data, events[type]) : events[type];

    const last = mail[type] || { at: 0, flaps: 0 };
    if (now - last.at >= eventCooldown(type)) {
      due[type] = data;
      held[type] = !!pending[type];
      delete pending[type];
      mail[type] = { at: now, flaps: 0 };
    } else {
      pending[type] = data;
    }
  });

  return {
    now,
    sample,
    age,
    memory,
    redis,
    conditions,
    started,
    cleared,
    flaps,
    events,
    due,
    held,
    send: started.length > 0 || cleared.length > 0 || Object.keys(due).length > 0,
    state,
    nextState: { alerts, pressures, mail, seen, pending, observed },
  };
}

function eventMessage(type, data, report) {
  switch (type) {
    case "tcp-pressure":
      return `TCPMemoryPressures rose from ${data.from} to ${data.to} on ${report.sample.host}: the kernel was rationing TCP buffers, so bursts to Redis may have been dropped`;
    case "errors-critical":
      return `new errors that mean Redis refused writes: ${counts(data.counts)}. OOM is the maxmemory limit (\`noeviction\`), MISCONF a failed background save (\`stop-writes-on-bgsave-error yes\`), NOREPLICAS fewer replicas than \`min-replicas-to-write\``;
    case "errors":
      return `at least ${ERROR_ALERT_COUNT} new errors of a type within 5 minutes: ${counts(data.counts)}. READONLY is expected for a moment during a cutover; otherwise look for a bug in the app, whose logs show the failing commands`;
    case "rejected":
      return `Redis rejected ${commas(data.count)} connections: it was at \`maxclients\``;
    case "restart":
      return (
        "Redis restarted or a different host/process is now serving (e.g. after a cutover):\n" +
        data.incidents
          .map(
            (i) =>
              `  - ${i.reasons.join(", ")}; redis ${i.version}, up ${Math.round(i.uptime)}s` +
              (i.host ? `; the last tcpmem sample was from ${i.host}` : "")
          )
          .join("\n")
      );
    case "slowlog": {
      const lines = data.worst.map(
        (entry) => `  - ${ms(entry.us)} at ${new Date(entry.at).toISOString().slice(11, 16)}Z: ${code(entry.command)}`
      );
      const rest = data.count - data.worst.length;
      if (rest > 0) lines.push(`  - and ${rest} more`);
      return (
        `${plural(data.count, "command")} took at least ${ms(SLOWLOG_ALERT_US)} (the host's slowlog):\n` +
        lines.join("\n")
      );
    }
  }
}

function message(name, report) {
  const { sample, memory, age, redis } = report;

  switch (name) {
    case "tcp-mem":
      return `${sample.mem} pages, ${percent(sample.fraction)} of tcp_mem[1] (${sample.tcpMem[1]}) on ${sample.host}`;
    case "sample-stale":
      return `the last sample from ${sample.host} is ${minutes(age)} old`;
    case "maxmemory":
      return `${gb(memory.used)} of ${gb(memory.maxmemory)} (${percent(memory.fraction)})`;
    case "maxmemory-unset":
      return `maxmemory is 0 on ${sample.host}, which cutover marked active`;
    case "bgsave-failed":
      return (
        `the last background save failed (\`rdb_last_bgsave_status:${redis.saveStatus}\`). ` +
        "**Urgent:** `redis.conf` has `stop-writes-on-bgsave-error yes`, so Redis refuses every write " +
        "(\`MISCONF\`) until a save succeeds, and the app cannot save anything. On the Redis host check " +
        "disk space on `/var/lib/redis6` (`df -h`), the reason in `/var/log/redis6/redis6.log`, and memory " +
        "(a save that cannot fork means RAM is short or `vm.overcommit_memory` is not 1); see " +
        `[config/redis/README.md](${README_URL})`
      );
    default:
      return eventMessage(name, report.due[name], report);
  }
}

// What the email template renders
function view(report) {
  const { sample, memory, age, redis } = report;
  const names = report.started.concat(Object.keys(report.due));

  const item = (name) => {
    let text = message(name, report);
    if (report.flaps[name] > 1) text += ` (flapping: it changed state ${report.flaps[name]} times since the last email about it)`;
    if (report.held[name]) text += ` (includes what was held back by the limit of one email per ${duration(eventCooldown(name))})`;
    return { title: TITLES[name], message: text };
  };
  const recovered = report.cleared.map((name) => ({
    title: TITLES[name],
    note:
      report.flaps[name] > 1
        ? `flapping: it changed state ${report.flaps[name]} times since the last email about it`
        : null,
  }));

  const summary = names.length
    ? names.map((name) => TITLES[name]).join(", ")
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
  if (redis.saveStatus) {
    readings.push(
      `Last background save: ${redis.saveStatus}` +
        (redis.lastSave ? `, ${minutes(report.now - redis.lastSave)} ago` : "") +
        `; Redis ${redis.version || "?"}, up ${duration(redis.uptime * 1000)}`
    );
  }

  return {
    summary,
    hasAlerts: names.length > 0,
    alerts: names.map(item),
    hasRecovered: recovered.length > 0,
    recovered,
    readings,
    thresholds: {
      tcpMem: percent(TCP_MEM_ALERT),
      maxmemory: percent(MAXMEMORY_ALERT),
      stale: minutes(STALE_MS),
      errors: ERROR_ALERT_COUNT,
      slowlog: ms(SLOWLOG_ALERT_US),
      conditionInterval: duration(CONDITION_MIN_INTERVAL),
      eventCooldown: duration(EVENT_COOLDOWN.default),
    },
  };
}

// Runs the check, emails what started, cleared or happened (within the rate
// limits), and saves the state. deps.sendEmail(view) must reject on failure;
// then nothing is saved, so the next run tries again with the same counters.
// Resolves to { report, sent }.
async function run(deps = {}) {
  const sendEmail = deps.sendEmail || (async () => {});
  const client = deps.client || require("models/client");
  const report = await check({ ...deps, client });

  if (report.send) await sendEmail(view(report));

  if (JSON.stringify(report.nextState) !== JSON.stringify(report.state)) {
    await client.sendCommand(["SET", STATE_KEY, JSON.stringify(report.nextState)]);
  }

  return { report, sent: report.send };
}

module.exports = run;
module.exports.check = check;
module.exports.view = view;
module.exports.parseSample = parseSample;
module.exports.parseMemory = parseMemory;
module.exports.parseInfo = parseInfo;
module.exports.SAMPLE_KEY = SAMPLE_KEY;
module.exports.STATE_KEY = STATE_KEY;
module.exports.CONDITION_MIN_INTERVAL = CONDITION_MIN_INTERVAL;
module.exports.EVENT_COOLDOWN = EVENT_COOLDOWN;

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

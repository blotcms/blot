// What happened in Redis since the last check of check-redis-host.js
// (blotcms/blot#2041): errors, refused connections, restarts and slow
// commands. All of it comes from one INFO and one SLOWLOG GET per check, both
// cheap on a 1-vCPU Redis (INFO only formats counters; SLOWLOG GET copies at
// most SLOWLOG_ENTRIES entries from a list in memory).
//
// Redis keeps cumulative counters, so each check compares them with the ones
// it saw last time (kept in the check's state). They start again from zero
// when Redis restarts, and a restart (or a failover to another host, which is
// a different process with its own counters) is detected first and starts new
// baselines instead of producing negative or huge deltas.

// How many slowlog entries one check reads. The newest come first, so this is
// the most a single 5-minute window can report; the log itself holds
// slowlog-max-len (1024) entries.
const SLOWLOG_ENTRIES = 128;

// Only commands at least this slow are worth an email. Redis records anything
// over slowlog-log-slower-than (10ms, config/redis/redis.conf), but on
// production only one command in about 7 hours reached even that, so 50ms
// stays quiet on a healthy host while still catching a command that blocks
// the single Redis thread (a KEYS/SMEMBERS on a big key, a fork stall). The
// per-type cooldown bounds the noise if that changes.
const SLOWLOG_ALERT_US = 50 * 1000;

// Errors that mean Redis is refusing writes or running out of room are
// alerted on any occurrence. Other errors (READONLY while a cutover is under
// way, WRONGTYPE, ERR from an app bug) happen in small numbers all the time:
// only a type with at least this many new errors since the last check (5
// minutes) is reported.
const CRITICAL_ERRORS = ["OOM", "MISCONF", "NOREPLICAS"];
const ERROR_ALERT_COUNT = 100;

// Error and rejected-connection thresholds are per 5-minute check. If the last
// look at the counters is older than this (the scheduler was down, a deploy,
// a Redis outage), their delta spans a longer period and would trip the
// thresholds for no reason, so the counters start a new baseline instead.
const MAX_OBSERVATION_GAP_MS = 15 * 60 * 1000;

// Per email: this many of the slowest commands are listed, the rest counted.
const SLOWLOG_LISTED = 10;
// Command text in an email: the command and its first arguments, cut here.
const COMMAND_CHARS = 100;
const RESTARTS_LISTED = 5;

// The INFO lines as { field: value }.
function parseInfo(text) {
  const fields = {};
  String(text)
    .split(/\r?\n/)
    .forEach((line) => {
      const i = line.indexOf(":");
      if (i > 0 && line[0] !== "#") fields[line.slice(0, i)] = line.slice(i + 1).trim();
    });
  return fields;
}

// errorstat_OOM:count=3 -> { OOM: 3 }
function parseErrors(fields) {
  const errors = {};
  Object.keys(fields).forEach((name) => {
    const match = /^errorstat_(.+)$/.exec(name);
    const count = match && /^count=(\d+)/.exec(fields[name]);
    if (count) errors[match[1]] = Number(count[1]);
  });
  return errors;
}

const text = (value) => (Buffer.isBuffer(value) ? value.toString() : String(value));

// SLOWLOG GET reply: [[id, unix seconds, microseconds, [command, args...],
// client address, client name], ...], newest first.
function parseSlowlog(reply) {
  if (!Array.isArray(reply)) return [];
  return reply
    .filter((entry) => Array.isArray(entry) && Array.isArray(entry[3]))
    .map((entry) => ({
      id: Number(entry[0]),
      at: Number(entry[1]) * 1000,
      us: Number(entry[2]),
      args: entry[3].map(text),
    }));
}

// "EVAL return redis.call('get',KEYS[1]) 1", for an email: the command and the
// first two arguments (keys, mostly), never the values after them.
function describeCommand(args) {
  const shown = args.slice(0, 3).join(" ").replace(/\s+/g, " ");
  return shown.length > COMMAND_CHARS ? shown.slice(0, COMMAND_CHARS - 1) + "…" : shown;
}

// The counters to compare with next time.
function observe(info, slowlogReply) {
  const fields = typeof info === "string" ? parseInfo(info) : info;
  const slowlog = parseSlowlog(slowlogReply);

  return {
    runId: fields.run_id || null,
    version: fields.redis_version || null,
    uptime: Number(fields.uptime_in_seconds) || 0,
    rejected: Number(fields.rejected_connections) || 0,
    errors: parseErrors(fields),
    slowlog,
  };
}

// Compares what Redis shows now with `previous` (what this returned last time,
// or null). Returns { events, observed }: events is { type: data } for what
// happened, and observed is the baseline to keep.
//
// Event data is merged when several accumulate before an email is allowed, so
// each type's `merge` below must combine two of them.
function detect(previous, current, { sample = null, now = Date.now() } = {}) {
  const events = {};
  const slowIds = current.slowlog.map((entry) => entry.id);
  const observed = {
    runId: current.runId,
    version: current.version,
    uptime: current.uptime,
    rejected: current.rejected,
    errors: current.errors,
    at: now,
    slowlogId: slowIds.length ? Math.max(...slowIds) : -1,
  };

  // First look: a baseline, nothing to compare with
  if (!previous) return { events, observed };

  const reasons = [];
  if (current.uptime < previous.uptime) reasons.push("uptime went backwards");
  if (current.runId && previous.runId && current.runId !== previous.runId) reasons.push("run_id changed");
  if (current.version && previous.version && current.version !== previous.version) {
    reasons.push(`version changed from ${previous.version} to ${current.version}`);
  }

  // Slowlog ids count up from 0 in each process, and SLOWLOG RESET starts
  // them again: after either, every entry is new.
  let lastSlowId = previous.slowlogId;
  if (reasons.length || observed.slowlogId < lastSlowId) lastSlowId = -1;

  if (reasons.length) {
    events.restart = {
      incidents: [
        {
          reasons,
          uptime: current.uptime,
          version: current.version,
          // The sample is from the host that was writing it a few minutes
          // ago: after a cutover it may still be the old one.
          host: sample ? sample.host : null,
        },
      ],
    };
  } else if (!(now - previous.at <= MAX_OBSERVATION_GAP_MS)) {
    // No usable previous look at the counters (see MAX_OBSERVATION_GAP_MS)
  } else {
    if (current.rejected > previous.rejected) {
      events.rejected = { count: current.rejected - previous.rejected };
    }

    const critical = {};
    const other = {};
    Object.keys(current.errors).forEach((type) => {
      // A counter that went down was reset: no delta to read from it
      const delta = current.errors[type] - (previous.errors[type] || 0);
      if (previous.errors[type] > current.errors[type] || delta <= 0) return;
      if (CRITICAL_ERRORS.includes(type)) critical[type] = delta;
      else if (delta >= ERROR_ALERT_COUNT) other[type] = delta;
    });
    if (Object.keys(critical).length) events["errors-critical"] = { counts: critical };
    if (Object.keys(other).length) events.errors = { counts: other };
  }

  const slow = current.slowlog.filter((entry) => entry.id > lastSlowId && entry.us >= SLOWLOG_ALERT_US);
  if (slow.length) {
    events.slowlog = {
      count: slow.length,
      worst: slow
        .sort((a, b) => b.us - a.us)
        .slice(0, SLOWLOG_LISTED)
        .map((entry) => ({ us: entry.us, at: entry.at, command: describeCommand(entry.args) })),
    };
  }

  return { events, observed };
}

const sumCounts = (a, b) => {
  const counts = { ...a };
  Object.keys(b).forEach((type) => (counts[type] = (counts[type] || 0) + b[type]));
  return counts;
};

// How to combine an event waiting for its cooldown with a newer one.
const merge = {
  "tcp-pressure": (a, b) => ({ from: Math.min(a.from, b.from), to: Math.max(a.to, b.to) }),
  "errors-critical": (a, b) => ({ counts: sumCounts(a.counts, b.counts) }),
  errors: (a, b) => ({ counts: sumCounts(a.counts, b.counts) }),
  rejected: (a, b) => ({ count: a.count + b.count }),
  restart: (a, b) => ({ incidents: a.incidents.concat(b.incidents).slice(-RESTARTS_LISTED) }),
  slowlog: (a, b) => ({
    count: a.count + b.count,
    worst: a.worst.concat(b.worst).sort((x, y) => y.us - x.us).slice(0, SLOWLOG_LISTED),
  }),
};

module.exports = {
  SLOWLOG_ENTRIES,
  SLOWLOG_ALERT_US,
  SLOWLOG_LISTED,
  MAX_OBSERVATION_GAP_MS,
  CRITICAL_ERRORS,
  ERROR_ALERT_COUNT,
  parseInfo,
  parseErrors,
  parseSlowlog,
  describeCommand,
  observe,
  detect,
  merge,
};

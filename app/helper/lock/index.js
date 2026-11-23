const client = require("models/client");
const { randomUUID } = require("crypto");
const scheduler = require("node-schedule");
const clfdate = require("helper/clfdate");

// Redis-based coordination primitives for running any number of identical
// processes. Keys passed in are used verbatim (callers namespace them), except
// cron, which builds its own. All durations are in milliseconds.
//
//   lock    exclusive while held: at most one holder at a time, and a holder
//           whose key expired can never release or extend someone else's lock.
//   once    at most once: the first caller within the TTL wins, nobody else.
//   cron    at most once per scheduled run: every process registers the same
//           job and one of them wins the run. A run killed mid-way (a deploy)
//           is re-run by another process, see fire().
//   lease   one holder at a time of a continuous loop, with takeover by
//           another process between one and two ttls after the holder dies.
//
// The lock is a Redis key whose value is a random token, ending in
// ":<acquired at, ms>" so heldSince() can tell how long it has been held
// without a second key: the scripts below only ever compare the whole value
// for equality, so the suffix changes nothing for them. While held, a
// heartbeat re-extends the TTL; if the process dies the key simply expires.
//
// Acquiring is a plain SET NX PX. Redis 6.2 has no native compare-and-set
// (SET ... IFEQ and DELEX arrive in 8.4), so the two compare-then-act steps,
// extend and release, are the only Lua here: a few lines, one decision each.

const EXTEND = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0`;

const RELEASE = `
if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end
return 0`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Logged when a heartbeat tick is this late (the timer fired late, or the
// Redis round trip was slow).
const HEARTBEAT_LOG_THRESHOLD_MS = 500;

// Resolves to { release, token } or rejects once retries are exhausted: with
// code ELOCKED if someone else holds the lock, or ESLOW if the last attempt
// got its reply too late to trust (nobody necessarily holds the lock then).
// onCompromised(err) fires at most once if the heartbeat finds the lock is no
// longer ours (expired, or Redis unreachable for long enough that it may
// have). It must not be relied on to stop the key living on: callers must
// still call release() after onCompromised. An EXTEND that was stalled on the
// connection can reach Redis after we gave up and still extend the key, so
// it stays held for up to another ttl unless released. RELEASE compares the
// token, so calling it is always safe, even if someone else holds the lock.
async function lock(key, options = {}) {
  const {
    ttl = 10 * 1000,
    heartbeat = 3 * 1000,
    retries = 0,
    minTimeout = 750,
    onCompromised = () => {},
  } = options;

  // Redis starts the PX countdown when it runs the SET, which is no earlier
  // than startedAt. The first heartbeat EXTEND goes out `heartbeat` ms after
  // we return, so an acquisition is only believable if enough lifetime is
  // left to survive until then, plus two margins: one because the watchdog
  // gives up a margin before the key can expire, and one for the EXTEND
  // round trip, so the first EXTEND is not sent right at that deadline. A
  // reply that took longer than that may already be too late, or after a full
  // ttl, found the key expired and taken by someone else. Heartbeat should be
  // well under ttl; if it is not, the requirement is capped at three quarters
  // of the ttl so that acquiring stays possible.
  const margin = Math.min(1000, ttl / 10);
  const staleAfter = Math.max(ttl - heartbeat - 2 * margin, ttl / 4);

  // Per attempt, so the ":<ms>" suffix heldSince() reads is when the winning
  // SET was sent, not when we first tried.
  let token;
  let acquired = false;
  let lastWasStale = false;
  let startedAt;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(minTimeout * Math.pow(2, attempt - 1));
    lastWasStale = false;
    startedAt = Date.now();
    token = randomUUID() + ":" + startedAt;
    const ok = await client.set(key, token, { NX: true, PX: ttl });
    if (ok === null) continue;
    if (Date.now() - startedAt >= staleAfter) {
      lastWasStale = true;
      const staleToken = token;
      console.error(clfdate(), "[LOCK] stale acquire reply", key);
      // Compare-and-delete: harmless if it already expired or isn't ours.
      client
        .eval(RELEASE, { keys: [key], arguments: [staleToken] })
        .catch((e) =>
          console.error(
            clfdate(),
            "[LOCK] stale release failed",
            key,
            e.message
          )
        );
      continue;
    }
    acquired = true;
    break;
  }

  if (!acquired) {
    // A stale reply says nothing about who holds the key, so don't claim
    // someone does.
    if (lastWasStale) {
      const err = new Error("Lock acquire reply too slow: " + key);
      err.code = "ESLOW";
      throw err;
    }
    const err = new Error("Lock is held: " + key);
    err.code = "ELOCKED";
    throw err;
  }

  const heldToken = token;
  let released = false;
  let releasedOk = false;
  let releasing = null;
  let compromised = false;
  let releaseFailed = false;
  let inFlight = false;
  // The key's lifetime counts from when Redis ran the script, which is no
  // later than the moment we sent it.
  let lastExtended = startedAt;
  let lastTickAt = Date.now();

  // The one place onCompromised is called. It runs from timers and from
  // release(), where a throw would become an uncaught exception or an
  // unhandled rejection, so whatever the callback does stays contained.
  function notify(err) {
    err.code = "ECOMPROMISED";
    const report = (e) =>
      console.error(
        clfdate(),
        "[LOCK] onCompromised threw",
        key,
        e && e.stack ? e.stack : e
      );
    try {
      // An async callback's rejection must not go unhandled either
      Promise.resolve(onCompromised(err)).catch(report);
    } catch (e) {
      report(e);
    }
  }

  function compromise(err) {
    if (released || compromised) return;
    compromised = true;
    clearInterval(timer);
    clearTimeout(deadline);
    notify(err);
  }

  // Watchdog, independent of any Redis reply and of when the heartbeat ticks
  // land: unless an extension is confirmed first, give up `margin` before the
  // key can expire, however many commands are still pending on a stalled
  // connection. Re-armed after every confirmed extension. A timer that fires
  // late because the event loop is blocked cannot be covered from here.
  let deadline;
  function armDeadline() {
    clearTimeout(deadline);
    deadline = setTimeout(
      () => compromise(new Error("Lock heartbeat stalled: " + key)),
      Math.max(0, lastExtended + ttl - margin - Date.now())
    );
    deadline.unref();
  }

  const timer = setInterval(async () => {
    if (released || compromised) return;
    // Never stack EXTENDs behind a stalled one.
    if (inFlight) return;
    inFlight = true;

    // Redis starts the new TTL when it runs the script, so measure from
    // before the round trip; a delayed reply must not lengthen our lease.
    const attemptedAt = Date.now();
    const tickDelayMs = attemptedAt - lastTickAt - heartbeat;
    lastTickAt = attemptedAt;

    try {
      const ok = await client.eval(EXTEND, {
        keys: [key],
        arguments: [heldToken, String(ttl)],
      });
      // A reply after compromise or release is too late to mean anything.
      if (released || compromised) return;
      const roundTripMs = Date.now() - attemptedAt;
      if (
        tickDelayMs >= HEARTBEAT_LOG_THRESHOLD_MS ||
        roundTripMs >= HEARTBEAT_LOG_THRESHOLD_MS
      ) {
        console.log(
          clfdate(),
          "[LOCK] slow heartbeat",
          key,
          `tickDelay=${tickDelayMs}ms`,
          `roundTrip=${roundTripMs}ms`
        );
      }
      if (ok) {
        lastExtended = attemptedAt;
        armDeadline();
      } else {
        compromise(new Error("Lock was lost: " + key));
      }
    } catch (e) {
      // Redis hiccup: nothing to do, the deadline gives up before the key
      // can expire; until then nobody else can have taken the lock.
      console.error(clfdate(), "[LOCK] heartbeat error", key, e.message);
    } finally {
      inFlight = false;
    }
  }, heartbeat);
  timer.unref();
  armDeadline();

  async function doRelease() {
    const deleted = await client.eval(RELEASE, {
      keys: [key],
      arguments: [heldToken],
    });
    if (!deleted && !compromised) {
      // A retry after a failed release may find the key gone because the
      // first RELEASE deleted it and the reply was lost, or because it
      // expired. RELEASE compares the token, so nobody else's lock was
      // touched either way.
      if (releaseFailed) return;
      compromised = true;
      releasedOk = true; // the lock is gone for good; nothing to retry
      const err = new Error("Lock was lost before release: " + key);
      notify(err);
      throw err;
    }
  }

  return {
    token: heldToken,
    // The heartbeat stops on the first call and stays stopped. If the command
    // fails (Redis unavailable) the caller can call release() again; calls
    // while one is in flight share it, and after success it is a no-op.
    async release() {
      if (releasedOk) return;
      released = true;
      clearInterval(timer);
      clearTimeout(deadline);
      if (!releasing) {
        releasing = doRelease().then(
          () => {
            releasedOk = true;
          },
          (e) => {
            releasing = null;
            releaseFailed = true;
            throw e;
          }
        );
      }
      return releasing;
    },
  };
}

// Reports who holds a lock and for how long it will live, for diagnostics.
async function inspect(key) {
  const [holder, ttlMs] = await Promise.all([
    client.get(key),
    client.pTTL(key),
  ]);
  return { lockKey: key, held: holder !== null, holder, ttlMs };
}

// When the current holder acquired the lock (ms since epoch), or null if it
// isn't held or the value has no timestamp suffix.
async function heldSince(key) {
  const holder = await client.get(key);
  const match = typeof holder === "string" && /^[^:]+:(\d{10,})$/.exec(holder);
  return match ? Number(match[1]) : null;
}

// Resolves true if this caller set the key, false if it was already set.
// There is nothing to release: the key expires after ttl. Rejects on Redis
// errors so the caller decides what a failure means.
async function once(key, ttl) {
  const result = await client.set(key, "1", { NX: true, PX: ttl });
  return result !== null;
}

const SCOPES = ["cluster", "host"];

function cronKey(name, fireDate, scope) {
  let key = "cron:" + name + ":" + fireDate.toISOString();
  if (scope === "host") key += ":" + process.env.BLOT_HOST_ID;
  return key;
}

function checkScope(scope) {
  if (!SCOPES.includes(scope))
    throw new Error("lock.cron: scope must be one of " + SCOPES.join(", "));
  // Inside Docker os.hostname() is the container ID, which would differ per
  // container on the same host, so there is deliberately no fallback to it.
  if (scope === "host" && !process.env.BLOT_HOST_ID)
    throw new Error('lock.cron: scope "host" requires BLOT_HOST_ID to be set');
}

// What runs when a cron job fires. Every process derives the same key from
// the fire date node-schedule passes in (not Date.now(), so a process that
// fires late still agrees), and only one of them runs fn. Never throws: errors
// from Redis or fn are logged. Resolves true if fn ran to completion here.
//
// Two keys per fire. The done marker (cronKey, 24 hours by default) says the
// fire is finished and is only set once fn has returned or thrown. While fn
// runs, the winner holds a short claim lock (cronKey + ":claim") with a
// heartbeat, so if the process is killed mid-run (a deploy) the claim expires
// within its ttl and the fire has no done marker. node-schedule never fires
// the same date twice in a process, so a survivor would not notice by itself:
// every claim is therefore also listed in the IN_PROGRESS sorted set before it
// is taken, and recover() (run every minute by every process) re-runs any
// listed fire whose claim is gone and whose done marker is unset, for up to
// MAX_RERUN_AGE_MS after the fire date. A fn that throws counts as done (it is
// logged, not retried), so a failing job never loops; only a kill re-runs.
// Jobs that are not safe to run twice, or that are pointless late (every few
// minutes), pass { rerunIfKilled: false }: they use a plain once() marker set
// before fn runs, so a kill skips that fire.
//
// A draining process (SIGTERM received, see helper/drain) never starts a
// fire: the deploy would kill it mid-run and another process is up.
//
// Callers must keep in mind that every process has to run in the same
// timezone, because node-schedule reads cron strings and object rules in
// local time unless a `tz` is given, and processes in different zones would
// compute different fire dates, so different keys, and both would run. And
// consecutive runs are not mutually exclusive: a run still going when the
// next fire date arrives can overlap with it on another process, so wrap fn
// in lock() if a job must not overlap itself.
const IN_PROGRESS = "cron:in-progress";
const MAX_RERUN_AGE_MS = 6 * 60 * 60 * 1000;
const CLAIM_TTL_MS = 30 * 1000;
const CLAIM_HEARTBEAT_MS = 10 * 1000;
const RECOVER_RULE = "* * * * *";

// Jobs registered in this process, so recover() can find fn for a fire
// another process started and died in.
const registry = new Map();

function isDraining() {
  // Lazy: helper/drain requires sync/lock, which must not load with this file
  return require("helper/drain").isDraining();
}

function inProgressMember(name, fireDate, scope) {
  return JSON.stringify({
    name,
    fireDate: fireDate.toISOString(),
    scope,
    host: scope === "host" ? process.env.BLOT_HOST_ID : undefined,
  });
}

async function fire(name, fireDate, fn, options = {}) {
  // The marker must outlive any late firing: a process whose event loop or
  // container was suspended still gets the original fireDate from
  // node-schedule when it wakes, and must find the marker. The keys are tiny.
  const {
    scope = "cluster",
    ttl = 24 * 60 * 60 * 1000,
    rerunIfKilled = true,
  } = options;
  try {
    checkScope(scope);
    if (isDraining()) return false;
    registry.set(name, { fn, options });
    const doneKey = cronKey(name, fireDate, scope);

    if (!rerunIfKilled) {
      if (!(await once(doneKey, ttl))) return false;
      await runJob(name, fireDate, fn);
      return true;
    }

    return await claimAndRun(name, fireDate, fn, scope, ttl);
  } catch (e) {
    console.error(
      clfdate(),
      "[CRON]",
      name,
      "failed:",
      e && e.stack ? e.stack : e
    );
    return false;
  }
}

// Runs fn, logging a throw. Resolves normally either way.
async function runJob(name, fireDate, fn) {
  try {
    await fn(fireDate);
  } catch (e) {
    console.error(
      clfdate(),
      "[CRON]",
      name,
      "failed:",
      e && e.stack ? e.stack : e
    );
  }
}

async function claimAndRun(name, fireDate, fn, scope, ttl) {
  const doneKey = cronKey(name, fireDate, scope);
  const member = inProgressMember(name, fireDate, scope);
  if (await client.exists(doneKey)) return false;

  // Listed before the claim, so a kill between the two still leaves a record
  await client.zAdd(IN_PROGRESS, { score: fireDate.getTime(), value: member });

  let claim;
  try {
    claim = await lock(doneKey + ":claim", {
      ttl: CLAIM_TTL_MS,
      heartbeat: CLAIM_HEARTBEAT_MS,
      onCompromised: (err) =>
        console.error(clfdate(), "[CRON]", name, "claim lost:", err.message),
    });
  } catch (e) {
    if (e.code === "ELOCKED" || e.code === "ESLOW") return false;
    throw e;
  }

  try {
    // The previous holder may have finished between our check and our claim
    if (await client.exists(doneKey)) {
      await client.zRem(IN_PROGRESS, member);
      return false;
    }
    await runJob(name, fireDate, fn);
    // Done, whether fn returned or threw
    await client.set(doneKey, "1", { PX: ttl });
    await client.zRem(IN_PROGRESS, member);
    return true;
  } finally {
    await claim.release().catch((e) => {
      if (e.code !== "ECOMPROMISED")
        console.error(clfdate(), "[CRON]", name, "claim release failed", e);
    });
  }
}

// Re-runs fires whose winner died: listed in IN_PROGRESS, no done marker, no
// live claim, newer than MAX_RERUN_AGE_MS. Skips jobs this process did not
// register and, for scope "host", fires of another host. Never throws.
async function recover() {
  try {
    if (isDraining()) return;
    const cutoff = Date.now() - MAX_RERUN_AGE_MS;
    await client.zRemRangeByScore(IN_PROGRESS, "-inf", cutoff);
    const members = await client.zRange(IN_PROGRESS, 0, -1);
    for (const member of members) {
      if (isDraining()) return;
      let entry;
      try {
        entry = JSON.parse(member);
      } catch (e) {
        await client.zRem(IN_PROGRESS, member);
        continue;
      }
      const job = registry.get(entry.name);
      if (!job) continue;
      const scope = entry.scope || "cluster";
      if (scope === "host" && entry.host !== process.env.BLOT_HOST_ID) continue;
      const fireDate = new Date(entry.fireDate);
      const { ttl = 24 * 60 * 60 * 1000 } = job.options;
      if (await client.exists(cronKey(entry.name, fireDate, scope))) {
        await client.zRem(IN_PROGRESS, member);
        continue;
      }
      if (await claimAndRun(entry.name, fireDate, job.fn, scope, ttl))
        console.log(clfdate(), "[CRON]", entry.name, "re-ran a killed fire");
    }
  } catch (e) {
    console.error(
      clfdate(),
      "[CRON] recover failed:",
      e && e.stack ? e.stack : e
    );
  }
}

let recoverJob = null;

// Returns the node-schedule Job so callers can cancel it. Throws at
// registration time for a bad scope or a missing BLOT_HOST_ID.
function cron(name, rule, fn, options = {}) {
  checkScope(options.scope || "cluster");
  registry.set(name, { fn, options });
  if (!recoverJob) recoverJob = scheduler.scheduleJob(RECOVER_RULE, recover);
  return scheduler.scheduleJob(rule, (fireDate) =>
    fire(name, fireDate, fn, options)
  );
}

cron._fire = fire;
cron._recover = recover;

// Keeps trying to be the single holder of a continuous loop. fn(signal) runs
// while we hold the lock; signal aborts if the lock is compromised or stop()
// is called, and fn should then wind down. When fn settles we release, wait
// retryEvery and try again, as we do when someone else holds it. stop()
// resolves once fully stopped (including fn returning, if it was running).
function lease(key, fn, options = {}) {
  const {
    ttl = 10 * 1000,
    heartbeat = 3 * 1000,
    // A standby tries every ttl. The holder's key lives up to one ttl past
    // its last extension, so a standby takes over between one and two ttls
    // after the holder dies.
    retryEvery = ttl,
  } = options;

  let stopped = false;
  let current = null; // AbortController of the run in progress
  let wake = null; // cuts the current wait short

  const wait = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      timer.unref();
      function done() {
        clearTimeout(timer);
        wake = null;
        resolve();
      }
      wake = done;
    });

  async function loop() {
    while (!stopped) {
      const controller = new AbortController();
      let held = null;
      try {
        held = await lock(key, {
          ttl,
          heartbeat,
          onCompromised: (err) => {
            console.error(clfdate(), "[LEASE] lost", key, err.message);
            controller.abort();
          },
        });
      } catch (e) {
        if (e.code !== "ELOCKED")
          console.error(clfdate(), "[LEASE] could not lock", key, e.message);
      }

      if (held) {
        current = controller;
        // stop() may have been called while we were acquiring
        if (!stopped) {
          try {
            await fn(controller.signal);
          } catch (e) {
            console.error(
              clfdate(),
              "[LEASE]",
              key,
              "failed:",
              e && e.stack ? e.stack : e
            );
          }
        }
        current = null;
        // Anything watching the signal sees it end with the run.
        controller.abort();
        try {
          await held.release();
        } catch (e) {
          if (e.code !== "ECOMPROMISED")
            console.error(clfdate(), "[LEASE] release failed", key, e.message);
        }
      }

      if (!stopped) await wait(retryEvery);
    }
  }

  const running = loop();

  return {
    stop() {
      stopped = true;
      if (current) current.abort();
      if (wake) wake();
      return running;
    },
  };
}

lock.inspect = inspect;
lock.heldSince = heldSince;
lock.once = once;
lock.cron = cron;
lock.lease = lease;

module.exports = lock;

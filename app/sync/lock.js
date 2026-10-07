const client = require("models/client");
const { randomUUID } = require("crypto");
const clfdate = require("helper/clfdate");

// A per-blog mutex held in Redis so that it works across processes and hosts
// without a shared disk. The value is a random token so that a holder whose
// key expired can never release or extend a lock now owned by someone else.
// The token ends in ":<acquired at, ms>" so heldSince() can tell how long a
// lock has been held without a second key: the scripts below only ever
// compare the whole value for equality, so the suffix changes nothing for
// them, and it lives and dies with the lock.
// While held, a heartbeat re-extends the TTL; if the process dies the key
// simply expires.

const ACQUIRE = `
if redis.call("SET", KEYS[1], ARGV[1], "NX", "PX", ARGV[2]) then return 1 end
return 0`;

const EXTEND = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0`;

const RELEASE = `
if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end
return 0`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Logged when a heartbeat tick is this late (either the timer itself fired
// late - an event-loop-side delay - or the Redis round trip took this long -
// a Redis/network-side delay). Investigating green container crashes: the
// event-loop lag monitor (helper/eventLoopMonitor) and Redis's own SLOWLOG
// showed nothing near the lock TTL at crash time, so this instruments the
// one remaining unmeasured hop to tell the two apart next time.
const HEARTBEAT_LOG_THRESHOLD_MS = 500;

// The heartbeat timing above showed the stall is neither the event loop
// (tickDelay=0) nor Redis itself (SLOWLOG empty, other containers fine): the
// EXTEND sat somewhere on the shared client's connection. So while a
// heartbeat is still outstanding past the threshold, ask Redis - over a
// separate connection that can't be queued behind the shared one - what it
// sees on the shared connection right now. A fast probe PING with the shared
// connection idle and empty server-side means the commands never left this
// process (client-side queue); a large omem/oll means replies are backed up
// on the way back; a slow probe PING too means the network path to Redis.
const PROBE_TIMEOUT_MS = 5000;
const PROBE_MIN_INTERVAL_MS = 1000;

let probeClient;
let sharedClientID;
let probeInFlight = null;
let lastProbeAt = 0;

function setupProbe() {
  if (probeClient) return;
  probeClient = require("models/redis").createLibraryClient("lock-probe");
  const fetchID = () =>
    client
      .clientId()
      .then((id) => (sharedClientID = id))
      .catch(() => {});
  // The ID changes whenever the shared client reconnects.
  client.on("ready", fetchID);
  if (client.isReady) fetchID();
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("timed out")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function runProbe() {
  const result = { sharedClientID };
  const pingStartedAt = Date.now();
  try {
    await withTimeout(probeClient.ping(), PROBE_TIMEOUT_MS);
    result.probePing = `${Date.now() - pingStartedAt}ms`;
  } catch (e) {
    result.probePing = `error after ${Date.now() - pingStartedAt}ms: ${e.message}`;
    return result;
  }
  if (!sharedClientID) return result;
  try {
    const line = await withTimeout(
      probeClient.sendCommand(["CLIENT", "LIST", "ID", String(sharedClientID)]),
      PROBE_TIMEOUT_MS
    );
    const fields = {};
    String(line)
      .trim()
      .split(" ")
      .forEach((pair) => {
        const i = pair.indexOf("=");
        if (i > 0) fields[pair.slice(0, i)] = pair.slice(i + 1);
      });
    ["age", "idle", "flags", "qbuf", "qbuf-free", "omem", "oll", "obl", "tot-mem", "cmd"].forEach(
      (k) => {
        if (k in fields) result[k] = fields[k];
      }
    );
    if (!Object.keys(fields).length) result.clientList = "not found";
  } catch (e) {
    result.clientList = `error: ${e.message}`;
  }
  return result;
}

// Many locks stall together, so share one probe between them rather than
// firing one per held lock.
function probe(lockKey, pendingForMs) {
  if (probeInFlight || Date.now() - lastProbeAt < PROBE_MIN_INTERVAL_MS) return;
  lastProbeAt = Date.now();
  probeInFlight = runProbe()
    .then((result) => {
      console.log(
        clfdate(),
        "[LOCK] stall probe",
        lockKey,
        `pendingFor=${pendingForMs}ms`,
        Object.keys(result)
          .map((k) => `${k}=${result[k]}`)
          .join(" ")
      );
    })
    .catch(() => {})
    .finally(() => {
      probeInFlight = null;
    });
}

function key(blogID) {
  return "blog:" + blogID + ":folder-lock";
}

// Resolves to { release, token } or rejects with code ELOCKED once retries
// are exhausted. onCompromised(err) fires at most once if the heartbeat finds
// the lock is no longer ours (expired, or Redis unreachable for a full TTL).
async function lock(blogID, options = {}) {
  const {
    ttl = 10 * 1000,
    heartbeat = 3 * 1000,
    retries = 0,
    minTimeout = 750,
    onCompromised = () => {},
  } = options;

  const lockKey = key(blogID);
  const token = randomUUID() + ":" + Date.now();

  setupProbe();

  let acquired = false;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(minTimeout * Math.pow(2, attempt - 1));
    acquired = await client.eval(ACQUIRE, {
      keys: [lockKey],
      arguments: [token, String(ttl)],
    });
    if (acquired) break;
  }

  if (!acquired) {
    const err = new Error("Lock is held: " + lockKey);
    err.code = "ELOCKED";
    throw err;
  }

  let released = false;
  let compromised = false;
  let lastExtended = Date.now();
  let lastTickAt = lastExtended;

  const timer = setInterval(async () => {
    if (released || compromised) return;
    let err;
    // Redis starts the new TTL when it runs the script, so measure from
    // before the round trip; a delayed reply must not lengthen our lease.
    const attemptedAt = Date.now();
    // How much later than scheduled this tick actually fired: a JS-side
    // (event-loop) delay, distinct from the Redis round trip measured below.
    const tickDelayMs = attemptedAt - lastTickAt - heartbeat;
    lastTickAt = attemptedAt;

    const stallTimer = setTimeout(
      () => probe(lockKey, Date.now() - attemptedAt),
      HEARTBEAT_LOG_THRESHOLD_MS
    );
    stallTimer.unref();

    try {
      const ok = await client
        .eval(EXTEND, {
          keys: [lockKey],
          arguments: [token, String(ttl)],
        })
        .finally(() => clearTimeout(stallTimer));
      const roundTripMs = Date.now() - attemptedAt;
      if (
        tickDelayMs >= HEARTBEAT_LOG_THRESHOLD_MS ||
        roundTripMs >= HEARTBEAT_LOG_THRESHOLD_MS
      ) {
        console.log(
          clfdate(),
          "[LOCK] slow heartbeat",
          lockKey,
          `tickDelay=${tickDelayMs}ms`,
          `roundTrip=${roundTripMs}ms`
        );
      }
      if (ok) {
        lastExtended = attemptedAt;
        return;
      }
      err = new Error("Lock was lost: " + lockKey);
    } catch (e) {
      const roundTripMs = Date.now() - attemptedAt;
      console.error(
        clfdate(),
        "[LOCK] heartbeat error",
        lockKey,
        `tickDelay=${tickDelayMs}ms`,
        `roundTrip=${roundTripMs}ms`,
        e.message
      );
      // Redis hiccup: only give up once the TTL has really elapsed, since
      // until then nobody else can have taken the lock.
      if (Date.now() - lastExtended < ttl) return;
      err = e;
    }
    if (released || compromised) return;
    compromised = true;
    clearInterval(timer);
    err.code = "ECOMPROMISED";
    onCompromised(err);
  }, heartbeat);
  timer.unref();

  return {
    token,
    async release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      const deleted = await client.eval(RELEASE, {
        keys: [lockKey],
        arguments: [token],
      });
      if (!deleted && !compromised) {
        compromised = true;
        const err = new Error("Lock was lost before release: " + lockKey);
        err.code = "ECOMPROMISED";
        onCompromised(err);
        throw err;
      }
    },
  };
}

// Reports who holds a lock and for how long it will live, for diagnostics.
async function inspect(blogID) {
  const lockKey = key(blogID);
  const [holder, ttlMs] = await Promise.all([
    client.get(lockKey),
    client.pTTL(lockKey),
  ]);
  return { lockKey, held: holder !== null, holder, ttlMs };
}

// When the current holder acquired the lock (ms since epoch), or null if it
// isn't held or the value predates the timestamp suffix. The heartbeat keeps
// extending the TTL for as long as the holder's process is alive, so a lock
// that has been held for a long time means a sync hung inside a live process
// (a crashed process's lock expires within seconds).
async function heldSince(blogID) {
  const holder = await client.get(key(blogID));
  const match = typeof holder === "string" && /^[^:]+:(\d{10,})$/.exec(holder);
  return match ? Number(match[1]) : null;
}

module.exports = { lock, inspect, heldSince, key };

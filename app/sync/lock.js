const client = require("models/client");
const { randomUUID } = require("crypto");

// A per-blog mutex held in Redis so that it works across processes and hosts
// without a shared disk. The value is a random token so that a holder whose
// key expired can never release or extend a lock now owned by someone else.
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
  const token = randomUUID();

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

  const timer = setInterval(async () => {
    if (released || compromised) return;
    let err;
    // Redis starts the new TTL when it runs the script, so measure from
    // before the round trip; a delayed reply must not lengthen our lease.
    const attemptedAt = Date.now();
    try {
      const ok = await client.eval(EXTEND, {
        keys: [lockKey],
        arguments: [token, String(ttl)],
      });
      if (ok) {
        lastExtended = attemptedAt;
        return;
      }
      err = new Error("Lock was lost: " + lockKey);
    } catch (e) {
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

module.exports = { lock, inspect, key };

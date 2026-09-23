const crypto = require("crypto");
const client = require("models/client");
const email = require("helper/email");
const clfdate = require("helper/clfdate");

// Separate from the user record so a failed Mailgun send can be retried
// after PayPal status is already CANCELLED. The value is an idempotency
// claim: only the writer that creates it sends, and a crashed claim can be
// taken over once it is stale.
const CLAIM_TTL_MS = 10 * 60 * 1000;
const KINDS = ["CLOSED", "ALREADY_CANCELLED"];

const CLAIM = `
local current = redis.call("GET", KEYS[1])
local now = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local transition = ARGV[3] == "1"
local token = ARGV[4]

local function take(origin)
  redis.call("SET", KEYS[1], token)
  return origin .. "|" .. token
end

if not current then
  if not transition then return 0 end
  return take("new")
end
if current == "sent" then return 0 end
if current == "owed" then return take("owed") end
if string.sub(current, 1, 8) == "sending:" then
  local ts = tonumber(string.match(current, "^sending:(%d+):"))
  if ts and now - ts < ttl then return 0 end
  return take("stale")
end
return 0
`;

const REPLACE = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  redis.call("SET", KEYS[1], ARGV[2])
  return 1
end
return 0
`;

const REMOVE = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

function noticeKey(uid, kind) {
  return "user:" + uid + ":paypal-cancellation-email:" + kind;
}

function log(message, err) {
  console.log(clfdate(), "PayPal cancellation email:", message, err || "");
}

// Returns { kind, token, origin } or null when this caller must not send.
async function acquire(uid, kind, isTransition) {
  const token = "sending:" + Date.now() + ":" + crypto.randomUUID();
  const raw = await client.eval(CLAIM, {
    keys: [noticeKey(uid, kind)],
    arguments: [String(Date.now()), String(CLAIM_TTL_MS), isTransition ? "1" : "0", token]
  });

  if (!raw || raw === 0) return null;

  const value = String(raw);
  const splitAt = value.indexOf("|");
  if (splitAt === -1) return null;

  return {
    uid: uid,
    kind: kind,
    origin: value.slice(0, splitAt),
    token: value.slice(splitAt + 1)
  };
}

async function replace(claim, value) {
  return client.eval(REPLACE, {
    keys: [noticeKey(claim.uid, claim.kind)],
    arguments: [claim.token, value]
  });
}

function sendEmail(kind, uid) {
  return new Promise(function (resolve, reject) {
    email[kind](uid, {}, function (err) {
      if (err) return reject(err);
      resolve();
    });
  });
}

// Drop a claim whose user write did not land. A retry still sees the
// pre-cancellation record and can claim again. An owed notice stays owed.
async function restore(claim) {
  try {
    if (claim.origin === "new") {
      await client.eval(REMOVE, {
        keys: [noticeKey(claim.uid, claim.kind)],
        arguments: [claim.token]
      });
      return;
    }
    await replace(claim, "owed");
  } catch (err) {
    log("could not restore claim for " + claim.uid, err);
  }
}

async function finish(claim) {
  try {
    await sendEmail(claim.kind, claim.uid);
  } catch (err) {
    try {
      await replace(claim, "owed");
    } catch (restoreErr) {
      log("could not record a failed send for " + claim.uid, restoreErr);
    }
    throw err;
  }

  try {
    await replace(claim, "sent");
  } catch (err) {
    // The message went out. Leave the sending token in place; a later
    // attempt will not take a fresh claim until it is stale.
    log("sent but could not record delivery for " + claim.uid, err);
  }
}

// plan.closed / plan.alreadyCancelled are the transitions observed before
// the write. persist runs only after those claims exist, so a crash cannot
// save CANCELLED and forget that a notice is still owed.
async function settlePayPalCancellation(uid, plan, persist) {
  const held = [];

  try {
    for (const kind of KINDS) {
      const isTransition = kind === "CLOSED" ? plan.closed : plan.alreadyCancelled;
      const claim = await acquire(uid, kind, isTransition);
      if (claim) held.push(claim);
    }
  } catch (err) {
    await Promise.all(held.map(restore));
    throw err;
  }

  try {
    await persist();
  } catch (err) {
    await Promise.all(held.map(restore));
    throw err;
  }

  for (const claim of held) await finish(claim);
}

function closePayPalSubscription(user, callback) {
  const closing = !user.isDisabled;
  const User = require("models/user");
  let disabledNow = false;

  (async function () {
    const claim = await acquire(user.uid, "CLOSED", closing);

    if (closing) {
      try {
        await new Promise(function (resolve, reject) {
          User.disable(user, function (err) {
            if (err) return reject(err);
            resolve();
          });
        });
        disabledNow = true;
      } catch (err) {
        if (claim) await restore(claim);
        throw err;
      }
    }

    if (claim) await finish(claim);
    return disabledNow;
  })().then(
    function (didDisable) {
      callback(null, didDisable);
    },
    function (err) {
      callback(err, disabledNow);
    }
  );
}

module.exports = {
  closePayPalSubscription: closePayPalSubscription,
  settlePayPalCancellation: settlePayPalCancellation
};

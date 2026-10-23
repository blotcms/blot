const client = require("models/client");

// Caps how many notification emails are sent for a given key, so a burst of
// events (e.g. repeated macserver resync requests) can't flood the admin inbox.
//
//   const notify = notificationCap({ name: "x", max: 2, resetAfterMs: HOUR });
//   await notify("key", () => email.X(), () => email.X_PANIC());
//
// The first `max` calls per key run `send`. The next call runs `escalate`
// (once, optional). Every call after that does nothing. Resolves to "sent",
// "escalated" or "suppressed". A key's count starts again `resetAfterMs` after
// its first notification.
//
// The count lives in Redis so it is shared by every process: each call INCRs
// a key (namespaced by `name`) that expires with the window, so exactly one
// caller gets each count. Rejects if Redis does; callers decide what to do.
module.exports = function notificationCap({ name, max, resetAfterMs }) {
  return async function notify(key, send, escalate) {
    const redisKey = "notify-cap:" + name + ":" + key;

    // SET NX opens the window (and its expiry) if there is none, INCR counts
    const [, count] = await client
      .multi()
      .set(redisKey, "0", { NX: true, PX: resetAfterMs })
      .incr(redisKey)
      .exec();

    if (count <= max) {
      send();
      return "sent";
    }

    if (count === max + 1 && escalate) {
      escalate();
      return "escalated";
    }

    return "suppressed";
  };
};

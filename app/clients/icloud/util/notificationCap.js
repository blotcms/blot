// Caps how many notification emails are sent for a given key, so a burst of
// events (e.g. repeated macserver resync requests) can't flood the admin inbox.
//
//   const notify = notificationCap({ max: 2 });
//   notify("key", () => email.X(), () => email.X_PANIC());
//
// The first `max` calls per key run `send`. The next call runs `escalate`
// (once, optional). Every call after that does nothing. Returns "sent",
// "escalated" or "suppressed". With `resetAfterMs`, a key's count starts
// again that long after its first notification; without it, the count lasts
// until the process restarts. State is in-memory and per-process.
module.exports = function notificationCap({
  max,
  resetAfterMs,
  now = Date.now,
}) {
  const entries = new Map();

  return function notify(key, send, escalate) {
    const time = now();

    // Drop expired entries so the map can't grow without bound
    for (const [k, entry] of entries) {
      if (entry.expiresAt <= time) entries.delete(k);
    }

    let entry = entries.get(key);

    if (!entry) {
      entry = {
        sent: 0,
        escalated: false,
        expiresAt: resetAfterMs ? time + resetAfterMs : Infinity,
      };
      entries.set(key, entry);
    }

    if (entry.sent < max) {
      entry.sent++;
      send();
      return "sent";
    }

    if (!entry.escalated && escalate) {
      entry.escalated = true;
      escalate();
      return "escalated";
    }

    return "suppressed";
  };
};

// Whether iCloud sync is delayed, from the macserver's /stats and the live
// lag of recent pushes (liveLag.js). Returns a list of reasons, empty when
// sync is keeping up. Checked every minute by monitorMacServerStats.js.
const MINUTE = 60 * 1000;

// A change the macserver has had for this long without reaching Blot
const QUEUE_LIMIT_MS = 5 * MINUTE;
// The journal reads bird's database every two seconds
const JOURNAL_LIMIT_MS = 2 * MINUTE;
// Paths bird had that never reached the disk, in the last 15 minutes
const GAVE_UP_LIMIT = 3;
// Nothing at all delivered from iCloud to the macserver for this long: the
// link from iCloud to the Mac has probably broken (bird signed out, pushes no
// longer arriving). Quiet nights have gone over six hours without a change.
const DELIVERY_LIMIT_MS = 12 * 60 * MINUTE;
// The median delay from a file's mtime to Blot, over the last 15 minutes,
// from at least LAG_MIN_SAMPLES pushes. Pushes of files whose mtime is over
// an hour old are left out: they are old files copied in, not live edits.
const LAG_WINDOW_MS = 15 * MINUTE;
const LAG_LIMIT_MS = 2 * MINUTE;
const LAG_MIN_SAMPLES = 5;
const LAG_IGNORE_OVER_MS = 60 * MINUTE;

const seconds = (ms) => Math.round(ms / 1000);

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

function syncDelays(stats, lagSamples) {
  const reasons = [];

  if (stats && stats.actions_oldest_ms > QUEUE_LIMIT_MS) {
    reasons.push(
      `The oldest change on the macserver has waited ${seconds(stats.actions_oldest_ms)}s to reach Blot ` +
        `(${stats.actions_pending} waiting; most for ${stats.actions_busiest_blog}: ${stats.actions_busiest_pending}).`
    );
  }

  if (
    stats &&
    stats.journal_running &&
    typeof stats.journal_poll_age_ms === "number" &&
    stats.journal_poll_age_ms > JOURNAL_LIMIT_MS
  ) {
    reasons.push(
      `The macserver last read bird's change journal ${seconds(stats.journal_poll_age_ms)}s ago` +
        (typeof stats.journal_behind === "number"
          ? ` (${stats.journal_behind} changes behind).`
          : ".")
    );
  }

  if (stats && stats.fileprovider_gave_up_15m >= GAVE_UP_LIMIT) {
    reasons.push(
      `In the last 15 minutes, ${stats.fileprovider_gave_up_15m} files that iCloud has never reached the macserver's disk (FileProvider may be stuck).`
    );
  }

  if (
    stats &&
    typeof stats.icloud_last_delivery_age_ms === "number" &&
    stats.icloud_last_delivery_age_ms > DELIVERY_LIMIT_MS
  ) {
    reasons.push(
      `The macserver hasn't received anything from iCloud for ${Math.round(stats.icloud_last_delivery_age_ms / (60 * MINUTE))} hours (the newest sync-down across bird's folders).`
    );
  }

  const live = (lagSamples || [])
    .map((sample) => sample.lagMs)
    .filter((lag) => lag >= 0 && lag < LAG_IGNORE_OVER_MS);

  if (live.length >= LAG_MIN_SAMPLES && median(live) > LAG_LIMIT_MS) {
    reasons.push(
      `Over the last 15 minutes, files took a median of ${seconds(median(live))}s from their save to Blot (${live.length} files).`
    );
  }

  return reasons;
}

module.exports = syncDelays;
module.exports.LAG_WINDOW_MS = LAG_WINDOW_MS;

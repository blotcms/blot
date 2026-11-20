const client = require("models/client");
const clfdate = require("helper/clfdate");

// The delay between a file's mtime on iCloud and Blot taking it, for each
// file the macserver pushes, kept for the delay alert (syncDelays.js). One
// list for every iCloud blog, newest first, as "takenAt:lagMs".
const KEY = "icloud:live-lag";
const MAX_SAMPLES = 500;

// Best effort: a sample that can't be stored only weakens the alert
const record = async (modifiedTime, now = Date.now()) => {
  const modified = Date.parse(modifiedTime);
  if (!Number.isFinite(modified)) return;
  try {
    await client
      .multi()
      .lPush(KEY, `${now}:${now - modified}`)
      .lTrim(KEY, 0, MAX_SAMPLES - 1)
      .exec();
  } catch (error) {
    console.error(clfdate(), "iCloud: could not record live lag", error);
  }
};

// [{ at, lagMs }] taken in the last windowMs, newest first
const recent = async (windowMs, now = Date.now()) => {
  const rows = await client.lRange(KEY, 0, -1);
  const samples = [];
  for (const row of rows) {
    const [at, lagMs] = row.split(":").map(Number);
    if (!Number.isFinite(at) || !Number.isFinite(lagMs)) continue;
    if (now - at > windowMs) break;
    samples.push({ at, lagMs });
  }
  return samples;
};

module.exports = { record, recent, KEY };

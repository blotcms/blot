const { createHistogram } = require("perf_hooks");
const clfdate = require("helper/clfdate");
const config = require("config");

// Tracks how long res.renderView takes to render a customer's page (see
// middleware.js), so the daily update email can report a directional p95.
//
// Cheap in-process histogram, flushed on a timer: each window's p95 is
// pushed onto a per-container Redis list, which app/scheduler/daily reads
// back across all containers to compute a 24h average-of-window-p95s. Not a
// true merged percentile (see the daily step for why that tradeoff is fine
// here), just a directional daily number.

const FLUSH_INTERVAL_MS = 60 * 1000;
const WINDOWS_PER_DAY = Math.ceil((24 * 60 * 60 * 1000) / FLUSH_INTERVAL_MS);
// A little slack over 24h of windows so a slightly-delayed flush doesn't
// truncate the last window the daily email would otherwise have read.
const LIST_MAX_LENGTH = WINDOWS_PER_DAY + 30;
const LIST_TTL_SECONDS = 25 * 60 * 60;

function redisKey(container) {
  return `metrics:render-time:p95:${container}`;
}

// Written by app/scheduler/daily/render-time.js: one entry per day, kept
// effectively forever, for the "all time" chart and the daily email's
// trailing-average comparison.
const DAILY_HISTORY_KEY = "metrics:render-time:daily-p95-history";

// Each list entry is "<window end unix ms>:<p95 ms>" so consumers (the daily
// email, scripts/render-time-chart) can plot/aggregate over real time rather
// than just "windows ago".
function encodeEntry(timestampMs, p95Ms) {
  return `${timestampMs}:${p95Ms}`;
}

function decodeEntry(entry) {
  const [timestampMs, p95Ms] = entry.split(":").map(Number);
  return { timestampMs, p95Ms };
}

const histogram = createHistogram();
let started = false;

function record(durationMs) {
  // record() takes a positive integer in whatever unit the caller chooses;
  // we use whole milliseconds throughout.
  histogram.record(Math.max(1, Math.round(durationMs)));
}

async function flush() {
  const count = histogram.count;

  // Nothing rendered in this window (e.g. an idle canary container) - skip
  // the push rather than record a meaningless p95 of zero.
  if (count === 0) return;

  const p95Ms = Math.round(histogram.percentile(95));
  histogram.reset();

  const container = config.container || "unknown";
  const client = require("models/client");

  try {
    const multi = client.multi();
    multi.rPush(redisKey(container), encodeEntry(Date.now(), p95Ms));
    multi.lTrim(redisKey(container), -LIST_MAX_LENGTH, -1);
    multi.expire(redisKey(container), LIST_TTL_SECONDS);
    await multi.exec();
  } catch (err) {
    console.error(clfdate(), "[render-time] Failed to flush p95 to Redis", err);
  }
}

function start() {
  if (started) return;
  started = true;

  const timer = setInterval(() => {
    flush().catch((err) =>
      console.error(clfdate(), "[render-time] Unexpected flush error", err)
    );
  }, FLUSH_INTERVAL_MS);
  timer.unref();
}

module.exports = {
  record,
  start,
  redisKey,
  encodeEntry,
  decodeEntry,
  DAILY_HISTORY_KEY,
  FLUSH_INTERVAL_MS,
};

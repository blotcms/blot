const { createHistogram } = require("perf_hooks");
const clfdate = require("helper/clfdate");
const config = require("config");

// Tracks how long res.renderView takes to render a customer's page (see
// middleware.js), so the daily update email can report directional p50, p95
// and p99 figures.
//
// Cheap in-process histogram, flushed on a timer: each window's p50/p95/p99
// are pushed onto a per-container Redis list, which app/scheduler/daily reads
// back across all containers to compute 24h averages of each percentile. Not
// true merged percentiles (see the daily step for why that tradeoff is fine
// here), just directional daily numbers.

const FLUSH_INTERVAL_MS = 60 * 1000;
const WINDOWS_PER_DAY = Math.ceil((24 * 60 * 60 * 1000) / FLUSH_INTERVAL_MS);
// A little slack over 24h of windows so a slightly-delayed flush doesn't
// truncate the last window the daily email would otherwise have read.
const LIST_MAX_LENGTH = WINDOWS_PER_DAY + 30;
const LIST_TTL_SECONDS = 25 * 60 * 60;

// The Redis key names below say "p95" for historical reasons (they predate
// p50/p99 tracking) and are kept so existing history isn't lost; entries now
// carry p50 and p99 as well.
function redisKey(container) {
  return `metrics:render-time:p95:${container}`;
}

// Written by app/scheduler/daily/render-time.js: one entry per day, kept
// effectively forever, for the "all time" chart and the daily email's
// trailing-average comparison.
const DAILY_HISTORY_KEY = "metrics:render-time:daily-p95-history";

// Each list entry is "<window end unix ms>:<p95 ms>:<p50 ms>:<p99 ms>" so
// consumers (the daily email, scripts/render-time-chart) can plot/aggregate
// over real time rather than just "windows ago". p95 stays in second place so
// legacy "<ms>:<p95 ms>" entries, and readers that only take the first two
// fields, keep working; p50/p99 decode as NaN for legacy entries.
function encodeEntry(timestampMs, { p50Ms, p95Ms, p99Ms }) {
  return `${timestampMs}:${p95Ms}:${p50Ms}:${p99Ms}`;
}

function decodeEntry(entry) {
  const [timestampMs, p95Ms, p50Ms = NaN, p99Ms = NaN] = entry
    .split(":")
    .map(Number);
  return { timestampMs, p50Ms, p95Ms, p99Ms };
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
  // the push rather than record meaningless percentiles of zero.
  if (count === 0) return;

  const p50Ms = Math.round(histogram.percentile(50));
  const p95Ms = Math.round(histogram.percentile(95));
  const p99Ms = Math.round(histogram.percentile(99));
  histogram.reset();

  const container = config.container || "unknown";
  const client = require("models/client");

  try {
    const multi = client.multi();
    multi.rPush(redisKey(container), encodeEntry(Date.now(), { p50Ms, p95Ms, p99Ms }));
    multi.lTrim(redisKey(container), -LIST_MAX_LENGTH, -1);
    multi.expire(redisKey(container), LIST_TTL_SECONDS);
    await multi.exec();
  } catch (err) {
    console.error(clfdate(), "[render-time] Failed to flush percentiles to Redis", err);
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

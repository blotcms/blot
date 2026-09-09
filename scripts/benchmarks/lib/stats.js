"use strict";

// Small, dependency-free stats helpers shared by the benchmark tooling.

function toFiniteNumbers(values) {
  return (values || []).map(Number).filter((n) => Number.isFinite(n));
}

function median(values) {
  const sorted = toFiniteNumbers(values).sort((a, b) => a - b);
  if (!sorted.length) return null;

  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// Median absolute deviation, scaled to be a consistent estimator of stddev for
// normal-ish data. Robust to the occasional wild sample a noisy CI runner emits.
function mad(values) {
  const nums = toFiniteNumbers(values);
  if (nums.length < 2) return 0;

  const mid = median(nums);
  const deviations = nums.map((n) => Math.abs(n - mid));
  return median(deviations) * 1.4826;
}

function percentChange(current, baseline) {
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || baseline === 0) {
    return null;
  }
  return ((current - baseline) / baseline) * 100;
}

/**
 * Classify one metric against its baseline.
 *
 * `thresholdPercent` is the noise band. A value inside the band is "ok".
 * Outside it, "regression" (slower/bigger) or "improved" (faster/smaller).
 * When `robust` MAD is supplied we also require the move to be at least
 * `sigma` MADs away from the baseline median, so a large percentage move on a
 * tiny absolute metric does not cry wolf.
 */
function classify(current, baseline, options = {}) {
  const { thresholdPercent = 15, mad: madValue = 0, sigma = 3 } = options;
  const delta = percentChange(current, baseline);

  if (delta === null) {
    return { status: "unknown", deltaPercent: null };
  }

  const exceedsBand = Math.abs(delta) > thresholdPercent;
  const exceedsNoise =
    !madValue || Math.abs(current - baseline) > sigma * madValue;

  if (exceedsBand && exceedsNoise) {
    return { status: delta > 0 ? "regression" : "improved", deltaPercent: delta };
  }

  return { status: "ok", deltaPercent: delta };
}

module.exports = { median, mad, percentChange, classify, toFiniteNumbers };

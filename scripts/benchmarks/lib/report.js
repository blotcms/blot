"use strict";

const { METRICS, extractMetrics, formatValue } = require("./metrics");
const { classify } = require("./stats");
const { BENCHMARK_DEFAULTS } = require("../../../app/blog/benchmarks/util/defaults");

const STATUS_LABEL = {
  regression: "regressed",
  improved: "improved",
  ok: "",
  unknown: "",
};

/**
 * Compare a result's metrics against a baseline (as produced by
 * history.computeBaseline). Returns one row per tracked metric.
 */
function compareToBaseline(result, baseline, options = {}) {
  const {
    thresholdPercent = BENCHMARK_DEFAULTS.regressionThresholdPercent,
    sizeThresholdPercent = BENCHMARK_DEFAULTS.sizeThresholdPercent,
  } = options;

  const current = extractMetrics(result);
  const baseMetrics = (baseline && baseline.metrics) || {};

  return METRICS.map((metric) => {
    const value = current[metric.key];
    const base = baseMetrics[metric.key] || { median: null, mad: 0 };
    const band = metric.deterministic ? sizeThresholdPercent : thresholdPercent;

    const { status, deltaPercent } = classify(value, base.median, {
      thresholdPercent: band,
      mad: base.mad,
    });

    return {
      key: metric.key,
      label: metric.label,
      unit: metric.unit,
      current: value,
      baseline: base.median,
      deltaPercent,
      status,
    };
  });
}

function fmtDelta(deltaPercent) {
  if (deltaPercent === null || deltaPercent === undefined) return "–";
  const sign = deltaPercent >= 0 ? "+" : "";
  return `${sign}${deltaPercent.toFixed(1)}%`;
}

function markdownTable(rows) {
  const lines = [
    "| Metric | This run | master baseline | Δ | |",
    "|---|--:|--:|--:|:--|",
  ];

  for (const row of rows) {
    lines.push(
      "| " +
        [
          row.label,
          formatValue(row.current, row.unit),
          formatValue(row.baseline, row.unit),
          fmtDelta(row.deltaPercent),
          STATUS_LABEL[row.status] || "",
        ].join(" | ") +
        " |"
    );
  }

  return lines.join("\n");
}

function hasRegression(rows) {
  return rows.some((row) => row.status === "regression");
}

module.exports = { compareToBaseline, markdownTable, hasRegression, fmtDelta };

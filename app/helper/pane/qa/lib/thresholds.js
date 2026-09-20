// Pass/fail decisions from metrics. Pure: takes the thresholds object.

const fs = require("fs");
const path = require("path");

function loadThresholds(file = path.join(__dirname, "..", "thresholds.json")) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function limitsFor(thresholds, id) {
  const base = thresholds.default || {};
  const own = (thresholds.cases || {})[id] || {};
  return {
    ...base,
    ...own,
    diffPercent: { ...base.diffPercent, ...own.diffPercent },
  };
}

// Returns { pass, failures: [{ metric, region?, value, limit }] }
function evaluate(entry, thresholds) {
  const limits = limitsFor(thresholds, entry.id);
  const failures = [];
  const check = (metric, value, limit, region) => {
    if (limit === undefined || limit === null || value === null || value === undefined) return;
    if (value > limit) failures.push({ metric, ...(region ? { region } : {}), value, limit });
  };

  check("diffPercent", entry.diff.percent, limits.diffPercent.overall, "overall");
  for (const r of entry.regions) {
    const limit = limits.diffPercent[r.name] !== undefined ? limits.diffPercent[r.name] : limits.diffPercent[r.kind];
    check("diffPercent", r.percent, limit, r.name);
  }
  check("sizeDelta", Math.max(Math.abs(entry.geometry.sizeDelta.w), Math.abs(entry.geometry.sizeDelta.h)), limits.sizeDelta);
  check("rowYOffset", entry.rows.meanYOffset / entry.scale, limits.rowYOffset);
  // a case whose reference has no shadow (Linux) is still checked: the
  // rendering shouldn't add one
  check("shadowError", entry.shadow.error, limits.shadowError);
  return { pass: failures.length === 0, failures };
}

module.exports = { loadThresholds, limitsFor, evaluate };

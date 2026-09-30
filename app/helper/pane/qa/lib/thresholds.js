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
    inkPercent: { ...base.inkPercent, ...own.inkPercent },
    flatDeltaE: { ...base.flatDeltaE, ...own.flatDeltaE },
    blurMae: { ...base.blurMae, ...own.blurMae },
  };
}

// A case entry can set "informational": true (e.g. a hand-written fixture of a view
// authors can't pick from the editor, with no meaningful default thresholds): it is
// still measured and reported, but a threshold miss shouldn't fail the run.
function isInformational(thresholds, id) {
  return !!((thresholds.cases || {})[id] || {}).informational;
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
  const byRegion = (table, r) => (table[r.name] !== undefined ? table[r.name] : table[r.kind]);
  for (const r of entry.regions) {
    check("inkPercent", r.inkPercent, byRegion(limits.inkPercent, r), r.name);
    check("flatDeltaE", r.flat ? r.flat.deltaE : null, byRegion(limits.flatDeltaE, r), r.name);
    check("blurMae", r.blurMae, byRegion(limits.blurMae, r), r.name);
  }
  check("blurMae", entry.blurMae, limits.blurMae.overall, "overall");
  check("sizeDelta", Math.max(Math.abs(entry.geometry.sizeDelta.w), Math.abs(entry.geometry.sizeDelta.h)), limits.sizeDelta);
  check("rowYOffset", entry.rows.meanYOffset / entry.scale, limits.rowYOffset);
  // a case whose reference has no shadow (Linux) is still checked: the
  // rendering shouldn't add one
  check("shadowError", entry.shadow.error, limits.shadowError);
  return { pass: failures.length === 0, failures };
}

module.exports = { loadThresholds, limitsFor, evaluate, isInformational };

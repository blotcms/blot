// Shared constants for the pane QA tooling.

// The grey desktop every reference is captured on (50% grey).
const BG = [128, 128, 128];

// Rendered pages get this "now" (see lib/render.js), so anything computed from
// the current time is stable. Fixtures should hard-code the dates they show.
const FROZEN_NOW = "2026-09-20T15:38:00";

module.exports = { BG, FROZEN_NOW };

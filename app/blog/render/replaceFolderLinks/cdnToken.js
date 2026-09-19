// Sentinel baked into CDN URLs in place of the real origin when a URL is
// produced once, at entry build time (app/build/plugins/folderAssets), or
// by lookupFile.js at request time. A single unconditional string-replace
// in middleware.js swaps it for the real, protocol-adjusted CDN origin
// immediately before the response is sent, so future CDN routing changes
// (white-labeling, same-host serving) only need to change that one step.
// Anything that reads stored entry HTML and doesn't go through
// middleware.js (e.g. dashboard/site/export.js) must resolve it itself.
module.exports = "%%BLOT_CDN%%";

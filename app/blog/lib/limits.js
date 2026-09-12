// Hard cap on how many entries the archives and allEntries template tags
// fetch. Without it, large blogs (nashp.com had ~800 entries at the time of
// issue #1806) load and synchronously process every entry on every request
// to /archives, which under aggressive bot crawling was serialized/slow
// enough to block the shared Node event loop and OOM the process.
//
// This is a breaking change for templates that rely on allEntries/archives
// listing every single post on very large blogs. A production Redis scan
// found the biggest blogs run to ~4,600 entries and nashp.com (the blog that
// actually triggered #1806) sits at ~800 - 1000 covers that with headroom
// while still bounding the most extreme blogs. This clamp is a stopgap, not
// a fix: it doesn't help a blog like anchor.com, whose problem is huge
// individual entries rather than entry count. See issue #1806 for the real
// fix in progress (a precomputed archives index + re-enabling field-narrowed
// hash reads) and the longer-term plan to migrate archive-style templates to
// a paginated {{#posts}} pattern.
module.exports.MAX_ENTRIES = 1000;

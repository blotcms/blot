const Blog = require("models/blog");
const Entry = require("models/entry");
const Entries = require("models/entries");
const Template = require("models/template");
const Tags = require("models/tags");
const Redirects = require("models/redirects");
const User = require("models/user");
const { stackWithFallback } = require("blog/static/fonts/fallback");

// All adapters look up the model method at call time so Jasmine spies
// (and other runtime replacements) still take effect.

function getBlog(identifier) {
  return Blog.get(identifier);
}

// Stored font stacks end without a generic family or fonts for Arabic and
// Japanese. Both the live render (middleware/loadTemplate) and the CDN
// stylesheet render (render/view) read locals here, so both get the fallback
// without it being written to the template. Copies, in case metadata is shared.
function withFontFallbacks(metadata) {
  if (!metadata || !metadata.locals) return metadata;
  const locals = { ...metadata.locals };
  for (const key of Object.keys(locals)) {
    if (key !== "font" && !key.includes("_font")) continue;
    const font = locals[key];
    if (!font || typeof font !== "object" || !font.stack) continue;
    locals[key] = { ...font, stack: stackWithFallback(font) };
  }
  return { ...metadata, locals };
}

async function getMetadata(templateID) {
  return withFontFallbacks(await Template.getMetadata(templateID));
}

function getFullView(blogID, templateID, viewName, options) {
  return Template.getFullView(blogID, templateID, viewName, options || {});
}

function searchEntries(blogID, query, options) {
  return Entry.search(blogID, query, options);
}

function popularTags(blogID, options) {
  return Tags.popular(blogID, options);
}

function checkRedirect(blogID, url) {
  return Redirects.check(blogID, url);
}

function getUserById(id) {
  return User.getById(id);
}

// Resolves to { entries, pagination }
function getPage(blogID, options) {
  return Entries.getPage(blogID, options);
}

// A failed read is the same as no entry (undefined, or [] for a list of IDs),
// as it was when Entry.get called back without an error argument.
function getEntry(blogID, entryIDs) {
  return Entry.get(blogID, entryIDs).catch(() =>
    Array.isArray(entryIDs) ? [] : undefined
  );
}

// A failed lookup is the same as no entry
function getEntryByUrl(blogID, entryUrl) {
  return Entry.getByUrl(blogID, entryUrl).catch(() => undefined);
}

// Like getEntryByUrl, but also reports the Redis error Entry.getByUrl
// rejects with, for callers that must not cache a failed lookup.
function lookupEntryByUrl(blogID, entryUrl) {
  return Entry.getByUrl(blogID, entryUrl).then(
    (entry) => ({ entry, error: undefined }),
    (error) => ({ entry: undefined, error })
  );
}

async function adjacentTo(blogID, entryID) {
  const { next, previous, index } = await Entries.adjacentTo(blogID, entryID);
  return { next, previous, index };
}

function randomEntry(blogID) {
  return Entries.random(blogID);
}

// Resolves [] on a Redis failure. rejectOnOutage makes it reject on a Redis
// outage instead, so that no caller renders or caches an empty list as real.
function getAll(blogID) {
  return Entries.getAll(blogID, { rejectOnOutage: true });
}

function getTotal(blogID) {
  return Entries.getTotal(blogID);
}

module.exports = {
  getBlog,
  getMetadata,
  getFullView,
  getPage,
  searchEntries,
  popularTags,
  checkRedirect,
  getUserById,
  getViewByURL: (...args) => Template.getViewByURL(...args),
  getEntry,
  getEntryByUrl,
  lookupEntryByUrl,
  adjacentTo,
  randomEntry,
  getAll,
  getTotal,
};

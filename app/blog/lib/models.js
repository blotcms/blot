const Blog = require("models/blog");
const Entry = require("models/entry");
const Entries = require("models/entries");
const Template = require("models/template");
const Tags = require("models/tags");
const Redirects = require("models/redirects");
const User = require("models/user");

// All adapters look up the model method at call time so Jasmine spies
// (and other runtime replacements) still take effect.

function getBlog(identifier) {
  return Blog.get(identifier);
}

function getMetadata(templateID) {
  return Template.getMetadata(templateID);
}

function getFullView(blogID, templateID, viewName, options) {
  return new Promise((resolve, reject) => {
    Template.getFullView(
      blogID,
      templateID,
      viewName,
      options || {},
      (err, response) => {
        if (err) reject(err);
        else resolve(response);
      }
    );
  });
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

function adjacentTo(blogID, entryID) {
  return new Promise((resolve) => {
    Entries.adjacentTo(blogID, entryID, (next, previous, index) => {
      resolve({ next, previous, index });
    });
  });
}

function randomEntry(blogID) {
  return new Promise((resolve) => {
    Entries.random(blogID, (entry) => resolve(entry));
  });
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

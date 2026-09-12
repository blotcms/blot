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
  return new Promise((resolve, reject) => {
    Blog.get(identifier, (err, blog) => {
      if (err) reject(err);
      else resolve(blog);
    });
  });
}

function getMetadata(templateID) {
  return new Promise((resolve, reject) => {
    Template.getMetadata(templateID, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata);
    });
  });
}

function getFullView(blogID, templateID, viewName) {
  return new Promise((resolve, reject) => {
    Template.getFullView(blogID, templateID, viewName, (err, response) => {
      if (err) reject(err);
      else resolve(response);
    });
  });
}

function searchEntries(blogID, query, options) {
  return new Promise((resolve, reject) => {
    Entry.search(blogID, query, options, (err, results) => {
      if (err) reject(err);
      else resolve(results);
    });
  });
}

function listTags(blogID, options) {
  return new Promise((resolve, reject) => {
    Tags.list(blogID, options, (err, tags) => {
      if (err) reject(err);
      else resolve(tags);
    });
  });
}

function popularTags(blogID, options) {
  return new Promise((resolve, reject) => {
    Tags.popular(blogID, options, (err, tags) => {
      if (err) reject(err);
      else resolve(tags);
    });
  });
}

function checkRedirect(blogID, url) {
  return new Promise((resolve, reject) => {
    Redirects.check(blogID, url, (err, redirect) => {
      if (err) reject(err);
      else resolve(redirect);
    });
  });
}

function getUserById(id) {
  return new Promise((resolve, reject) => {
    User.getById(id, (err, user) => {
      if (err) reject(err);
      else resolve(user);
    });
  });
}

// getPage's callback is (err, entries, pagination) — promisify would drop pagination.
function getPage(blogID, options) {
  return new Promise((resolve, reject) => {
    Entries.getPage(blogID, options, (err, entries, pagination) => {
      if (err) return reject(err);
      resolve({ entries, pagination });
    });
  });
}

// getViewByURL's callback is (err, viewName, params).
function getViewByURL(template, url) {
  return new Promise((resolve, reject) => {
    Template.getViewByURL(template, url, (err, viewName, params) => {
      if (err) return reject(err);
      resolve({ viewName, params });
    });
  });
}

// Entry.get / getByUrl and several Entries helpers are NOT err-first —
// they omit the error argument. Mirror the adapter used in models/entry/search.js.
function getEntry(blogID, entryIDs, fields) {
  return new Promise((resolve) => {
    if (fields === undefined) {
      Entry.get(blogID, entryIDs, (entries) => resolve(entries));
    } else {
      Entry.get(blogID, entryIDs, fields, (entries) => resolve(entries));
    }
  });
}

function getEntryByUrl(blogID, entryUrl) {
  return new Promise((resolve) => {
    Entry.getByUrl(blogID, entryUrl, (entry) => resolve(entry));
  });
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

// getAll / getRecent callback with (entries) only — never an error argument.
function getAll(blogID, options) {
  return new Promise((resolve) => {
    if (options === undefined) {
      Entries.getAll(blogID, (entries) => resolve(entries));
    } else {
      Entries.getAll(blogID, options, (entries) => resolve(entries));
    }
  });
}

function getRecent(blogID, options) {
  return new Promise((resolve) => {
    if (options === undefined) {
      Entries.getRecent(blogID, (entries) => resolve(entries));
    } else {
      Entries.getRecent(blogID, options, (entries) => resolve(entries));
    }
  });
}

function getTotal(blogID) {
  return new Promise((resolve, reject) => {
    Entries.getTotal(blogID, (err, total) => {
      if (err) reject(err);
      else resolve(total);
    });
  });
}

module.exports = {
  getBlog,
  getMetadata,
  getFullView,
  getPage,
  searchEntries,
  listTags,
  popularTags,
  checkRedirect,
  getUserById,
  getViewByURL,
  getEntry,
  getEntryByUrl,
  adjacentTo,
  randomEntry,
  getAll,
  getRecent,
  getTotal,
};

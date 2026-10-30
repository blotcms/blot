// Small helpers shared by the git client's specs which use the real git
// client (./client.js).

var Entry = require("models/entry");
var fs = require("fs-extra");
var readTree = require("./client").readTree;

// Resolves with the blog's entry at a path (a deleted entry stays in the
// database as a tombstone with deleted: true), or undefined if there is none.
exports.entry = function (blogID, path) {
  return new Promise(function (resolve) {
    Entry.get(blogID, path, function (entry) {
      resolve(entry);
    });
  });
};

// A path made only of lowercase latin words, so a spec's failure is never
// down to an odd name that a random generator happened to produce.
exports.randomPath = function (fake, extension) {
  var depth = 1 + Math.floor(Math.random() * 3);
  var parts = [];

  while (parts.length < depth) parts.push(fake.lorem.word().toLowerCase());

  return "/" + parts.join("/") + (extension || ".txt");
};

// The blog folder's files, without its .git directory, as
// { "relative/path": Buffer }
exports.blogFiles = function (ctx) {
  return readTree(ctx.blogDirectory);
};

exports.blogFile = function (ctx, path) {
  return fs.readFile(ctx.blogDirectory + path);
};

exports.blogHas = function (ctx, path) {
  return fs.pathExists(ctx.blogDirectory + path);
};

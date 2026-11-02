// A git object store which keeps repositories in S3 and reads them by range.
// See README. This directory imports nothing from the rest of Blot (a spec
// checks), so it can move to a project of its own.
const errors = require("./errors");
const layout = require("./layout");
const manifest = require("./manifest");
const createCache = require("./cache");
const createMemoryStore = require("./objectStore/memory");
const createFsStore = require("./objectStore/fs");
const createReader = require("./reader");
const { readRanges } = require("./ranges");

// The SDK is only loaded if an S3 store is made
function createS3Store(options) {
  return require("./objectStore/s3")(options);
}

module.exports = {
  createCache,
  createMemoryStore,
  createFsStore,
  createS3Store,
  createReader,
  readRanges,
  manifest,
  layout,
  errors,
};

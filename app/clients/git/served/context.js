// What every user of the git store in this process shares (#2259): one object
// store per blog, kept for reuse so its memos (the manifest it last read, the
// sizes of its packs) help the next operation, and one cache, so a process has
// one cache budget whichever side uses it. Shadow mode (../shadow) and the
// served path (this directory) both take their stores and cache from here.
//
//   storeFor(blogID)        the blog's store, counted (../shadow/counting.js)
//                           and kept
//   objectStoreFor(blogID)  a fresh, uncounted store, for the daily upkeep and
//                           removal, which list and delete
//   cache()                 the process's cache (../store/cache.js)
//   refLock(blogID)         the lock(fn) the store's writes take for a blog
//                           served from the store: the EBS ref lock
//   hasStore()              whether there is a bucket (or a spec's stores)
//
// The store lives under <blogID>/git/ in the storage bucket.
const path = require("path");
const { LRUCache } = require("lru-cache");
const config = require("config");
const { createCache, createS3Store } = require("../store");
const counting = require("../shadow/counting");

// How many blogs' stores are kept for reuse. A store is a small object.
const STORES = 1000;

// The object store for a blog: the storage bucket, under <blogID>/git/. The
// S3 client is asked for on each request, because storage/s3 replaces it if
// its configuration changes. Each request it sends is counted (counting.js):
// a large pack's put is several, and a long list several pages. Specs replace
// this with _setObjectStore.
function s3ObjectStore(blogID) {
  const s3 = require("storage/s3");

  s3.assertConfigured();

  const store = createS3Store({
    client: {
      send: (command) => {
        counting.sent();
        return s3.client().send(command);
      },
    },
    bucket: config.storage.bucket,
    prefix: blogID + "/git/",
  });

  return Object.assign(store, { countsOwnRequests: true });
}

let makeObjectStore = s3ObjectStore;
let stores = new LRUCache({ max: STORES });
let sharedCache = null;

// One cache per process, in a directory of its own, since a cache must own its
// directory (the units' two processes share tmp)
function cache() {
  if (!sharedCache) {
    const label = String(config.container || "").replace(/[^A-Za-z0-9_]+/g, "-").replace(/^-+|-+$/g, "") || "main";

    sharedCache = createCache({
      dir: path.join(config.git_store.cache_directory, label),
      maxBytes: config.git_store.cache_bytes,
    });
  }

  return sharedCache;
}

// The same object for the life of the blog's store in this process, since the
// store keeps its memos by object identity
function storeFor(blogID) {
  let store = stores.get(blogID);

  if (!store) {
    store = counting(makeObjectStore(blogID));
    stores.set(blogID, store);
  }

  return store;
}

function objectStoreFor(blogID) {
  return makeObjectStore(blogID);
}

// The blog's store is forgotten (its copy is being removed)
function forget(blogID) {
  stores.delete(blogID);
}

function hasStore() {
  return makeObjectStore !== s3ObjectStore || !!(config.storage && config.storage.bucket);
}

// For a blog served from the store, its writes (a push, Blot's commit) take
// the EBS ref lock (repo.holdRefLock, blog:<id>:git:ref-lock): one lock per
// blog, whichever side is written. The store holds it only around a manifest
// swap; a caller already holding it passes a lock of its own instead.
function refLock(blogID) {
  return async function (fn) {
    const release = await require("../repo").holdRefLock(blogID);

    try {
      return await fn();
    } finally {
      await Promise.resolve()
        .then(release)
        .catch(() => {});
    }
  };
}

// For specs: the object store a blog's store is made on (null for S3), and
// forgetting the stores and the cache made so far
function _setObjectStore(factory) {
  makeObjectStore = factory || s3ObjectStore;
  _reset();
}

function _reset() {
  stores = new LRUCache({ max: STORES });
  sharedCache = null;
}

module.exports = {
  storeFor,
  objectStoreFor,
  cache,
  forget,
  hasStore,
  refLock,
  _setObjectStore,
  _reset,
};

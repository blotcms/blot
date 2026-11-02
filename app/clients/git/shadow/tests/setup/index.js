// Shared set-up for the shadow mode specs: a test blog with the git client and
// a real git clone (../../../tests/setup), shadow mode on for every blog, a
// memory object store per blog (or whatever the spec passes), the shadow's
// cache in the spec's tmp folder, and the lines shadow mode logs.
//
//   var setup = require("./setup");
//   setup();                                        memory stores
//   setup({ objectStore: function (blogID) {...} }) a store of the spec's
//
// In a spec: this.stores[blogID] is the blog's memory store, this.shadowLines()
// what shadow mode has logged, and setup.expectMirrored(ctx, store) checks the
// store against the EBS repository through the store's own clone code.
var config = require("config");
var shadow = require("clients/git/shadow");
var repo = require("clients/git/repo");
var { createCache, createMemoryStore, manifest } = require("clients/git/store");
var { verifyImport } = require("clients/git/store/import");
var { spawnSync } = require("child_process");

function setup(options) {
  options = options || {};

  require("clients/git/tests/setup")({ clone: false, client: true });

  var saved;

  beforeEach(function () {
    var ctx = this;

    saved = Object.assign({}, config.git_store);
    config.git_store.shadow = options.shadow === undefined ? "all" : options.shadow;
    config.git_store.cache_directory = ctx.tmp + "/git-store-cache";
    config.git_store.cache_bytes = 256 * 1024 * 1024;

    ctx.stores = {};
    shadow._setObjectStore(
      options.objectStore
        ? options.objectStore.bind(ctx)
        : function (blogID) {
            return (ctx.stores[blogID] = ctx.stores[blogID] || createMemoryStore());
          }
    );

    ctx.lines = [];
    var log = console.log;
    spyOn(console, "log").and.callFake(function () {
      var line = Array.prototype.join.call(arguments, " ");
      if (line.indexOf("[git-store-shadow]") !== -1) ctx.lines.push(line);
      log.apply(console, arguments);
    });

    ctx.shadowLines = function (op) {
      return ctx.lines.filter(function (line) {
        return !op || line.indexOf(" op=" + op + " ") !== -1;
      });
    };

    ctx.gitDir = repo.directory(ctx.blog.handle);
  });

  // Nothing from a spec is still running when the next starts
  afterEach(async function () {
    await shadow.idle(this.blog.id);
    Object.assign(config.git_store, saved);
    shadow._setObjectStore(null);
  });
}

// The EBS repository's branches and tags, as { ref: oid }
function ebsRefs(gitDir) {
  var result = spawnSync("git", ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/tags"], {
    env: Object.assign({}, process.env, { GIT_DIR: gitDir }),
    encoding: "utf8",
  });
  var refs = {};

  result.stdout
    .split("\n")
    .filter(Boolean)
    .forEach(function (line) {
      var parts = line.split(" ");
      refs[parts[1]] = parts[0];
    });

  return refs;
}

// Waits for shadow mode to finish with the blog, then checks that the store's
// refs are the EBS repository's, and that a clone of the store through its own
// clone code passes index-pack --strict and fsck --strict with the same refs,
// HEAD and peeled tags (verifyImport).
setup.expectMirrored = async function (ctx, store) {
  await shadow.idle(ctx.blog.id);

  store = store || ctx.stores[ctx.blog.id];

  var current = await manifest.read(store);

  expect(current.refs).toEqual(ebsRefs(ctx.gitDir));

  var cache = createCache({ dir: ctx.tmp + "/verify-cache-" + Date.now(), maxBytes: 256 * 1024 * 1024 });

  await verifyImport({ store: store, cache: cache, gitDir: ctx.gitDir });

  return current;
};

setup.ebsRefs = ebsRefs;

setup.git = function (gitDir, args) {
  var result = spawnSync("git", args, {
    env: Object.assign({}, process.env, { GIT_DIR: gitDir }),
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error("git " + args.join(" ") + ": " + result.stderr);
  return result.stdout.trim();
};

module.exports = setup;

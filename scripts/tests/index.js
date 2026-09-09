var Jasmine = require("jasmine");
var jasmine = new Jasmine();
var colors = require("colors");
var client = require("models/client");
var clfdate = require("helper/clfdate");
var seedrandom = require("seedrandom");
var async = require("async");
var fs = require("fs");
var path = require("path");
var seed;
var config = {
  spec_dir: "",
  spec_files: [
    "**/tests/**/*.js",
    "**/tests.js",
    // Exclude node_modules since we don't want to run tests in dependencies
    "!**/node_modules/**",
  ],
  helpers: [],
  stopSpecOnExpectationFailure: false,
  random: true,
};

// Collect only the user-passed args.
// If "--" is present, only consider args after it.
const rawArgs = process.argv.slice(2);
const dashdash = rawArgs.indexOf("--");
const cliArgs = dashdash >= 0 ? rawArgs.slice(dashdash + 1) : rawArgs;

// Split flags (--foo=bar / --foo) from positionals ([path, seed]).
const flags = {};
const args = [];
for (const arg of cliArgs) {
  const m = /^--([^=]+)=(.*)$/.exec(arg);
  if (m) {
    flags[m[1]] = m[2];
  } else if (arg.startsWith("--")) {
    flags[arg.slice(2)] = true;
  } else {
    args.push(arg);
  }
}

// --shard=INDEX/TOTAL runs a deterministic 1/TOTAL slice of the spec files
// under the given path, so CI can fan one suite out across several jobs.
// Selection is round-robin (file i -> shard i % TOTAL) after a stable sort,
// spreading a directory's heavy files across shards rather than piling them
// into one contiguous chunk.
let shard = null;
if (flags.shard) {
  const parts = String(flags.shard).split("/");
  const index = parseInt(parts[0], 10);
  const total = parseInt(parts[1], 10);
  if (!(total >= 1) || !(index >= 1) || index > total) {
    throw new Error(
      `Invalid --shard=${flags.shard} (expected INDEX/TOTAL, 1-based, INDEX <= TOTAL)`
    );
  }
  shard = { index, total };
}

// --exclude=path[,path...] drops any spec file at or below one of these
// paths (relative to the project root), so a heavy sub-tree of a suite can
// be carved out into its own matrix entry.
const excludePrefixes = (flags.exclude ? String(flags.exclude).split(",") : [])
  .map((p) => p.trim())
  .filter(Boolean)
  .map((p) => path.relative(process.cwd(), path.resolve(process.cwd(), p)));

function isExcluded(rel) {
  return excludePrefixes.some(
    (prefix) => rel === prefix || rel.startsWith(prefix + path.sep)
  );
}

// Recursively list the spec files the runner would pick up under `rootDir`,
// mirroring the spec_files globs above: any *.js inside a `tests/` directory
// or any file named `tests.js`, excluding node_modules and --exclude paths.
function listSpecFiles(rootDir) {
  const out = [];
  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        const rel = path.relative(process.cwd(), full);
        const segments = rel.split(path.sep);
        if (
          (segments.includes("tests") || entry.name === "tests.js") &&
          !isExcluded(rel)
        ) {
          out.push(rel);
        }
      }
    }
  })(rootDir);
  return out.sort();
}

// Pass in a custom test glob for running only specific tests
if (args[0]) {
  console.log(clfdate(), "Running specs in", colors.cyan(args[0]));

  // Specific file
  if (args[0].endsWith(".js")) {
    config.spec_files = [args[0]];
  } else {
    // Directory
    config.spec_dir = args[0];
  }
} else {
  console.log(
    clfdate(),
    "If you want to run tests from a subdirectory:",
    colors.cyan("npm test app/models"),
    "or",
    colors.cyan("npm test -- app/models")
  );
}

// --shard / --exclude only make sense against a directory (or the whole
// tree). A specific spec file was already pinned into config.spec_files
// above, so leave it alone and ignore the flags.
const targetIsFile = !!(args[0] && args[0].endsWith(".js"));
if (targetIsFile && (shard || excludePrefixes.length > 0)) {
  console.log(
    clfdate(),
    colors.yellow(
      `Ignoring --shard/--exclude: a specific spec file was given (${args[0]}).`
    )
  );
  shard = null;
  excludePrefixes.length = 0;
}

// Build an explicit spec-file list when sharding and/or excluding - both
// need the same discovery + exclude filter (listSpecFiles applies
// isExcluded), and a shard then takes a round-robin slice of it. This
// replaces the spec_dir / spec_files globs; the list is added after
// loadConfig() below.
let shardFiles = null;
if (!targetIsFile && (shard || excludePrefixes.length > 0)) {
  const root = path.resolve(process.cwd(), args[0] || ".");
  const filteredFiles = listSpecFiles(root);

  if (shard) {
    shardFiles = filteredFiles.filter(
      (_, i) => i % shard.total === shard.index - 1
    );
    console.log(
      clfdate(),
      `Shard ${shard.index}/${shard.total}:`,
      colors.cyan(`${shardFiles.length} of ${filteredFiles.length} spec files`)
    );
    if (shardFiles.length === 0) {
      console.log(
        clfdate(),
        colors.yellow(
          `Shard ${shard.index}/${shard.total} matched no spec files - ` +
            `TOTAL (${shard.total}) is larger than the file count for this path.`
        )
      );
    }
  } else {
    shardFiles = filteredFiles;
    console.log(
      clfdate(),
      `Excluding ${excludePrefixes.join(", ")}:`,
      colors.cyan(`${shardFiles.length} spec files`)
    );
  }

  config.spec_dir = "";
  config.spec_files = [];
}

// Seed: 2nd positional arg, or env, or random
if (args[1]) {
  seed = args[1];
} else {
  seed =
    process.env.BLOT_TESTS_SEED || String(Math.floor(Math.random() * 100000));
  console.log(
    clfdate(),
    "If you want your own seed run:",
    colors.cyan("npm test app/models/test.js SEED"),
    "or",
    colors.cyan("npm test -- app/models/test.js SEED")
  );
}

seedrandom(seed, { global: true });
jasmine.seed(seed);
jasmine.loadConfig(config);

if (shardFiles) {
  shardFiles.forEach((f) =>
    jasmine.addSpecFile(path.resolve(process.cwd(), f))
  );
}

// Build command for re-running with DEBUG
function buildDebugCommand() {
  var cmd = "DEBUG=blot* npm test";
  if (args[0]) cmd += " " + args[0];
  if (args[1]) cmd += " " + args[1];
  if (flags.shard || flags.exclude) {
    cmd += " --";
    if (flags.shard) cmd += " --shard=" + flags.shard;
    if (flags.exclude) cmd += " --exclude=" + flags.exclude;
  }
  return cmd;
}

// Log DEBUG command at start (only if DEBUG is not already set)
if (!process.env.DEBUG) {
  console.log(
    clfdate(),
    "To run with debug logs:",
    colors.cyan(buildDebugCommand())
  );
}

jasmine.addReporter({
  specStarted: function (result) {
    console.time(colors.dim(" " + result.fullName));
  },
  specDone: function (result) {
    console.timeEnd(colors.dim(" " + result.fullName));
  },
});

var startTimes = {};
var durations = {};

jasmine.addReporter({
  specStarted: function (result) {
    startTimes[result.fullName] = Date.now();
  },
  specDone: function (result) {
    durations[result.fullName] = Date.now() - startTimes[result.fullName];
  },
  jasmineDone: function (result) {
    console.log(clfdate(), "Slowest specs:");
    Object.keys(durations)
      .sort(function (a, b) {
        return durations[b] - durations[a];
      })
      .map((fullName) => durations[fullName] + "ms " + colors.dim(fullName))
      .slice(0, 10)
      .forEach((line) => console.log(line));

    // If tests failed, show how to re-run with DEBUG (only if DEBUG is not already set)
    if (result.overallStatus === "failed" && !process.env.DEBUG) {
      console.log();
      console.log("Re-run with debug logs:");
      console.log(colors.cyan(buildDebugCommand()));
      console.log();
    }
  },
});

global.test = {
  CheckEntry: require("./util/checkEntry"),
  SyncAndCheck: require("./util/syncAndCheck"),

  compareDir: require("./util/compareDir"),

  fake: require("./util/fake"),

  user: function () {
    beforeEach(function (done) {
      require("./util/createUser").call(this, function (err) {
        done(err);
      });
    });

    afterEach(function (done) {
      require("./util/removeUser").call(this, function (err) {
        done(err);
      });
    });
  },

  server: require("./util/server"),

  site: require("./util/site"),

  templates: require("./util/templates"),

  timeout: function (ms) {
    // Store original value
    let originalTimeout;

    beforeAll(function () {
      // In your setup, jasmine.DEFAULT_TIMEOUT_INTERVAL isn't available
      // We need to access the timeout through the Jasmine instance
      originalTimeout = jasmine.jasmine.DEFAULT_TIMEOUT_INTERVAL;
      jasmine.jasmine.DEFAULT_TIMEOUT_INTERVAL = ms;
    });

    afterAll(function () {
      jasmine.jasmine.DEFAULT_TIMEOUT_INTERVAL = originalTimeout || 5000;
    });
  },

  blogs: function (total) {
    beforeEach(require("./util/createUser"));
    afterEach(require("./util/removeUser"));

    beforeEach(function (done) {
      var context = this;
      context.blogs = [];
      async.times(
        total,
        function (blog, next) {
          var result = { user: context.user };
          require("./util/createBlog").call(result, function () {
            context.blogs.push(result.blog);
            next();
          });
        },
        done
      );
    });

    afterEach(function (done) {
      var context = this;
      async.each(
        this.blogs,
        function (blog, next) {
          require("./util/removeBlog").call(
            { user: context.user, blog: blog },
            next
          );
        },
        done
      );
    });
  },

  blog: function () {
    beforeEach(require("./util/createUser"));
    afterEach(require("./util/removeUser"));

    beforeEach(require("./util/createBlog"));
    afterEach(require("./util/removeBlog"));
  },

  tmp: function () {
    beforeEach(require("./util/createTmpDir"));
    afterEach(require("./util/removeTmpDir"));
  },
};

// get the number of keys in the database
(async function ensureEmptyDatabase() {
  let hasKeys = false;

  for await (const _ of client.scanIterator({ MATCH: "*", COUNT: 1 })) {
    if (_.length > 0) {
      hasKeys = true;
      break;
    }
  }

  if (!hasKeys) {
    // if there are no keys, we need to run the tests
    jasmine.execute();
  } else {
    // if there are keys, we need to throw an error
    throw new Error("Database is not empty: keys found");
  }
})().catch(function (err) {
  throw err;
});

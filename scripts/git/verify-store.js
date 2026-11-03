// Checks one git blog's copy in the git store (git/<blogID>/ in the storage
// bucket) against its repository on disk, with the checks the daily
// maintenance runs (app/clients/git/shadow/maintenance.js), and prints the
// result as JSON. It reads, and writes nothing to the store or the repository.
//
//   cheap (always)  branches and tags equal, peeled tags equal, and every file
//                   the newest manifest names is in the bucket at its size
//   --deep          also clone the store through its own clone code into
//                   scratch, index-pack --strict, fsck --strict, and compare
//                   every branch, tag and HEAD with the repository on disk
//
// A check that finds anything is run once more after a delay (--recheck <s>,
// default 10 seconds), in case a push was in flight. The log lines, in shadow
// mode's format (op=verify), go to stderr.
//
// Usage, on the production host, as uid 1000, which owns the repositories
// (git refuses a repository owned by another user):
//
//   docker exec -u 1000 blot-blue node scripts/git/verify-store.js --blog <blogID> [--deep]
//
// Exits 0 if the blog checked out, 1 if anything was found, 2 for bad
// arguments.
const config = require("config");

function usage(message) {
  if (message) console.error(message + "\n");
  console.error("Usage: node scripts/git/verify-store.js --blog <blogID> [--deep] [--recheck <seconds>] [--scratch <dir>]");
  process.exit(2);
}

function parse(argv) {
  const options = { recheckDelayMs: 10 * 1000 };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--deep") options.deep = true;
    else if (arg === "--blog" || arg === "--recheck" || arg === "--scratch") {
      const value = argv[++i];
      if (!value) usage(arg + " needs a value");
      if (arg === "--blog") options.blog = value;
      else if (arg === "--scratch") options.scratchDir = require("path").resolve(value);
      else {
        options.recheckDelayMs = Number(value) * 1000;
        if (!(options.recheckDelayMs >= 0)) usage("--recheck takes a number of seconds");
      }
    } else usage("Unknown argument " + arg);
  }

  if (!options.blog) usage("--blog is required");
  return options;
}

async function main() {
  const options = parse(process.argv.slice(2));

  if (!(config.storage && config.storage.bucket)) {
    console.error("No storage bucket is configured (BLOT_STORAGE_BUCKET).");
    process.exit(1);
  }

  // A cache directory of this process's own (see backfill-store.js)
  config.container = "verify-store";

  // The log lines go to stderr, so stdout is the JSON alone
  const print = console.log;
  console.log = console.error;

  const maintenance = require("clients/git/shadow/maintenance");
  const { blog, ...rest } = options;
  const result = await maintenance.verify(blog, rest);

  print(JSON.stringify(result, null, 2));

  const path = require("path");
  await require("fs-extra").remove(path.join(config.git_store.cache_directory, config.container)).catch(() => {});

  return result.skipped || result.findings.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);

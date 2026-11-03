// Copies existing git blogs' repositories (data/git/<handle>.git) into the git
// store in the storage bucket (git/<blogID>/), for shadow mode (#2259): blogs
// pushed to before shadow mode was on for them. See
// app/clients/git/shadow/backfill.js.
//
// For each blog on the git client: an empty store is imported, and one with
// history is brought up to date, as a push would. A blog already in sync costs
// one manifest read, so it can be run again, or stopped and run again, at any
// time. It never writes to the repositories on disk. A blog which ends in
// op=push outcome=mismatch, or op=import outcome=raced, met a push at the
// same moment: run it again for that blog.
//
// Only the blogs in BLOT_GIT_STORE_SHADOW (all of them if it is "all"), unless
// --all is passed: a copy of a blog shadow mode is off for would go stale.
//
// Usage, on the production host. As uid 1000, which owns the repositories
// (git refuses to read a repository owned by another user, and root fails its
// ownership check):
//
//   docker exec -u 1000 blot-blue node scripts/git/backfill-store.js [options]
//
//   --dry-run          print what would happen to each blog; write nothing
//   --blog <blogID>    only this blog
//   --all              every git blog, not just the shadowed ones
//   --concurrency <n>  blogs at once (default 1: large repositories one at a
//                      time)
//   --scratch <dir>    where an import builds its packs (default the directory
//                      holding the shadow cache, tmp on the instance store)
//   --reset            with --blog: delete the blog's store copy first and
//                      import it again, to repair a copy the verifier found
//                      damaged (scripts/git/verify-store.js). The app's
//                      processes keep the manifest they last read for up to
//                      12 hours, and a mirror there could build on the deleted
//                      copy's: run it just before a deploy (which restarts
//                      them), and verify the blog afterwards.
//
// It prints one line per blog, in shadow mode's log format (op=import or
// op=push, reason=backfill, with storeMs and bytesUp), and a summary line
// (op=backfill). Exits 0 when every blog ended in a good outcome, 1 if any
// did not, 2 for bad arguments.
const config = require("config");

function usage(message) {
  if (message) console.error(message + "\n");
  console.error("Usage: node scripts/git/backfill-store.js [--dry-run] [--blog <blogID>] [--all] [--concurrency <n>] [--scratch <dir>] [--reset]");
  process.exit(2);
}

function parse(argv) {
  const options = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--reset") options.resetFirst = true;
    else if (arg === "--blog" || arg === "--concurrency" || arg === "--scratch") {
      const value = argv[++i];
      if (!value) usage(arg + " needs a value");
      if (arg === "--concurrency") {
        options.concurrency = parseInt(value, 10);
        if (!(options.concurrency >= 1)) usage("--concurrency must be 1 or more");
      } else if (arg === "--scratch") options.scratchDir = require("path").resolve(value);
      else options.blog = value;
    } else usage("Unknown argument " + arg);
  }

  if (options.resetFirst && !options.blog) usage("--reset needs --blog");
  if (options.resetFirst && options.dryRun) usage("--reset and --dry-run don't go together");

  return options;
}

// What counts as done: imported, pushed, already the same, or nothing to copy
const GOOD = new Set(["import:imported", "import:empty", "import:would-import", "push:ok", "push:same", "push:would-push"]);

async function main() {
  const options = parse(process.argv.slice(2));

  if (!(config.storage && config.storage.bucket)) {
    console.error("No storage bucket is configured (BLOT_STORAGE_BUCKET): nothing to copy into.");
    process.exit(1);
  }

  // A cache directory of this process's own: in a unit's container the app's
  // process has the label this one would otherwise get, a second backfill
  // may run at the same time, and a cache must own its directory (see
  // sharedCache in app/clients/git/shadow/index.js)
  config.container = "backfill-store-" + process.pid;

  const backfill = require("clients/git/shadow/backfill");
  const summary = await backfill(options);

  if (!summary.blogs) {
    console.error(options.blog ? "That blog is not on the git client, or not shadowed (pass --all)." : "No blogs to backfill.");
  }

  const bad = Object.keys(summary.outcomes).filter((key) => !GOOD.has(key));
  if (bad.length) console.error("Run these blogs again, or look at their lines:", bad.map((key) => key + " x" + summary.outcomes[key]).join(", "));

  await removeCache();
  return bad.length ? 1 : 0;
}

// The cache is only for this run
async function removeCache() {
  const path = require("path");
  const dir = path.join(config.git_store.cache_directory, config.container);
  await require("fs-extra").remove(dir).catch(() => {});
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);

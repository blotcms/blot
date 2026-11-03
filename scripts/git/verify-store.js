// Checks one git blog's copy in the git store (<blogID>/git/ in the storage
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
// Several blogs, one after another in one process (one Redis connection, not
// one per blog as a loop of docker exec would open):
//
//   --all                  every blog on the git client which shadow mode
//                          covers (gitBlogs() in shadow/maintenance.js)
//   --blogs <id,id,...>    these blogs
//   --deep                 deep-check all of them
//   --deep-sample <n>      deep-check n of them, chosen at random, and the
//                          rest cheaply
//   --concurrency <n>      how many cheap checks run at once (default 1).
//                          Deep checks are each a whole clone and run one at a
//                          time, after the cheap ones.
//
// stdout is then one JSON result per blog, as each finishes (newline-
// delimited), and a last line, the summary: { summary: true, blogs, outcomes:
// { ok, findings, skipped }, withFindings: [{ blog, findings }] }. Skipped is a
// blog which is gone, off git or has no repository. The exit status is 1 if
// any blog had a finding. With --blog alone, as before, stdout is the one
// result, indented.
//
// Usage, on the production host, as uid 1000, which owns the repositories
// (git refuses a repository owned by another user):
//
//   docker exec -u 1000 blot-blue node scripts/git/verify-store.js --blog <blogID> [--deep]
//   docker exec -u 1000 blot-blue node scripts/git/verify-store.js --all [--deep-sample 5]
//
// Exits 0 if the blog (or every blog) checked out, 1 if anything was found
// (with --blog, also if it was skipped), 2 for bad arguments.
const config = require("config");

function usage(message) {
  if (message) console.error(message + "\n");
  console.error(
    "Usage: node scripts/git/verify-store.js (--blog <blogID> | --blogs <id,id,...> | --all)\n" +
      "         [--deep | --deep-sample <n>] [--concurrency <n>] [--recheck <seconds>] [--scratch <dir>]"
  );
  process.exit(2);
}

function count(arg, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) usage(arg + " takes a whole number, 1 or more");
  return n;
}

function parse(argv) {
  const options = { recheckDelayMs: 10 * 1000, concurrency: 1 };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--deep") options.deep = true;
    else if (arg === "--all") options.all = true;
    else if (["--blog", "--blogs", "--recheck", "--scratch", "--deep-sample", "--concurrency"].includes(arg)) {
      const value = argv[++i];
      if (!value) usage(arg + " needs a value");
      if (arg === "--blog") options.blog = value;
      else if (arg === "--blogs") options.blogs = [...new Set(value.split(",").map((id) => id.trim()).filter(Boolean))];
      else if (arg === "--scratch") options.scratchDir = require("path").resolve(value);
      else if (arg === "--deep-sample") options.deepSample = count(arg, value);
      else if (arg === "--concurrency") options.concurrency = count(arg, value);
      else {
        options.recheckDelayMs = Number(value) * 1000;
        if (!(options.recheckDelayMs >= 0)) usage("--recheck takes a number of seconds");
      }
    } else usage("Unknown argument " + arg);
  }

  const chosen = [options.blog, options.blogs, options.all].filter(Boolean).length;
  if (chosen === 0) usage("--blog, --blogs or --all is required");
  if (chosen > 1) usage("Use only one of --blog, --blogs and --all");
  if (options.blogs && !options.blogs.length) usage("--blogs needs at least one blog ID");
  if (options.deep && options.deepSample) usage("Use only one of --deep and --deep-sample");
  if (options.blog && (options.deepSample || options.concurrency > 1)) usage("--deep-sample and --concurrency are for several blogs");

  return options;
}

// Runs fn over items, `limit` at a time
async function each(items, limit, fn) {
  const queue = items.slice();
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

// n of the items, at random
function pick(items, n) {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return new Set(copy.slice(0, n));
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
  const { blog, blogs, all, deepSample, concurrency, ...rest } = options;
  let code;

  if (blog) {
    const result = await maintenance.verify(blog, rest);

    print(JSON.stringify(result, null, 2));
    code = result.skipped || result.findings.length ? 1 : 0;
  } else {
    const ids = blogs || (await maintenance.gitBlogs());
    const deepIds = options.deep ? new Set(ids) : deepSample ? pick(ids, deepSample) : new Set();
    const outcomes = { ok: 0, findings: 0, skipped: 0 };
    const withFindings = [];

    const check = async (id) => {
      let result;

      try {
        result = await maintenance.verify(id, { ...rest, deep: deepIds.has(id) });
      } catch (err) {
        result = { blog: id, deep: false, findings: [{ blog: id, check: "verify", kind: "error", detail: String((err && err.message) || err) }] };
      }

      if (result.skipped) outcomes.skipped++;
      else if (result.findings.length) {
        outcomes.findings++;
        withFindings.push({ blog: id, findings: result.findings });
      } else outcomes.ok++;

      print(JSON.stringify(result));
    };

    // Cheap checks together, then each deep one (a whole clone) alone
    await each(ids.filter((id) => !deepIds.has(id)), concurrency, check);
    await each(ids.filter((id) => deepIds.has(id)), 1, check);

    print(JSON.stringify({ summary: true, blogs: ids.length, deep: deepIds.size, outcomes, withFindings }));
    code = withFindings.length ? 1 : 0;
  }

  const path = require("path");
  await require("fs-extra").remove(path.join(config.git_store.cache_directory, config.container)).catch(() => {});

  return code;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);

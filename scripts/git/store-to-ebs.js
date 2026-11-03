// Brings a blog's repository on disk ("EBS") up to its copy in the git store,
// with the served path's fallback (app/clients/git/served/fallback.js), and
// then checks the two agree with the daily maintenance's cheap check. Run it
// for each blog before switching it off BLOT_GIT_STORE_SERVE (the rollback
// in #2259): once it says ok, switching the blog off loses nothing.
//
// It writes to the repository on disk only (a pack from the store, and the
// refs master and tags), under the blog's ref lock, and never to the store.
// A store with no copy is left alone. The log lines go to stderr; stdout is
// one JSON result: { blog, fallback: { outcome, ... }, findings }.
//
// Usage, on the production host, as uid 1000, which owns the repositories:
//
//   docker exec -u 1000 blot-blue node scripts/git/store-to-ebs.js <blogID>
//
// Exits 0 if the two sides agree afterwards, 1 if not (or the fallback
// failed), 2 for bad arguments.
const config = require("config");

async function main() {
  const blogID = process.argv[2];

  if (!blogID || process.argv.length > 3 || blogID.indexOf("-") === 0) {
    console.error("Usage: node scripts/git/store-to-ebs.js <blogID>");
    return 2;
  }

  // A cache directory of its own, as the other store scripts have
  config.container = "store-to-ebs";

  const print = console.log;
  console.log = console.error;

  const fallback = require("clients/git/served/fallback");
  const maintenance = require("clients/git/shadow/maintenance");

  const result = await fallback.run(blogID, { reason: "script" });
  const checked = await maintenance.verify(blogID, { recheckDelayMs: 1000 });

  print(JSON.stringify({ blog: blogID, fallback: result, skipped: !!checked.skipped, findings: checked.findings }, null, 2));

  const path = require("path");
  await require("fs-extra").remove(path.join(config.git_store.cache_directory, config.container)).catch(() => {});

  const failed = result.outcome === "error" || result.outcome === "moved" || checked.skipped || checked.findings.length;
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);

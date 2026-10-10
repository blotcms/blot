// Copies the generated assets on local disk (data/static/blog_*) into the
// assets bucket, so every file has an object at {blogID}/{path}. Safe to run
// repeatedly: files already in the bucket with the same size, and not changed on disk
// since they were uploaded, are skipped.
//
//   node scripts/storage/backfill-assets.js [options]
//
//   --dry-run          report what would be uploaded
//   --verify           upload nothing; report what's missing, different or stale,
//                      and exit non-zero if anything is
//   --blog <blogID>    only this blog
//   --from <blogID>    start at this blog (inclusive), e.g. to resume
//   --concurrency <n>  uploads at once (default 16)
//
// Both --dry-run and --verify also list keys which may not round-trip
// through a plain CDN to bucket URL. Needs BLOT_ASSETS_BUCKET and
// credentials (see config/assets-bucket/README.md). On the production host:
//
//   docker exec <container> node scripts/storage/backfill-assets.js --dry-run

const config = require("config");
const s3 = require("storage/s3");
const { backfill, summarise, failed } = require("storage/backfill");

function usage(message) {
  if (message) console.error(message + "\n");

  console.error(
    "Usage: node scripts/storage/backfill-assets.js [--dry-run | --verify]" +
      " [--blog <blogID>] [--from <blogID>] [--concurrency <n>]"
  );
  process.exit(2);
}

function parse(argv) {
  const options = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--verify") options.verify = true;
    else if (arg === "--blog" || arg === "--from" || arg === "--concurrency") {
      const value = argv[++i];

      if (!value) usage(arg + " needs a value");

      if (arg === "--concurrency") {
        options.concurrency = parseInt(value, 10);
        if (!(options.concurrency >= 1)) usage("--concurrency must be 1 or more");
      } else {
        options[arg.slice(2)] = value;
      }
    } else {
      usage("Unknown argument " + arg);
    }
  }

  if (options.dryRun && options.verify) usage("Use --dry-run or --verify, not both");

  return options;
}

async function main() {
  const options = parse(process.argv.slice(2));

  if (!s3.enabled()) {
    console.error("BLOT_ASSETS_BUCKET is not set, so there is no bucket to copy to.");
    return 2;
  }

  console.log(
    "[backfill] bucket " + config.assets.bucket + " in " + config.assets.region +
      (config.assets.endpoint ? " at " + config.assets.endpoint : "") +
      ", from " + config.blog_static_files_dir
  );

  const stats = await backfill(options);

  console.log(summarise(stats, options));

  return failed(stats, options) ? 1 : 0;
}

main().then(
  function (code) {
    s3.reset();
    process.exitCode = code;
  },
  function (err) {
    console.error(err);
    s3.reset();
    process.exitCode = 1;
  }
);

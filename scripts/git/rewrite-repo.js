// Rewrites one repository of the git store (app/clients/git/store) so that it
// holds only the objects its current refs reach, for when a user has scrubbed
// something from their history (a leaked secret, a file they must remove) and
// force pushed. The refs, HEAD and tags stay as they are; every pack is
// replaced by one pack of what they reach and a history pack, and the
// manifest gets a new epoch, so no host's cache serves an object from before.
// See "Rewriting a repository" in the store's README.
//
// By default the old packs are left for the sweep, which deletes them once
// the old manifests have left its recovery window (a week). With --purge they
// are deleted now: every pack the new manifest does not name, and the sweep's
// record. The old manifests stay either way (they hold no content) and age out
// as usual. A clone or fetch streaming an old pack at that moment fails and
// has to be run again.
//
// This is not wired into the app, and the target is always explicit: there is
// no default bucket.
//
// Usage:
//   node scripts/git/rewrite-repo.js --dir <folder> [options]
//   node scripts/git/rewrite-repo.js --bucket <name> --prefix <blog_x/git/> [options]
//
// Target (one of):
//   --dir <folder>     a local directory used as the object store
//   --bucket <name>    an S3 bucket (with --prefix, the keys' prefix); the AWS SDK
//                      finds credentials as usual, and for MinIO use --endpoint
//                      with BLOT_AWS_KEY and BLOT_AWS_SECRET (or AWS_ACCESS_KEY_ID
//                      and AWS_SECRET_ACCESS_KEY)
//   --prefix <prefix>  the prefix inside the bucket (default none)
//   --endpoint <url>   an S3-compatible endpoint (MinIO); uses path-style URLs
//   --region <region>  the bucket's region (default us-east-1)
//
// Options:
//   --purge            delete the old data now, rather than leave it to the sweep
//   --dry-run          build and prove the new pack in scratch and report what
//                      would be dropped (with --purge, what would be deleted);
//                      writes nothing to the store
//   --scratch <dir>    work in this directory instead of a reservation from a
//                      cache, for a repository bigger than --cache-mb
//   --cache-mb <n>     the size of the cache the scratch space is reserved from
//                      (default 1024); the cache lives in a temporary directory
//
// Prints the result as JSON. Exits 0 for a rewrite, a dry run or an empty
// repository, 1 for a failure, 2 if the swap's outcome could not be confirmed
// (run it again), and 3 if a purge left the newest manifest naming a missing
// pack ("damaged" in rewrite.js; push again from a clone).

const fs = require("fs");
const os = require("os");
const path = require("path");

const store = require("../../app/clients/git/store");
const rewriteRepo = require("../../app/clients/git/store/rewrite");
const { parse, objectStore } = require("./target");

async function main() {
  const { options, positional } = parse(process.argv.slice(2), { flags: ["purge", "dry-run"], values: ["scratch", "cache-mb"] });
  if (positional.length) {
    throw new Error("Usage: node scripts/git/rewrite-repo.js (--dir <folder> | --bucket <name> [--prefix <p>]) [--purge] [--dry-run] [--scratch <dir>] [--cache-mb <n>]");
  }

  const target = objectStore(options);
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-rewrite-cache-"));
  const cache = store.createCache({ dir: cacheDir, maxBytes: Number(options["cache-mb"] || 1024) * 1024 * 1024 });
  const lock = (fn) => fn();
  const scratchDir = options.scratch ? path.resolve(options.scratch) : null;

  let result;
  try {
    result = await rewriteRepo({ store: target.store, cache, lock, scratchDir, purge: !!options.purge, dryRun: !!options["dry-run"] });
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    if (target.client) target.client.destroy();
  }

  const { error, ...printable } = result;
  if (error) printable.error = error.message;
  console.log(JSON.stringify(printable, null, 2));
  if (result.outcome === "damaged") {
    console.error(
      "DAMAGED: the repository was rewritten, but after the purge the newest manifest names packs that are missing: " +
        result.purged.missing.join(", ") +
        ". A push re-uploaded one while it was being deleted. Push again from a clone to repair it."
    );
    process.exit(3);
  }
  process.exit(result.outcome === "unknown" ? 2 : 0);
}

main().catch((err) => {
  console.error((err.code ? err.code + ": " : "") + err.message);
  process.exit(1);
});

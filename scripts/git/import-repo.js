// Imports an existing git repository (a bare repository, say
// data/git/<handle>.git) into an empty repository of the git store
// (app/clients/git/store): one pack of everything reachable from its branches
// and tags, a history pack, and the first manifest. It never writes to the
// source, and refuses to import into a store repository which already has a
// manifest. Refs other than branches and tags, and objects nothing reaches,
// are left behind (see "Importing an existing repository" in the store's README).
//
// This is not wired into the app, and the target is always explicit: there is
// no default bucket. It is for trying the import out locally and, later, for
// the rewrite.
//
// Usage:
//   node scripts/git/import-repo.js <git-dir> --dir <folder> [options]
//   node scripts/git/import-repo.js <git-dir> --bucket <name> --prefix <blog_x/git/> [options]
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
//   --scratch <dir>    build the packs in this directory instead of a reservation
//                      from a cache, for a repository bigger than --cache-mb
//   --cache-mb <n>     the size of the cache the scratch space is reserved from
//                      (default 1024); the cache lives in a temporary directory
//   --verify           afterwards clone the store repository through the store's
//                      own clone code, run git fsck --strict on it and compare
//                      every branch, tag and HEAD with the source's
//
// Prints the result as JSON. Exits 0 for an import (or an empty repository), 1
// for a failure and 2 if the swap's outcome could not be confirmed.

const fs = require("fs");
const os = require("os");
const path = require("path");

const store = require("../../app/clients/git/store");
const importRepo = require("../../app/clients/git/store/import");
const { parse, objectStore } = require("./target");

async function main() {
  const { options, positional } = parse(process.argv.slice(2), { flags: ["verify"], values: ["scratch", "cache-mb"] });
  if (positional.length !== 1) throw new Error("Usage: node scripts/git/import-repo.js <git-dir> (--dir <folder> | --bucket <name> [--prefix <p>]) [--scratch <dir>] [--cache-mb <n>] [--verify]");

  const gitDir = path.resolve(positional[0]);
  if (!fs.existsSync(gitDir)) throw new Error("No such directory: " + gitDir);

  const target = objectStore(options);
  const objects = target.store;
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-import-cache-"));
  const cache = store.createCache({ dir: cacheDir, maxBytes: Number(options["cache-mb"] || 1024) * 1024 * 1024 });
  const lock = (fn) => fn();
  const scratchDir = options.scratch ? path.resolve(options.scratch) : null;

  let result;
  try {
    result = await importRepo({ store: objects, cache, lock, gitDir, scratchDir });

    if (options.verify && result.outcome === "imported") {
      result.verified = await importRepo.verifyImport({ store: objects, cache, gitDir, scratchDir });
    }
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    if (target.client) target.client.destroy();
  }

  const { error, ...printable } = result;
  if (error) printable.error = error.message;
  console.log(JSON.stringify(printable, null, 2));
  process.exit(result.outcome === "unknown" ? 2 : 0);
}

main().catch((err) => {
  console.error((err.code ? err.code + ": " : "") + err.message);
  process.exit(1);
});

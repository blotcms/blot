// Removes from Bunny's Perma-Cache what Blot no longer publishes or now
// publishes different bytes at: deleted blogs, old versions of edited or
// deleted folder files, generated files gone from the bucket or rewritten
// since, old documentation versions, template outputs gone from Redis,
// changed static files, and anything else at the top level
// (app/storage/sweep/permaCache.js). The scheduler runs the same sweep in the
// background, resuming across deploys; this runs it by hand, in one go.
//
// Report only unless --apply. Run in a unit, as the app user:
//
//   docker exec -u 1000 blot-blue node scripts/storage/perma-cache-sweep.js
//   docker exec -u 1000 blot-blue node scripts/storage/perma-cache-sweep.js --apply
//   docker exec -u 1000 blot-blue node scripts/storage/perma-cache-sweep.js --only <blogID or directory> --apply
//
// --only sweeps one top-level directory: a blog's ID, or documentation,
// template, fonts, ... --allow-many-deleted lets it go on when more than 50
// blogs in Perma-Cache look deleted (check a few by hand first).
//
// Safe to re-run: each run lists what is there now.

const permaCache = require("storage/sweep/permaCache");

function option(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

async function main() {
  const totals = await permaCache.sweep({
    apply: process.argv.includes("--apply"),
    only: option("--only"),
    allowManyDeleted: process.argv.includes("--allow-many-deleted"),
  });

  console.log(JSON.stringify(totals));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

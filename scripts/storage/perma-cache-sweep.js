// Removes from Bunny's Perma-Cache what Blot no longer publishes: deleted
// blogs' files, old versions of edited or deleted folder files, generated
// files gone from the bucket (app/cdn/permaCache.js). The scheduler runs the
// same sweep weekly; this runs it by hand, and does the one-off cleanup of
// URLs in the form used before #2695.
//
// Report only unless --apply. Run in a unit, as the app user:
//
//   docker exec -u 1000 blot-blue node scripts/storage/perma-cache-sweep.js
//   docker exec -u 1000 blot-blue node scripts/storage/perma-cache-sweep.js --apply
//   docker exec -u 1000 blot-blue node scripts/storage/perma-cache-sweep.js --blog <blogID> --apply
//   docker exec -u 1000 blot-blue node scripts/storage/perma-cache-sweep.js --wipe-old-folder-form --apply
//
// --wipe-old-folder-form deletes the top-level folder/ directory of
// Perma-Cache outright: every /folder/v-<version>/blog_<id>/... URL, grouped
// by version rather than by blog, so the sweep can't tell which are stale.
// Those URLs are still linked from posts not yet rebuilt and from feeds, and
// refill from the app on demand. The edge keeps its own copies until they
// expire or are purged.
//
// Safe to re-run: each run lists what is there now.

const permaCache = require("cdn/permaCache");
const bunnyStorage = require("helper/bunnyStorage");

function option(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

async function main() {
  const apply = process.argv.includes("--apply");

  if (process.argv.includes("--wipe-old-folder-form")) {
    const base = await permaCache.root();
    const top = await bunnyStorage.list(base);
    const found = top.some((e) => e.isDirectory && e.name === "folder");

    console.log(
      `${base}folder/ ${found ? "exists" : "is already gone"}` +
        (found && !apply ? " (report only: pass --apply to delete it)" : "")
    );

    if (found && apply) {
      await permaCache.removeTopLevel("folder");
      console.log("Deleted " + base + "folder/");
    }

    return;
  }

  const totals = await permaCache.sweep({
    apply,
    blogID: option("--blog"),
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

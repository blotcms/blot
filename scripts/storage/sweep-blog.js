// Runs the weekly sweep's step for generated files (app/storage/sweep/
// generated.js, #2745) for one blog, or for every blog with --all, and prints
// its totals: the directories it would mark as candidates, delete, and the
// transformer cache keys it would delete. Report only (it reads everything
// and writes nothing) unless --apply.
//
//   docker exec -u 1000 blot-blue node scripts/storage/sweep-blog.js <blogID>
//   docker exec -u 1000 blot-blue node scripts/storage/sweep-blog.js <blogID> --apply
//   docker exec -u 1000 blot-blue node scripts/storage/sweep-blog.js <blogID> --apply --both-phases
//   docker exec -u 1000 blot-blue node scripts/storage/sweep-blog.js --all
//
// --apply is the first phase of the two-phase deletion: it deletes the cache
// entries that point at unreferenced directories and records the directories
// as candidates; the second pass of the weekly run, six hours later, deletes their files.
// --both-phases runs the second phase straight after the first, with no six hours
// between them: for checking on a quiet test blog (dbtest, gittest,
// drivetest, icloudtest) that rebuilds bring its images, thumbnails and
// screenshots back. A build running at the time could link a directory it
// deletes, so don't use it on a blog people are writing to. The one-day check
// on a directory's newest file still applies.
//
// This does not touch Perma-Cache (Bunny): that part of the weekly run
// purges what the deleted files leave behind.

const Blog = require("models/blog");
const generated = require("storage/sweep/generated");

const blogID = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const all = process.argv.includes("--all");
const apply = process.argv.includes("--apply");
const bothPhases = process.argv.includes("--both-phases");

function newTotals() {
  return {
    generatedBlogs: 0,
    candidates: 0,
    candidateBytes: 0,
    deletedDirs: 0,
    deletedBytes: 0,
    cacheKeysDeleted: 0,
    legacyCacheKeys: 0,
    missingDirs: 0,
    rebuildsQueued: 0,
  };
}

async function main() {
  if (!blogID && !all) {
    console.error(
      "Usage: sweep-blog.js <blogID> | --all [--apply [--both-phases]]"
    );
    process.exit(1);
  }

  if (all && apply) {
    console.error("--all is report only: use the weekly run to apply");
    process.exit(1);
  }

  const ids = all ? (await Blog.getAllIDs()).sort() : [blogID];
  const phases = apply && bothPhases ? 2 : 1;
  const totals = newTotals();

  for (const id of ids) {
    try {
      for (let phase = 1; phase <= phases; phase++) {
        const phaseTotals = newTotals();

        await generated.run(id, {
          mode: apply ? "apply" : "report",
          totals: phaseTotals,
          log: (line) => console.log(line),
        });

        if (!all)
          console.log(
            `${id}${phases > 1 ? " phase " + phase : ""}:`,
            JSON.stringify(phaseTotals)
          );

        for (const key of Object.keys(totals)) totals[key] += phaseTotals[key];
      }
    } catch (err) {
      console.error(id, "failed:", err.message);
    }
  }

  if (all) console.log("Totals:", JSON.stringify(totals));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

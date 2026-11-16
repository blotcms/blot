// Report-only run of the sweep of generated files nothing uses any more
// (app/storage/sweep/s3.js and references.js, #2688 section 7): per blog and in total,
// the bytes stored in each generated scope, how many are referenced by the
// blog's entries, templates and settings, and how many are unreferenced and
// older than the grace period (what a deleting sweep would remove). Reads
// Redis and lists the bucket; deletes nothing.
//
// Run in a unit, as the app user:
//
//   docker exec -u 1000 blot-blue node scripts/storage/sweep-generated-report.js
//   docker exec -u 1000 blot-blue node scripts/storage/sweep-generated-report.js --blog <blogID> --list
//   docker exec -u 1000 blot-blue node scripts/storage/sweep-generated-report.js --grace-days 30 --from <blogID>
//
// --list prints the unreferenced directories of each blog. --from starts at a
// blog ID (in sorted order), to resume a stopped run.

const Blog = require("models/blog");
const { SCOPES } = require("storage/sweep/references");
const { report } = require("storage/sweep/s3");

function option(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

const MB = 1024 * 1024;
const mb = (bytes) => (bytes / MB).toFixed(1) + " MB";

async function main() {
  const graceDays = Number(option("--grace-days")) || 60;
  const list = process.argv.includes("--list");
  const from = option("--from");
  let blogIDs = option("--blog")
    ? [option("--blog")]
    : (await Blog.getAllIDs()).sort();

  if (from) blogIDs = blogIDs.filter((id) => id >= from);

  const grand = {};
  for (const scope of SCOPES)
    grand[scope] = { stored: 0, referenced: 0, unreferenced: 0, oldEnough: 0 };

  for (const blogID of blogIDs) {
    let result;

    try {
      result = await report(blogID, { graceDays, listUnreferenced: list });
    } catch (err) {
      console.error(blogID, "failed:", err.message);
      continue;
    }

    const line = SCOPES.map((scope) => {
      const t = result.totals[scope];
      for (const k of Object.keys(t)) grand[scope][k] += t[k];
      return t.stored
        ? `${scope} ${mb(t.stored)} stored, ${mb(t.unreferenced)} unreferenced, ${mb(t.oldEnough)} past grace`
        : null;
    })
      .filter(Boolean)
      .join("; ");

    if (line) console.log(blogID, line);
    if (list) for (const name of result.unreferenced) console.log("  ", name);
  }

  console.log(`\nTotals (grace ${graceDays} days):`);
  for (const scope of SCOPES) {
    const t = grand[scope];
    const share = t.stored ? ((100 * t.oldEnough) / t.stored).toFixed(1) : "0";
    console.log(
      `${scope}: ${mb(t.stored)} stored, ${mb(t.referenced)} referenced, ` +
        `${mb(t.unreferenced)} unreferenced, ${mb(t.oldEnough)} past grace (${share}% of stored)`
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

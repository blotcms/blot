// Turns on "Include site on discover page" for the featured sites (#2639).
// New sites have it on by default; existing sites are off, except the ones
// in app/documentation/featured/sites.txt, which this script turns on.
//
//   node scripts/discover/include-featured.js [--apply]
//
// Without --apply it only reports what it would change. Safe to rerun: a
// site already included is left as it is, so after an interruption run it
// again. A host which doesn't match a blog is listed and skipped.

const fs = require("fs-extra");
const { join } = require("path");
const Blog = require("models/blog");
const blogForHost = require("documentation/featured/blogForHost");

const SITES = join(__dirname, "../../app/documentation/featured/sites.txt");

async function hosts() {
  const text = await fs.readFile(SITES, "utf-8");

  return text
    .split("\n")
    .map((line) => line.trim().split(" ")[0])
    .filter(Boolean);
}

async function main(apply) {
  const totals = { included: 0, already: 0, unmatched: 0 };

  for (const host of await hosts()) {
    const blog = await blogForHost(host);

    if (!blog) {
      totals.unmatched++;
      console.log("No blog for", host);
      continue;
    }

    if (blog.includeInDiscover === true) {
      totals.already++;
      continue;
    }

    totals.included++;
    console.log((apply ? "Including " : "Would include ") + host, blog.id);

    if (apply) await Blog.set(blog.id, { includeInDiscover: true });
  }

  console.log(totals, apply ? "" : "(dry run: pass --apply to change them)");
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "--apply");

  if (unknown.length) {
    console.error("Usage: node scripts/discover/include-featured.js [--apply]");
    process.exit(2);
  }

  main(args.includes("--apply"))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = main;

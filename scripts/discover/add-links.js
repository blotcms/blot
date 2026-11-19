// Prints "Add to Discover" links for a site's newest posts, like the ones in
// the maintainer's daily email but for posts of any age (#2639). Locally,
// after scripts/discover/mirror-featured.js, this is how posts get added.
//
//   node scripts/discover/add-links.js <blogID|handle|host> [--limit <n>]
//
// Each link is a one-time token which lasts a day. Posts already on Discover,
// and sites with "Include site on discover page" off, get no link.

const config = require("config");
const Blog = require("models/blog");
const Entries = require("models/entries");
const Discover = require("models/discover");
const blogForHost = require("documentation/featured/blogForHost");

function usage(message) {
  if (message) console.error(message + "\n");
  console.error(
    "Usage: node scripts/discover/add-links.js <blogID|handle|host> [--limit <n>]"
  );
  process.exit(2);
}

function parse(argv) {
  const options = { site: null, limit: 10 };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--limit" && argv[i + 1]) {
      options.limit = parseInt(argv[++i], 10);
      if (!(options.limit > 0)) usage("--limit must be a positive number");
    } else if (!argv[i].startsWith("--") && !options.site) {
      options.site = argv[i];
    } else {
      usage("Unknown argument: " + argv[i]);
    }
  }

  if (!options.site) usage();

  return options;
}

async function find(site) {
  if (site.startsWith("blog_")) return Blog.get({ id: site });
  if (site.includes(".")) return blogForHost(site);
  return Blog.get({ handle: site });
}

// Resolves to [{ title, link }] for the blog's newest published posts
async function links(blog, limit) {
  if (blog.includeInDiscover !== true) return [];

  const { entries } = await Entries.getPage(blog.id, {
    pageNumber: 1,
    pageSize: limit,
  });

  const result = [];

  for (const entry of entries || []) {
    if (!entry || entry.deleted || entry.draft || entry.scheduled) continue;
    if (await Discover.has(blog.id, entry.id)) continue;

    const token = await Discover.token.create(blog.id, entry.id);
    result.push({
      title: entry.title,
      link: "https://" + config.host + "/sites/discover/add/" + token,
    });
  }

  return result;
}

async function main(argv) {
  const options = parse(argv);
  const blog = await find(options.site);

  if (!blog) throw new Error("No site for " + options.site);

  if (blog.includeInDiscover !== true)
    console.error(blog.id, "has Discover turned off, so there are no links");

  for (const { title, link } of await links(blog, options.limit))
    console.log(title + "\n  " + link);
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err.message || err);
      process.exit(1);
    });
}

module.exports = { links };

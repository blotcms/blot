const Blog = require("models/blog");
const Entries = require("models/entries");
const Discover = require("models/discover");
const config = require("config");

const DISCOVER = "https://" + config.host + "/sites/discover";

// A one-time "Add to Discover" link for a post from a site that allows it,
// unless the post is already on Discover. These links are only in the
// maintainer's daily email.
async function discoverLink(blog, entry) {
  if (blog.includeInDiscover !== true) return "";
  if (await Discover.has(blog.id, entry.id)) return "";
  const token = await Discover.token.create(blog.id, entry.id);
  return DISCOVER + "/add/" + token;
}

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

async function main() {
  const blogIDs = await Blog.getAllIDs();
  const blogs_with_new_posts = [];

  for (const blogID of blogIDs) {
    try {
      const blog = await Blog.get({ id: blogID });
      if (!blog || blog.isDisabled) continue;

      const extendedBlog = Blog.extend(blog);
      // Limiting to the newest 10 entries per blog is fine for this report.
      const { entries } = await Entries.getPage(blogID, {
        pageNumber: 1,
        pageSize: 10,
      });

      if (!entries || !entries.length) continue;

      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const new_posts = [];

      for (const entry of entries) {
        if (!entry || !entry.dateStamp) continue;
        if (entry.deleted || entry.draft || entry.scheduled) continue;
        if (entry.dateStamp <= cutoff) continue;

        new_posts.push({
          title: entry.title,
          link: extendedBlog.url + entry.url,
          discover: await discoverLink(blog, entry),
        });
      }

      if (!new_posts.length) continue;

      blogs_with_new_posts.push({
        label: extendedBlog.pretty.label,
        url: extendedBlog.url,
        new_posts,
      });
    } catch (err) {
      continue;
    }
  }

  shuffle(blogs_with_new_posts);
  return { blogs_with_new_posts, discover_manage: DISCOVER };
}

module.exports = main;
if (require.main === module) require("./cli")(main);

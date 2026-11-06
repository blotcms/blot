const { promisify } = require("util");
const Blog = require("models/blog");
const Entries = require("models/entries");

const getAllBlogIDs = promisify(Blog.getAllIDs);
const getBlog = promisify(Blog.get);

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

async function main(callback) {
  try {
    const blogIDs = await getAllBlogIDs();
    const blogs_with_new_posts = [];

    for (const blogID of blogIDs) {
      try {
        const blog = await getBlog({ id: blogID });
        if (!blog || blog.isDisabled) continue;

        const extendedBlog = Blog.extend(blog);
        // Limiting to the newest 10 entries per blog is fine for this report.
        const { entries } = await Entries.getPage(blogID, {
          pageNumber: 1,
          pageSize: 10,
        });

        if (!entries || !entries.length) continue;

        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        const new_posts = entries
          .filter(function (entry) {
            if (!entry || !entry.dateStamp) return false;
            if (entry.deleted || entry.draft || entry.scheduled) return false;
            return entry.dateStamp > cutoff;
          })
          .map(function (entry) {
            return {
              title: entry.title,
              link: extendedBlog.url + entry.url,
            };
          });

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
    callback(null, { blogs_with_new_posts });
  } catch (err) {
    callback(err);
  }
}

module.exports = main;
if (require.main === module) require("./cli")(main);

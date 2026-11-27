// Lists and edits the posts on Discover (#2639), usually run by an agent for
// the maintainer. Posts are added with add.js, and a site's name, bio and
// avatar are set with profile.js.
//
//   node scripts/discover/manage.js list [--all]
//   node scripts/discover/manage.js remove <post URL or ID> [...]
//   node scripts/discover/manage.js text <post URL or ID> on|off
//   node scripts/discover/manage.js set-text <post URL or ID> "<text>"
//   node scripts/discover/manage.js remove-site <host, handle or blog ID>
//
// list prints the posts newest first, with their IDs; --all includes the
// ones hidden while their site is excluded or the post isn't published.

const Blog = require("models/blog");
const Entry = require("models/entry");
const Discover = require("models/discover");
const blogForHost = require("documentation/featured/blogForHost");

function usage(message) {
  if (message) console.error(message + "\n");
  console.error(
    "Usage: node scripts/discover/manage.js list [--all]\n" +
      "       node scripts/discover/manage.js remove <post URL or ID> [...]\n" +
      "       node scripts/discover/manage.js text <post URL or ID> on|off\n" +
      '       node scripts/discover/manage.js set-text <post URL or ID> "<text>"\n' +
      "       node scripts/discover/manage.js remove-site <host, handle or blog ID>"
  );
  process.exit(2);
}

async function findBlog(site) {
  if (site.startsWith("blog_")) return Blog.get({ id: site });
  if (site.includes(".")) return blogForHost(site.replace(/^https?:\/\//, ""));
  return Blog.get({ handle: site });
}

// Resolves to the ID of the post on Discover for a URL or an ID
async function postID(ref) {
  if (/^[a-f0-9]{20}$/.test(ref)) return ref;

  let url;

  try {
    url = new URL(ref);
  } catch (err) {
    throw new Error("Not a post URL or ID: " + ref, { cause: err });
  }

  const blog = await blogForHost(url.host);
  if (!blog) throw new Error("No site for " + url.host);

  const entry = await Entry.getByUrl(
    blog.id,
    decodeURI(url.pathname).toLowerCase()
  );
  if (!entry) throw new Error("No post at " + ref);

  return Discover.postID(blog.id, entry.id);
}

async function list(all) {
  let before;

  do {
    const page = await Discover.list({ all, before, limit: 100 });

    for (const post of page.posts)
      console.log(
        [
          post.id,
          post.date,
          post.site.address,
          post.title,
          post.photos.length + " photos",
          post.showText ? "text" : "",
          post.hidden ? "hidden" : "",
        ]
          .filter(Boolean)
          .join("  ")
      );

    before = page.next;
  } while (before);
}

async function main(argv) {
  const [command, ...args] = argv;

  if (command === "list") return list(args.includes("--all"));

  if (command === "remove") {
    if (!args.length) usage();
    for (const ref of args) {
      const id = await postID(ref);
      if (!(await Discover.get(id))) throw new Error("Not on Discover: " + ref);
      await Discover.remove(id);
      console.log("Removed", id);
    }
    return;
  }

  if (command === "text") {
    if (args.length !== 2 || !["on", "off"].includes(args[1])) usage();
    const id = await postID(args[0]);
    if (!(await Discover.get(id)))
      throw new Error("Not on Discover: " + args[0]);
    await Discover.setShowText(id, args[1] === "on");
    console.log("Text", args[1], "for", id);
    return;
  }

  // The card's own text in place of the post's; "" goes back to the post's
  if (command === "set-text") {
    if (args.length !== 2) usage();
    const id = await postID(args[0]);
    if (!(await Discover.get(id)))
      throw new Error("Not on Discover: " + args[0]);
    const post = await Discover.setText(id, args[1]);
    console.log(post.text ? "Text set for" : "Text cleared for", id);
    return;
  }

  if (command === "remove-site") {
    if (args.length !== 1) usage();
    const blog = await findBlog(args[0]);
    if (!blog) throw new Error("No site for " + args[0]);
    await Discover.removeBlog(blog.id);
    console.log("Removed the posts and profile of", blog.id);
    return;
  }

  usage(command ? "Unknown command: " + command : "");
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err.message || err);
      process.exit(1);
    });
}

module.exports = { main };

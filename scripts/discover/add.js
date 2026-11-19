// Puts posts on Discover by their URLs (#2639), each with up to 3 of its
// photos by default: the maintainer's manual opt-in, usually run by an agent.
//
//   node scripts/discover/add.js <post URL> [<post URL> ...] [--photos <n>]
//     [--pick <1,3,...>] [--list-photos] [--text|--no-text]
//
// Each site is found by its host and each post by its URL, and the site's
// "Include site on discover page" setting is turned on. --text shows the
// post's text above its photos, clipped with "See more". --photos 0 makes a
// text-only card. --list-photos prints a post's images, numbered, and adds
// nothing; --pick then chooses which of them to show, in that order (at most
// 4), in place of the first ones. Safe to rerun: adding a post already on
// Discover replaces its photos and keeps its place. Nothing is fetched: the
// site and the post must be on Blot.

const Blog = require("models/blog");
const Entry = require("models/entry");
const Discover = require("models/discover");
const assets = require("storage/assets");
const blogForHost = require("documentation/featured/blogForHost");

function usage(message) {
  if (message) console.error(message + "\n");
  console.error(
    "Usage: node scripts/discover/add.js <post URL> [<post URL> ...] [--photos <n>] [--pick <1,3,...>] [--list-photos] [--text|--no-text]"
  );
  process.exit(2);
}

function parse(argv) {
  const options = { urls: [], photos: 3, text: undefined };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--photos" && argv[i + 1] !== undefined) {
      options.photos = parseInt(argv[++i], 10);
      if (!(options.photos >= 0)) usage("--photos must be 0 or more");
    } else if (argv[i] === "--pick" && argv[i + 1] !== undefined) {
      options.pick = argv[++i].split(",").map((n) => parseInt(n, 10));
      if (
        !options.pick.every((n) => n > 0) ||
        new Set(options.pick).size !== options.pick.length ||
        options.pick.length > Discover.photos.MAX_PHOTOS
      )
        usage(
          "--pick takes up to " +
            Discover.photos.MAX_PHOTOS +
            " different numbers from --list-photos"
        );
    } else if (argv[i] === "--list-photos") {
      options.listPhotos = true;
    } else if (argv[i] === "--text") {
      options.text = true;
    } else if (argv[i] === "--no-text") {
      options.text = false;
    } else if (!argv[i].startsWith("--")) {
      try {
        options.urls.push(new URL(argv[i]));
      } catch (err) {
        usage("Not a URL: " + argv[i]);
      }
    } else {
      usage("Unknown argument: " + argv[i]);
    }
  }

  if (!options.urls.length) usage();

  return options;
}

async function find(url, host) {
  const blog = await blogForHost(host);
  const found = blog
    ? await Entry.getByUrl(blog.id, decodeURI(url.pathname).toLowerCase())
    : null;

  if (blog && found) return { blog, entry: await Entry.get(blog.id, found.id) };

  throw new Error(blog ? "No post at " + url.href : "No site for " + host);
}

async function addOne(url, options) {
  const { blog, entry } = await find(url, url.host);

  if (!entry || entry.deleted || entry.draft || entry.scheduled || !entry.url)
    throw new Error("The post is not published: " + url.href);

  const candidates = Discover.photos.candidates(blog.id, entry);

  if (options.listPhotos) {
    console.log(entry.title);
    candidates.forEach((rel, i) =>
      console.log("  " + (i + 1) + "  " + Discover.photos.url(blog.id, rel))
    );
    return;
  }

  if (blog.includeInDiscover !== true)
    await Blog.set(blog.id, { includeInDiscover: true });

  const sources = [];

  if (options.pick) {
    for (const n of options.pick) {
      const rel = candidates[n - 1];
      if (!rel) throw new Error("The post has no image " + n);
      if (!(await assets.exists(blog.id, rel)))
        throw new Error("Image " + n + " is not in the bucket: " + rel);
      sources.push(rel);
    }
  } else {
    for (const rel of candidates) {
      if (sources.length >= options.photos) break;
      if (await assets.exists(blog.id, rel)) sources.push(rel);
    }
  }

  const id = Discover.postID(blog.id, entry.id);
  const photos = await Discover.photos.derive(blog.id, id, sources);
  const post = await Discover.add(blog.id, entry.id, photos, {
    showText: options.text,
  });

  console.log(
    "On Discover:",
    entry.title,
    "(" + photos.length + (photos.length === 1 ? " photo" : " photos") + ")",
    post.id
  );
}

// Adds each URL in turn, and fails at the end if any could not be added
async function main(argv) {
  const options = parse(argv);
  let failed = 0;

  for (const url of options.urls) {
    try {
      await addOne(url, options);
    } catch (err) {
      failed++;
      console.error("Not added:", url.href, "-", err.message || err);
    }
  }

  if (failed)
    throw new Error(failed + " of " + options.urls.length + " not added");
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

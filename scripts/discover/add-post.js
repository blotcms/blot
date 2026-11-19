// Puts one post on Discover by its URL (#2639), with up to 3 of its photos
// by default, the maintainer's manual opt-in.
//
//   node scripts/discover/add-post.js <post URL> [--photos <n>] [--text] [--refresh]
//
// The site is found by its host and the post by its URL, and the site's
// "Include site on discover page" setting is turned on. --text shows the
// post's text above its photos, clipped with "See more". --photos 0 makes a
// text-only card. Safe to rerun: adding a post already on Discover replaces
// its photos and keeps its place.
//
// In development, a site or post which isn't there yet is copied from the
// live post page first, the way scripts/discover/mirror-featured.js copies
// feeds: the page holds the production blog ID even when the site's feed has
// no images or no posts. --refresh copies it again. Elsewhere nothing is
// fetched, and a missing site or post is an error.

const _ = require("lodash");
const cheerio = require("cheerio");
const config = require("config");
const Blog = require("models/blog");
const User = require("models/user");
const Entry = require("models/entry");
const Discover = require("models/discover");
const assets = require("storage/assets");
const blogForHost = require("documentation/featured/blogForHost");

const CDN = "https://cdn.blot.im/";
const BLOG_ID = /blog_[a-f0-9]{32}/;
const USER_AGENT = "Blot Discover mirror";
const TIMEOUT = 15 * 1000;

// Generated assets which are part of the site, not of a post
const NOT_PHOTOS = /^_(avatars|template_assets)\//;

function usage(message) {
  if (message) console.error(message + "\n");
  console.error(
    "Usage: node scripts/discover/add-post.js <post URL> [--photos <n>] [--text|--no-text] [--refresh]"
  );
  process.exit(2);
}

function parse(argv) {
  const options = { url: null, photos: 3, refresh: false, text: undefined };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--photos" && argv[i + 1] !== undefined) {
      options.photos = parseInt(argv[++i], 10);
      if (!(options.photos >= 0)) usage("--photos must be 0 or more");
    } else if (argv[i] === "--text") {
      options.text = true;
    } else if (argv[i] === "--no-text") {
      options.text = false;
    } else if (argv[i] === "--refresh") {
      options.refresh = true;
    } else if (!argv[i].startsWith("--") && !options.url) {
      options.url = argv[i];
    } else {
      usage("Unknown argument: " + argv[i]);
    }
  }

  if (!options.url) usage();

  try {
    options.parsed = new URL(options.url);
  } catch (err) {
    usage("Not a URL: " + options.url);
  }

  return options;
}

// Development only: the post's date from the site's feed, for a page which
// doesn't give one, or ""
async function feedDate(url) {
  try {
    const feed = new URL("/feed.rss", url).href;
    const response = await fetch(feed, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!response.ok) return "";

    const $ = cheerio.load(await response.text(), { xmlMode: true });
    const path = decodeURI(new URL(url).pathname).toLowerCase();
    let date = "";

    $("item").each(function () {
      const link = $(this).children("link").first().text().trim();
      try {
        if (decodeURI(new URL(link).pathname).toLowerCase() === path)
          date = $(this).children("pubDate").first().text().trim();
      } catch (err) {
        // not a URL
      }
    });

    return date;
  } catch (err) {
    return "";
  }
}

// Development only: what the live post page says about the post
async function fetchPage(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT),
  });

  if (!response.ok) throw new Error("HTTP " + response.status + " for " + url);

  const html = await response.text();
  const found = html.match(BLOG_ID);

  if (!found) throw new Error("No Blot blog ID in " + url);

  const blogID = found[0];
  const $ = cheerio.load(html);
  const meta = (name) =>
    $(`meta[property="${name}"], meta[name="${name}"]`).attr("content") || "";

  // The post's own images: in its article or main element if it has one
  const scope = $("article").first().length
    ? $("article").first()
    : $("main").first().length
      ? $("main").first()
      : $("body");

  const prefix = CDN + blogID + "/";
  const images = [];

  scope.find("img").each(function () {
    const src = ($(this).attr("src") || "").split(/[?#]/)[0];
    if (src.indexOf(prefix) !== 0) return;
    const rel = src.slice(prefix.length);
    if (NOT_PHOTOS.test(rel) || images.indexOf(rel) !== -1) return;
    images.push(rel);
  });

  const description = meta("og:description") || meta("description");
  const siteTitle = (
    meta("og:site_name") ||
    $("title")
      .text()
      .split(/\s[|–—-]\s/)
      .pop() ||
    ""
  ).trim();

  // The post's own heading first: a page title often ends with the site's
  // name, "Post - Site", which is taken off when it does
  let title = (
    scope.find("h1").first().text() ||
    meta("og:title") ||
    $("title").text()
  ).trim();

  for (const separator of [" - ", " – ", " — ", " | "])
    if (siteTitle && title.endsWith(separator + siteTitle))
      title = title.slice(0, -(separator + siteTitle).length).trim();

  return {
    blogID,
    siteTitle,
    item: {
      title,
      link: url,
      pubDate:
        meta("article:published_time") ||
        $("time[datetime]").first().attr("datetime") ||
        (await feedDate(url)),
      html:
        (description ? "<p>" + _.escape(description) + "</p>" : "") +
        images
          .map((rel) => `<img src="${config.cdn.origin}/${blogID}/${rel}">`)
          .join(""),
    },
    images,
  };
}

// Development only: copies the site and the post from the live page
async function copyFromPage(url, host) {
  const mirror = require("./mirror-featured");
  const page = await fetchPage(url);

  let blog = await Blog.get({ id: page.blogID });

  if (blog && page.siteTitle && blog.title !== page.siteTitle) {
    await Blog.set(page.blogID, { title: page.siteTitle });
  } else if (!blog) {
    const owner = await User.getByEmail(mirror.OWNER_EMAIL);
    if (!owner) throw new Error("No local account " + mirror.OWNER_EMAIL);
    await mirror.createBlog(page.blogID, host, page.siteTitle.trim(), owner);
    console.log("Copied the site", host, "as", page.blogID);
  }

  for (const rel of page.images) await mirror.mirrorAsset(page.blogID, rel);

  const path = await mirror.writeEntry(page.blogID, page.item, Date.now());
  if (!path) throw new Error("Could not copy the post at " + url);

  console.log("Copied the post", page.item.title || url);

  blog = await Blog.get({ id: page.blogID });
  return { blog, entry: await Entry.get(page.blogID, path) };
}

async function find(url, host, refresh) {
  const development = config.environment === "development";

  if (refresh && development) return copyFromPage(url.href, host);

  const blog = await blogForHost(host);
  const found = blog
    ? await Entry.getByUrl(blog.id, decodeURI(url.pathname).toLowerCase())
    : null;

  if (blog && found) return { blog, entry: await Entry.get(blog.id, found.id) };

  if (development) return copyFromPage(url.href, host);

  throw new Error(blog ? "No post at " + url.href : "No site for " + host);
}

async function main(argv) {
  const options = parse(argv);
  const { blog, entry } = await find(
    options.parsed,
    options.parsed.host,
    options.refresh
  );

  if (!entry || entry.deleted || entry.draft || entry.scheduled || !entry.url)
    throw new Error("The post is not published: " + options.url);

  if (blog.includeInDiscover !== true)
    await Blog.set(blog.id, { includeInDiscover: true });

  const sources = [];

  for (const rel of Discover.photos.candidates(blog.id, entry)) {
    if (sources.length >= options.photos) break;
    if (await assets.exists(blog.id, rel)) sources.push(rel);
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

if (require.main === module) {
  main(process.argv.slice(2))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err.message || err);
      process.exit(1);
    });
}

module.exports = { main };

// Puts posts on Discover by their URLs (#2639), each with up to 3 of its
// photos by default: the maintainer's manual opt-in, usually run by an agent.
//
//   node scripts/discover/add.js <post URL> [<post URL> ...] [--photos <n>]
//     [--pick <1,3,...>] [--list-photos] [--text|--no-text] [--refresh]
//
// Each site is found by its host and each post by its URL, and the site's
// "Include site on discover page" setting is turned on. --text shows the
// post's text above its photos, clipped with "See more". --photos 0 makes a
// text-only card. --list-photos prints a post's images, numbered, and adds
// nothing; --pick then chooses which of them to show, in that order (at most
// 4), in place of the first ones. Safe to rerun: adding a post already on Discover replaces
// its photos and keeps its place.
//
// In development, a site or post which isn't there yet is copied from the
// live post page first, with production's blog ID, entry URL and image asset
// paths, so the local /discover looks like production's. --refresh copies it
// again. Elsewhere nothing is fetched, and a missing site or post is an
// error.

const _ = require("lodash");
const cheerio = require("cheerio");
const config = require("config");
const Blog = require("models/blog");
const User = require("models/user");
const Entry = require("models/entry");
const Discover = require("models/discover");
const client = require("models/client");
const blogKey = require("models/blog/key");
const blogDefaults = require("models/blog/defaults");
const extend = require("helper/extend");
const makeSlug = require("helper/makeSlug");
const assets = require("storage/assets");
const blogForHost = require("documentation/featured/blogForHost");

const CDN = "https://cdn.blot.im/";
const BLOG_ID = /blog_[a-f0-9]{32}/;
const USER_AGENT = "Blot Discover mirror";
const TIMEOUT = 15 * 1000;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

// The local development account, which owns the copied sites
const OWNER_EMAIL = "example@example.com";

// Generated assets which are part of the site, not of a post
const NOT_PHOTOS = /^_(avatars|template_assets)\//;

function usage(message) {
  if (message) console.error(message + "\n");
  console.error(
    "Usage: node scripts/discover/add.js <post URL> [<post URL> ...] [--photos <n>] [--pick <1,3,...>] [--list-photos] [--text|--no-text] [--refresh]"
  );
  process.exit(2);
}

function parse(argv) {
  const options = { urls: [], photos: 3, refresh: false, text: undefined };

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
    } else if (argv[i] === "--refresh") {
      options.refresh = true;
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

// Development only: a free handle for a copied site, made from its host
async function chooseHandle(host, blogID) {
  const base =
    host
      .replace(/^www\./, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 60) || "copy";

  for (let i = 0; i < 100; i++) {
    const handle = i === 0 ? base : base + i;
    const taken = await Blog.get({ handle });
    if (!taken || taken.id === blogID)
      return handle.length < 3 ? handle + "x" : handle;
  }

  throw new Error("No free handle for " + host);
}

// Development only: creates the site as models/blog/create.js does, but with
// production's blog ID. Its domain is the real host, so it is found by host
// like the production site. It is owned by the local development account but
// not in its list of sites, and has no folder: it only exists for Discover.
async function createBlog(blogID, host, title, owner) {
  const handle = await chooseHandle(host, blogID);
  const blog = {
    owner: owner.uid,
    id: blogID,
    title: title || handle,
    client: "",
    timeZone: "UTC",
    dateFormat: "M/D/YYYY",
    handle,
    domain: host,
    includeInDiscover: true,
  };

  extend(blog).and(_.cloneDeep(blogDefaults));
  await client.sAdd(blogKey.ids, blogID);
  await Blog.set(blogID, blog);
}

// Development only: copies an image from cdn.blot.im to the local bucket, at
// the same asset path
async function copyAsset(blogID, rel) {
  try {
    if (await assets.exists(blogID, rel)) return;

    const response = await fetch(CDN + blogID + "/" + rel, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!response.ok) throw new Error("HTTP " + response.status);

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error("over 15 MB");

    await assets.write(blogID, rel, buffer);
  } catch (err) {
    console.log("  skipped " + rel + ": " + err.message);
  }
}

// Development only: writes the post as an entry whose url is exactly the
// path of its production URL, so Entry.getByUrl finds it. Entry.set takes
// the url from entry.permalink when the metadata names one (Candidates in
// app/models/entry/_setUrl.js), so both are set. Resolves to its path.
async function writeEntry(blogID, item) {
  const url = new URL(item.link).pathname;

  if (!url || url === "/") return null;

  // A stable file path, so a rerun updates the entry
  const path = url.replace(/\/$/, "") + ".txt";
  const stamp = Date.parse(item.pubDate);
  const dateStamp = Number.isFinite(stamp) ? stamp : Date.now();
  const html = item.html;
  const title = item.title || url.split("/").pop();
  const text = cheerio
    .load("<div>" + html + "</div>")("div")
    .text();

  await Entry.set(blogID, path, {
    id: path,
    guid: blogID + ":" + url,
    url: "",
    permalink: url,
    title,
    titleTag: "<h1>" + _.escape(title) + "</h1>",
    body: html,
    summary: text.replace(/\s+/g, " ").trim().slice(0, 200),
    teaser: "",
    teaserBody: "",
    more: false,
    html,
    slug: makeSlug(title),
    name: path.slice(1),
    path,
    size: html.length,
    tags: [],
    dependencies: [],
    backlinks: [],
    internalLinks: [],
    menu: false,
    page: false,
    deleted: false,
    draft: false,
    scheduled: false,
    thumbnail: {},
    dateStamp,
    created: dateStamp,
    updated: dateStamp,
    metadata: { permalink: url },
    exif: {},
  });

  const stored = await Entry.getByUrl(blogID, url.toLowerCase());
  return stored && stored.path === path ? path : null;
}

// Development only: copies the site and the post from the live page
async function copyFromPage(url, host) {
  const page = await fetchPage(url);

  let blog = await Blog.get({ id: page.blogID });

  if (blog && page.siteTitle && blog.title !== page.siteTitle) {
    await Blog.set(page.blogID, { title: page.siteTitle });
  } else if (!blog) {
    const owner = await User.getByEmail(OWNER_EMAIL);
    if (!owner) throw new Error("No local account " + OWNER_EMAIL);
    await createBlog(page.blogID, host, page.siteTitle.trim(), owner);
    console.log("Copied the site", host, "as", page.blogID);
  }

  for (const rel of page.images) await copyAsset(page.blogID, rel);

  const path = await writeEntry(page.blogID, page.item);
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

async function addOne(url, options) {
  const { blog, entry } = await find(url, url.host, options.refresh);

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

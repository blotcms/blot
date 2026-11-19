// Development only. Builds local copies of the featured sites
// (app/documentation/featured/sites.txt) from their public RSS feeds, so the
// maintainer can curate the Discover page locally with real posts.
//
//   node scripts/discover/mirror-featured.js [host ...] [--limit <n>]
//
// With no hosts it does every host in sites.txt. Only each site's newest
// posts are mirrored, 10 unless --limit says otherwise, and only their
// images are downloaded. For each one it fetches
// https://<host>/feed.rss and finds the production blog ID in the image URLs
// (https://cdn.blot.im/blog_.../). The local copy uses the same identifiers
// as production, so that a later export/import maps local picks onto
// production:
//
//   - the blog has the production blog ID;
//   - each entry's url is exactly the path of its production URL, so
//     Entry.getByUrl(blogID, path) resolves. Entry.set takes the url from
//     entry.permalink when the entry's metadata names one (see Candidates in
//     app/models/entry/_setUrl.js), so the script sets both;
//   - each image the posts refer to is stored in the local storage bucket at
//     the same asset path as production (_image_cache/<uuid>.jpg), downloaded
//     from cdn.blot.im if it isn't there yet. Image URLs in the HTML point at
//     config.cdn.origin, which is what models/discover/photos.js recognises.
//
// A blog which doesn't exist locally is created as models/blog/create.js
// would, but with the production ID instead of a generated one. It is owned
// by example@example.com (the local development account) and is NOT added to
// that account's blog list: the mirrors are reference material for Discover,
// and listing a dozen of them would clutter the local dashboard and the blog
// switcher. They are still reachable at <handle>.blot.localhost and listed by
// Blog.getAllIDs.
//
// Safe to rerun: blogs and entries are found by ID and path, and images that
// are already stored are not downloaded again. Refuses to run unless
// config.environment is "development".

const cheerio = require("cheerio");
const _ = require("lodash");
const fs = require("fs-extra");
const { join } = require("path");
const config = require("config");
const Blog = require("models/blog");
const User = require("models/user");
const Entry = require("models/entry");
const client = require("models/client");
const blogKey = require("models/blog/key");
const blogDefaults = require("models/blog/defaults");
const extend = require("helper/extend");
const makeSlug = require("helper/makeSlug");
const assets = require("storage/assets");

const OWNER_EMAIL = "example@example.com";
const SITES = join(__dirname, "../../app/documentation/featured/sites.txt");
const TIMEOUT = 15 * 1000;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const DEFAULT_LIMIT = 10;
const USER_AGENT = "Blot Discover mirror";
const CDN = "https://cdn.blot.im/";
const BLOG_ID = /https:\/\/cdn\.blot\.im\/(blog_[a-f0-9]+)\//;

function usage(message) {
  if (message) console.error(message + "\n");

  console.error(
    "Usage: node scripts/discover/mirror-featured.js [host ...] [--limit <n>]"
  );
  process.exit(2);
}

async function fetchOK(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT),
  });

  if (!response.ok) throw new Error("HTTP " + response.status);

  return response;
}

async function hostsFromSites() {
  const text = await fs.readFile(SITES, "utf8");

  return text
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean);
}

// Lowercase letters and digits, at least 3 and at most 70, and not taken by
// another blog (blog/validate/handle.js rejects anything else)
async function chooseHandle(host, blogID) {
  const base =
    host
      .replace(/^www\./, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 60) || "mirror";

  for (let i = 0; i < 100; i++) {
    const handle = i === 0 ? base : base + i;
    const taken = await Blog.get({ handle });

    if (!taken || taken.id === blogID)
      return handle.length < 3 ? handle + "x" : handle;
  }

  throw new Error("No free handle for " + host);
}

// Creates the blog as models/blog/create.js does, with a given ID. Blog.set
// validates the fields (title, handle...), so an invalid one rejects with an
// errors object before anything is written beyond the ID set entry.
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
    includeInDiscover: true,
  };

  extend(blog).and(_.cloneDeep(blogDefaults));

  await client.sAdd(blogKey.ids, blogID);
  // No folder is made: the mirror is only for Discover, has no sync client,
  // and Blot's changes to folders go through one (check-folder-access.js)
  await Blog.set(blogID, blog);

  return handle;
}

function excerpt(html) {
  const text = cheerio
    .load("<div>" + html + "</div>")("div")
    .text()
    .replace(/\s+/g, " ")
    .trim();

  return text.length > 200 ? text.slice(0, 200).trim() + "..." : text;
}

// The asset paths under this blog that html refers to. Generated assets
// only: the first segment starts with "_" and there is no "..".
function assetPaths(html, blogID) {
  const pattern = new RegExp(
    _.escapeRegExp(CDN + blogID + "/") + "([^\"'\\s)<>]+)",
    "g"
  );
  const found = new Set();
  let match;

  while ((match = pattern.exec(html))) {
    const rel = match[1].split(/[?#]/)[0];

    if (!/^_[\w-]+\/[\w./%-]+$/.test(rel)) continue;
    if (rel.split("/").indexOf("..") !== -1) continue;

    found.add(rel);
  }

  return Array.from(found);
}

// Resolves to "stored", "present" or "failed"
async function mirrorAsset(blogID, rel) {
  try {
    if (await assets.exists(blogID, rel)) return "present";

    const response = await fetchOK(CDN + blogID + "/" + rel);
    const length = Number(response.headers.get("content-length") || 0);

    if (length > MAX_IMAGE_BYTES) {
      console.log("  skipped (over 15 MB): " + rel);
      return "failed";
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.length > MAX_IMAGE_BYTES) {
      console.log("  skipped (over 15 MB): " + rel);
      return "failed";
    }

    await assets.write(blogID, rel, buffer);

    return "stored";
  } catch (err) {
    console.log("  skipped " + rel + ": " + err.message);
    return "failed";
  }
}

async function writeEntry(blogID, item, now) {
  const url = new URL(item.link).pathname;

  if (!url || url === "/") return null;

  // A stable file path, so a rerun updates the entry. It isn't the url
  // itself: Entry.set never gives an entry its own path as its url.
  const path = url.replace(/\/$/, "") + ".txt";
  const stamp = Date.parse(item.pubDate);
  const dateStamp = Number.isFinite(stamp) ? stamp : now;
  const html = item.html;
  const title = item.title || url.split("/").pop();

  await Entry.set(blogID, path, {
    id: path,
    guid: blogID + ":" + url,
    url: "",
    // Both are needed for the url to be exact: with metadata.permalink the
    // blog's permalink format is skipped, and entry.permalink is then the
    // first candidate url (_setUrl.js, Candidates).
    permalink: url,
    title,
    titleTag: "<h1>" + _.escape(title) + "</h1>",
    body: html,
    summary: excerpt(html),
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

  // Urls are stored lowercased, as in production (urlNormalizer)
  if (!stored || stored.path !== path) {
    console.log("  url mismatch: " + url + " is not served by " + path);
    return null;
  }

  return true;
}

// Resolves to { blogID, entries, images } for the host, or null if skipped
async function mirrorHost(host, owner, limit) {
  let xml;

  try {
    xml = await (await fetchOK("https://" + host + "/feed.rss")).text();
  } catch (err) {
    console.log(host + ": skipped, feed not fetched (" + err.message + ")");
    return null;
  }

  const $ = cheerio.load(xml, { xmlMode: true });
  const items = $("item")
    .map((i, el) => {
      const item = $(el);
      const encoded = item
        .children()
        .filter((j, child) => child.tagName === "content:encoded")
        .first()
        .text();

      return {
        title: item.children("title").first().text().trim(),
        link: item.children("link").first().text().trim(),
        pubDate: item.children("pubDate").first().text().trim(),
        html: (encoded || item.children("description").first().text()).trim(),
      };
    })
    .get()
    .filter((item) => item.link && item.html)
    .sort(
      (a, b) => (Date.parse(b.pubDate) || 0) - (Date.parse(a.pubDate) || 0)
    );

  if (!items.length) {
    console.log(host + ": skipped, no items in the feed");
    return null;
  }

  const found = items.map((item) => item.html.match(BLOG_ID)).find(Boolean);

  if (!found) {
    console.log(host + ": skipped, no cdn.blot.im images in the feed");
    return null;
  }

  const blogID = found[1];

  // The blog ID may only be in older posts' images, so trim after finding it
  items.splice(limit);
  const existing = await Blog.get({ id: blogID });
  let created = false;

  if (!existing) {
    const title = $("channel > title").first().text().trim();

    await createBlog(blogID, host, title, owner);
    created = true;
  } else if (!existing.includeInDiscover) {
    await Blog.set(blogID, { includeInDiscover: true });
  }

  const local = config.cdn.origin + "/" + blogID + "/";
  const now = Date.now();
  let entries = 0;
  let images = 0;
  const wanted = new Set();

  for (const item of items) {
    for (const rel of assetPaths(item.html, blogID)) wanted.add(rel);

    item.html = item.html.split(CDN + blogID + "/").join(local);

    try {
      if (await writeEntry(blogID, item, now)) entries++;
    } catch (err) {
      console.log("  entry " + item.link + " failed: " + err.message);
    }
  }

  for (const rel of wanted)
    if ((await mirrorAsset(blogID, rel)) === "stored") images++;

  console.log(
    host +
      ": " +
      blogID +
      (created ? " (blog created)" : "") +
      ", " +
      entries +
      "/" +
      items.length +
      " entries, " +
      images +
      " images downloaded, " +
      wanted.size +
      " referenced"
  );

  return { entries, images };
}

async function main() {
  if (config.environment !== "development")
    usage("This script only runs in development, not " + config.environment);

  const argv = process.argv.slice(2);
  const args = [];
  let limit = DEFAULT_LIMIT;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--limit" && argv[i + 1]) {
      limit = parseInt(argv[++i], 10);
      if (!(limit > 0)) usage("--limit must be a positive number");
    } else if (argv[i].startsWith("-")) {
      usage("Unknown argument: " + argv[i]);
    } else {
      args.push(argv[i]);
    }
  }

  const owner = await User.getByEmail(OWNER_EMAIL);

  if (!owner)
    usage("No local account " + OWNER_EMAIL + ". Sign up for one first.");

  const hosts = args.length ? args : await hostsFromSites();
  const totals = { hosts: 0, skipped: 0, entries: 0, images: 0 };

  for (const host of hosts) {
    const result = await mirrorHost(host, owner, limit);

    if (!result) {
      totals.skipped++;
      continue;
    }

    totals.hosts++;
    totals.entries += result.entries;
    totals.images += result.images;
  }

  console.log(
    "\nDone: " +
      totals.hosts +
      " sites mirrored, " +
      totals.skipped +
      " skipped, " +
      totals.entries +
      " entries, " +
      totals.images +
      " images downloaded"
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);

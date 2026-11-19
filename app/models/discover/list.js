const client = require("models/client");
const Blog = require("models/blog");
const Entry = require("models/entry");
const key = require("./key");
const post = require("./post");
const photos = require("./photos");

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;
const EXCERPT_LENGTH = 200;

function excerpt(text) {
  text = (text || "").replace(/\s+/g, " ").trim();
  if (text.length <= EXCERPT_LENGTH) return text;
  return text.slice(0, EXCERPT_LENGTH).replace(/\s+\S*$/, "") + "…";
}

// Why a post isn't shown, or null when it is. Every check is made against
// the live blog and entry, so a stored post never changes when its site
// turns the setting off or its author edits it.
function hiddenBecause(record, blog, entry, shown) {
  if (!blog) return "The site no longer exists";
  if (blog.isDisabled) return "The site is disabled";
  if (blog.includeInDiscover !== true)
    return "The site has turned off Discover";
  if (!entry || entry.deleted) return "The post was deleted";
  if (entry.draft || entry.scheduled || !entry.url)
    return "The post is not published";
  if (record.photos.length && !shown.length)
    return "The chosen photos are no longer in the post";
  return null;
}

// "19 November 2026", in the blog's time zone
function formatDate(dateStamp, timeZone) {
  if (!dateStamp) return "";

  const options = { day: "numeric", month: "long", year: "numeric" };

  try {
    return new Intl.DateTimeFormat("en-GB", {
      ...options,
      timeZone: timeZone || "UTC",
    }).format(new Date(dateStamp));
  } catch (err) {
    return new Intl.DateTimeFormat("en-GB", {
      ...options,
      timeZone: "UTC",
    }).format(new Date(dateStamp));
  }
}

function site(record, blog, extended) {
  if (!extended) return { label: record.blogID, url: "", name: record.blogID };

  const name = blog.title || extended.pretty.label;

  return {
    label: extended.pretty.label,
    url: extended.url,
    host: new URL(extended.url).host,
    // "example.com", for the box of a post without photos
    address: new URL(extended.url).host.replace(/^www\./, ""),
    name,
    avatar: blog.avatar || "",
    initial: name.trim().charAt(0).toUpperCase(),
  };
}

// The card for a post, with the live title and URL
function card(record, blog, entry) {
  const shown = entry
    ? record.photos.filter((photo) =>
        photos.stillInEntry(record.blogID, entry, photo.source)
      )
    : [];

  const hidden = hiddenBecause(record, blog, entry, shown);
  const extended = blog ? Blog.extend(blog) : null;

  return {
    id: record.id,
    blogID: record.blogID,
    entryID: record.entryID,
    added: record.added,
    hidden,
    title: (entry && entry.title) || record.entryID,
    url: extended && entry && entry.url ? extended.url + entry.url : "",
    site: site(record, blog, extended),
    date: entry ? formatDate(entry.dateStamp, blog && blog.timeZone) : "",
    datetime:
      entry && entry.dateStamp ? new Date(entry.dateStamp).toISOString() : "",
    photos: shown.map((photo, index) => ({
      src: photos.url(record.blogID, photo.path),
      width: photo.width,
      height: photo.height,
      first: index === 0,
    })),
    excerpt: shown.length ? "" : excerpt(entry && entry.summary),
  };
}

// Resolves to the cards for the records, loading each blog once
async function cards(records) {
  const blogs = new Map();
  const result = [];

  for (const record of records) {
    if (!blogs.has(record.blogID))
      blogs.set(record.blogID, await Blog.get({ id: record.blogID }));

    const blog = blogs.get(record.blogID);
    const entry = blog ? await Entry.get(record.blogID, record.entryID) : null;

    result.push(card(record, blog, entry));
  }

  return result;
}

// Newest first. Resolves to { posts, next }: next is the cursor for the
// following page (pass it back as before), or null at the end. Hidden posts
// are skipped, and pages are filled from further down the list, unless all
// is set (the manage page), which returns them with the reason they're
// hidden.
async function list(options = {}) {
  const limit = Math.min(
    Math.max(parseInt(options.limit, 10) || DEFAULT_LIMIT, 1),
    MAX_LIMIT
  );
  const all = options.all === true;
  const before = parseInt(options.before, 10);

  let max = Number.isFinite(before) && before > 0 ? "(" + before : "+inf";
  const posts = [];
  let next = null;

  while (posts.length < limit) {
    const want = limit - posts.length;

    const batch = await client.zRangeWithScores(key.posts(), max, "-inf", {
      BY: "SCORE",
      REV: true,
      LIMIT: { offset: 0, count: want },
    });

    if (!batch.length) {
      next = null;
      break;
    }

    const records = await post.getMany(batch.map((item) => item.value));

    for (const item of await cards(records)) {
      if (all || !item.hidden) posts.push(item);
    }

    const last = batch[batch.length - 1].score;
    max = "(" + last;
    next = last;

    if (batch.length < want) {
      next = null;
      break;
    }
  }

  return { posts, next };
}

module.exports = list;
module.exports.cards = cards;

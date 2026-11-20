const cheerio = require("cheerio");
const client = require("models/client");
const Blog = require("models/blog");
const Entry = require("models/entry");
const key = require("./key");
const post = require("./post");
const photos = require("./photos");
const profile = require("./profile");

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;
const EXCERPT_LENGTH = 200;

// Enough text for the clipped block above the photos
const TEXT_LENGTH = 1500;

// The paragraphs of a post's text, for a card which shows it: plain text,
// without the title and without empty or image-only paragraphs
function paragraphs(entry) {
  if (!entry || !entry.body) return [];

  const $ = cheerio.load(entry.body);
  const title = (entry.title || "").trim();
  const result = [];
  let length = 0;

  $("p").each(function () {
    if (length >= TEXT_LENGTH) return false;
    const text = $(this).text().replace(/\s+/g, " ").trim();
    if (!text || text === title) return;
    result.push(text);
    length += text.length;
  });

  return result;
}

// The paragraphs above a card's photos: the text the maintainer wrote for it,
// or the post's own when the card shows it
function cardText(record, entry) {
  if (record.text) return [record.text];
  return record.showText ? paragraphs(entry) : [];
}

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

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

// Under a month old: "just now", "5m", "4h", "3d", "2w". Older: "19 November
// 2026", in the blog's time zone. The page isn't cached, so this is worked
// out as it is rendered.
function formatDate(dateStamp, timeZone, now = Date.now()) {
  if (!dateStamp) return "";

  const age = now - dateStamp;

  if (age >= 0 && age < MONTH) {
    if (age < MINUTE) return "just now";
    if (age < HOUR) return Math.floor(age / MINUTE) + "m";
    if (age < DAY) return Math.floor(age / HOUR) + "h";
    if (age < WEEK) return Math.floor(age / DAY) + "d";
    return Math.floor(age / WEEK) + "w";
  }

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
    excerpt: shown.length ? "" : record.text || excerpt(entry && entry.summary),
    showText: record.showText,
    text: shown.length ? cardText(record, entry) : [],
  };
}

// Resolves to the cards for the records, loading each blog once
// A profile set by the maintainer (./profile) replaces the site's own name,
// avatar and bio. site.custom says which, so that sites.txt details don't
// replace them in turn (documentation/discover.js).
function applyProfile(site, saved) {
  site.custom = { name: false, avatar: false, bio: false };
  if (!saved) return site;

  if (saved.name) {
    site.name = saved.name;
    site.initial = saved.name.charAt(0).toUpperCase();
    site.custom.name = true;
  }

  if (saved.avatar) {
    site.avatar = saved.avatar;
    site.custom.avatar = true;
  }

  if (saved.bio) {
    site.bio = saved.bio;
    site.custom.bio = true;
  }

  return site;
}

async function cards(records) {
  const blogs = new Map();
  const result = [];
  const profiles = await profile.getMany(
    records.map((record) => record.blogID)
  );

  for (const record of records) {
    if (!blogs.has(record.blogID))
      blogs.set(record.blogID, await Blog.get({ id: record.blogID }));

    const blog = blogs.get(record.blogID);
    const entry = blog ? await Entry.get(record.blogID, record.entryID) : null;

    const item = card(record, blog, entry);
    applyProfile(item.site, profiles.get(record.blogID));
    result.push(item);
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
module.exports.formatDate = formatDate;

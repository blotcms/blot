const { parseStringPromise } = require("xml2js");
const { basename } = require("path");
const { URL } = require("url");
const cheerio = require("cheerio");

const KIND_PREFIX = "http://schemas.google.com/blogger/2008/kind#";
const LABEL_SCHEME = "http://www.blogger.com/atom/ns#";

function value(node) {
  if (node === undefined || node === null) return "";
  if (Array.isArray(node)) return value(node[0]);
  if (typeof node === "string") return node;
  return node._ || "";
}

function normalizeHost(hostname) {
  return String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
}

// Accepts a full URL or bare hostname and returns a normalized hostname, or ""
// when the input is empty. Throws for values that are present but invalid.
function parseSiteHost(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch (err) {
    throw new Error(
      "Please enter a valid site URL, like https://example.blogspot.com", { cause: err }
    );
  }

  const host = normalizeHost(url.hostname);
  if (!host || !host.includes(".")) {
    throw new Error(
      "Please enter a valid site URL, like https://example.blogspot.com"
    );
  }

  return host;
}

// Older Blogger backups expose the post URL on link[rel=alternate]. Current
// exports use blogger:filename with a path like /2020/01/post.html.
function permalinkPath(permalink) {
  if (!permalink) return "";
  try {
    return new URL(permalink, "https://blogger.invalid").pathname;
  } catch (err) {
    return "";
  }
}

function permalinkSlug(permalink) {
  const pathname = permalinkPath(permalink);
  if (!pathname) return "";
  try {
    return decodeURIComponent(pathname)
      .replace(/\.(?:html?|xhtml)$/i, "")
      .replace(/^\/+|\/+$/g, "")
      .replace(/\//g, "-");
  } catch (err) {
    return "";
  }
}

function permalinkBasename(permalink) {
  const pathname = permalinkPath(permalink);
  if (!pathname) return "";
  try {
    const component = pathname.split("/").filter(Boolean).pop();
    return component
      ? decodeURIComponent(component).replace(/\.(?:html?|xhtml)$/i, "")
      : "";
  } catch (err) {
    return "";
  }
}

function entryKind(atomEntry) {
  const bloggerType = value(atomEntry["blogger:type"]).toLowerCase();
  if (bloggerType === "post" || bloggerType === "page") return bloggerType;

  const categories = atomEntry.category || [];
  const kindCategory = categories.find(
    (category) =>
      category &&
      category.$ &&
      category.$.term &&
      category.$.term.indexOf(KIND_PREFIX) === 0
  );
  return kindCategory
    ? kindCategory.$.term.slice(KIND_PREFIX.length).toLowerCase()
    : "";
}

function isDraft(atomEntry) {
  const status = value(atomEntry["blogger:status"]).toLowerCase();
  if (status === "draft") return true;

  return (
    value(
      atomEntry["app:control"] && atomEntry["app:control"][0]["app:draft"]
    ).toLowerCase() === "yes"
  );
}

function isTrashed(atomEntry) {
  return Boolean(value(atomEntry["blogger:trashed"]));
}

function entryPermalink(atomEntry) {
  const alternate = (atomEntry.link || []).find(
    (link) => link && link.$ && link.$.rel === "alternate" && link.$.href
  );
  if (alternate) return alternate.$.href;

  const filename = value(atomEntry["blogger:filename"]).trim();
  return filename || undefined;
}

function entryTags(categories) {
  return (categories || [])
    .filter(
      (category) =>
        category &&
        category.$ &&
        category.$.scheme === LABEL_SCHEME &&
        category.$.term
    )
    .map(({ $ }) => $.term);
}

function relativeBlogPath(urlString, siteHost) {
  if (!urlString || !siteHost || !/^https?:\/\//i.test(urlString)) return;
  try {
    const url = new URL(urlString);
    if (normalizeHost(url.hostname) !== normalizeHost(siteHost)) return;
    return (url.pathname || "/") + (url.hash || "");
  } catch (err) {
    return;
  }
}

function htmlString($) {
  return $("body").length ? $("body").html() : $.html();
}

function relativizeHtml(html, siteHost) {
  if (!html || !siteHost) return html;

  const $ = cheerio.load(html, { decodeEntities: false });
  $("[href]").each(function () {
    const href = $(this).attr("href");
    const relative = relativeBlogPath(href, siteHost);
    if (relative) $(this).attr("href", relative);
  });

  return htmlString($);
}

function pathnameBasename(urlString) {
  try {
    return decodeURIComponent(
      basename(new URL(urlString, "https://blogger.invalid").pathname)
    ).toLowerCase();
  } catch (err) {
    return "";
  }
}

// Newer /img/a/ URLs encode display size as a suffix on the opaque id
// (.../AVvXsEg...=w320-h269) rather than an /s320/ path segment. Strip
// that so thumb and full-size basenames compare equal.
function imageAssetKey(urlString) {
  return pathnameBasename(urlString).replace(/=\w[\w-]*$/, "");
}

// Blogger wraps display thumbnails in a link to the full-size file
// (.../s320/photo.jpg inside .../s1600/photo.jpg, or
// .../img/a/{id}=w320-h269 inside .../img/a/{id}). Promote the src so
// download_images fetches the full image and can rewrite both URLs.
function preferFullSizeImages(html) {
  if (!html) return html;

  const $ = cheerio.load(html, { decodeEntities: false });
  $("img").each(function () {
    const $img = $(this);
    const src = $img.attr("src");
    if (!src) return;

    const href = $img.closest("a").attr("href");
    if (!href || href === src) return;

    const srcKey = imageAssetKey(src);
    const hrefKey = imageAssetKey(href);
    if (srcKey && srcKey === hrefKey) $img.attr("src", href);
  });

  return htmlString($);
}

// Blogger often pads headings with trailing <br>s inside <b>/<strong>:
//   <b>Title<br /><br /></b>
// Turndown then emits broken emphasis (**Title  \n  \n**). Moving the
// trailing breaks after the bold tag keeps the bold span tidy.
function hoistTrailingBreaks(html) {
  if (!html) return html;

  const $ = cheerio.load(html, { decodeEntities: false });
  $("b, strong").each(function () {
    const $el = $(this);
    const moved = [];

    while ($el.contents().length) {
      const $last = $el.contents().last();
      const node = $last[0];

      if (node.type === "tag" && node.name === "br") {
        moved.unshift($last.remove());
        continue;
      }

      if (node.type === "text" && !/\S/.test(node.data || "")) {
        $last.remove();
        continue;
      }

      break;
    }

    let $cursor = $el;
    for (const $br of moved) {
      $cursor.after($br);
      $cursor = $br;
    }
  });

  return htmlString($);
}

function rebaseEntries(entries, siteHost) {
  for (const entry of entries) {
    entry.html = preferFullSizeImages(entry.html);
    entry.html = hoistTrailingBreaks(entry.html);
    if (!siteHost) continue;

    entry.html = relativizeHtml(entry.html, siteHost);
    const relativePermalink = relativeBlogPath(entry.permalink, siteHost);
    if (relativePermalink) entry.permalink = relativePermalink;
  }

  return entries;
}

module.exports = async function parse(xml, siteHost) {
  const document = await parseStringPromise(xml);
  const atomEntries = (document.feed && document.feed.entry) || [];
  const entries = [];
  const host = parseSiteHost(siteHost || "");

  for (const atomEntry of atomEntries) {
    const kind = entryKind(atomEntry);

    // An export also contains comments and Blogger's internal configuration.
    if ((kind !== "post" && kind !== "page") || isDraft(atomEntry) || isTrashed(atomEntry))
      continue;

    const permalink = entryPermalink(atomEntry);
    const rawTitle = value(atomEntry.title && atomEntry.title[0]).trim();
    const slug = permalinkSlug(permalink);
    const published = Date.parse(value(atomEntry.published && atomEntry.published[0]));
    const updated = Date.parse(value(atomEntry.updated && atomEntry.updated[0]));

    entries.push({
      id: value(atomEntry.id && atomEntry.id[0]),
      title: rawTitle || permalinkBasename(permalink) || "Untitled",
      html: value(atomEntry.content && atomEntry.content[0]),
      permalink,
      slug,
      page: kind === "page",
      draft: false,
      dateStamp: Number.isNaN(published) ? undefined : published,
      created: Number.isNaN(published) ? undefined : published,
      updated: Number.isNaN(updated) ? undefined : updated,
      tags: entryTags(atomEntry.category),
    });
  }

  rebaseEntries(entries, host);

  // determine_path uses the slug as the filename. Suffix repeated slugs in source
  // order so no entry can silently overwrite another and repeat imports are stable.
  const occurrences = new Map();
  for (const entry of entries) {
    const base = entry.slug || entry.title || "untitled";
    const count = (occurrences.get(base) || 0) + 1;
    occurrences.set(base, count);
    entry.slug = count === 1 ? base : `${base}-${count}`;
  }

  return entries;
};

module.exports.permalinkSlug = permalinkSlug;
module.exports.parseSiteHost = parseSiteHost;
module.exports.relativizeHtml = relativizeHtml;
module.exports.preferFullSizeImages = preferFullSizeImages;
module.exports.hoistTrailingBreaks = hoistTrailingBreaks;

// Work out which pages to screenshot. Runs INSIDE the container.
//
//   docker exec blot-node-app-1 node scripts/development/translate/targets <blogID> <sourceURL>
//
// Emits a JSON array of capture targets for screenshot.js (which runs on the
// host). Each target names a label, the local URL, and — where it can be worked
// out — the corresponding URL on the source site.
//
// Pairing the local post against the right source post is only possible when the
// content preserved its original permalinks, which importers do via `Link:`
// metadata. Where that holds, the local path and the source path are the same.
// Where it does not, the source URL is still emitted as a best guess and the
// caller drops the pair if it 404s.

const { promisify } = require("util");

const config = require("config");
const Blog = require("models/blog");
const Entries = require("models/entries");
const Entry = require("models/entry");

const getBlog = promisify(Blog.get);
const getListIDs = promisify(Entries.getListIDs);

const getEntry = (blogID, path) =>
  new Promise((resolve) => Entry.get(blogID, path, resolve));

// The preview subdomain skips CDN rewriting and renders template errors on a
// dedicated page instead of failing opaquely, which is what we want while
// iterating (app/blog/middleware/vhosts.js).
function previewOrigin(blog, templateID) {
  const slug = templateID.split(":").slice(1).join(":");
  return `${config.protocol}preview-of-my-${slug}-on-${blog.handle}.${config.host}`;
}

function sourceOrigin(sourceURL) {
  try {
    return new URL(sourceURL).origin;
  } catch (e) {
    return null;
  }
}

// Prefer a post with some substance to it: a one-line post tells you very little
// about how the template handles real writing.
async function representativeEntry(blogID) {
  const ids = await getListIDs(blogID, "entries", {});

  if (!ids || !ids.length) return null;

  const candidates = [];

  for (const id of ids.slice(0, 20)) {
    const entry = await getEntry(blogID, id);
    if (entry && entry.url && !entry.deleted && !entry.draft) candidates.push(entry);
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => (b.size || 0) - (a.size || 0));

  return candidates[0];
}

async function main(blogID, sourceURL) {
  if (!blogID) throw new Error("Pass a blog ID as the first argument");
  if (!sourceURL) throw new Error("Pass the source URL as the second argument");

  const blog = await getBlog({ id: blogID });

  if (!blog || !blog.id) throw new Error(`No blog with ID ${blogID}`);

  const local = previewOrigin(blog, blog.template);
  const source = sourceOrigin(sourceURL);
  const targets = [];

  targets.push({
    label: "homepage",
    local: `${local}/`,
    source: sourceURL,
  });

  targets.push({
    label: "homepage-mobile",
    local: `${local}/`,
    source: sourceURL,
    mobile: true,
  });

  const entry = await representativeEntry(blogID);

  if (entry) {
    targets.push({
      label: "post",
      local: `${local}${entry.url}`,
      source: source ? `${source}${entry.url}` : null,
      // Recorded so the caller can explain a missing pair rather than just
      // dropping it silently.
      entryPath: entry.path,
    });
  }

  console.log(JSON.stringify(targets, null, 2));
}

if (require.main === module) {
  main(process.argv[2], process.argv[3])
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[targets]", err.message);
      process.exit(1);
    });
}

module.exports = main;

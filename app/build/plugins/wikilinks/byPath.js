const folder = require("storage/folder");
const {
  join,
  resolve,
  basename,
  dirname,
  normalize: normalizePath,
} = require("path");
const makeSlug = require("helper/makeSlug");

// We want to think about the specific kinds of wikilinks we want to
// support here. The first should be a relative path, e.g.

// pathOfPost: /Posts/Foo/post.txt
// wikilink: [[subFolder/target]]
// target: /Posts/Foo/subFolder/target.txt

// Another variant of relative path to support:
// pathOfPost: /Posts/Foo/post.txt
// wikilink: [[./subFolder/target]]
// target: /Posts/Foo/subFolder/target.txt

// A further type of relative path to support:
// pathOfPost: /Posts/Foo/post.txt
// wikilink: [[./subFolder/target]]
// target: /Posts/Foo/subFolder/target.txt

// Next we support absolute paths:

// pathOfPost: /Posts/post.txt
// wikilink: [[/Posts/target]]
// target: /Posts/target.txt

module.exports = async function byPath(blogID, pathOfPost, href, isLink) {
  // if pathOfPost is '/Posts/foo.txt' then dirOfPost is '/Posts'
  const dirOfPost = dirname(pathOfPost);

  // if href is 'sub/Foo.txt' and dirOfPost is '/Posts' then
  // resolvedHref is '/Posts/sub/Foo.txt'
  const resolvedHref = resolve(dirOfPost, href);

  const lookups = [
    () => exact(blogID, href),
    () => exact(blogID, resolvedHref),
    () => caseInsensitive(blogID, href),
    () => caseInsensitive(blogID, resolvedHref),
    () => rough(blogID, href),
    () => rough(blogID, resolvedHref),
  ];

  // When the converter (e.g. Pandoc) resolves embed paths relative to the
  // document, we get e.g. /Daily/Notes/Checklist for ![[Notes/Checklist]] in
  // /Daily/Plan.txt. The file is at /Notes/Checklist.md. Try the path as if
  // relative to blog root by stripping the current post's directory prefix.
  if (
    !isLink &&
    href.startsWith("/") &&
    dirOfPost !== "/" &&
    href.startsWith(dirOfPost + "/")
  ) {
    const rootRelative = href.slice(dirOfPost.length).replace(/^\//, "");
    if (rootRelative !== href) {
      const rootPath = rootRelative.startsWith("/")
        ? rootRelative
        : "/" + rootRelative;

      lookups.push(
        () => exact(blogID, rootPath),
        () => rough(blogID, rootPath)
      );
    }
  }

  // The first lookup to find an entry wins; each is tried in turn.
  for (const lookup of lookups) {
    try {
      return await lookup();
    } catch (err) {
      // Not found this way: try the next lookup
    }
  }

  throw new Error("No entry found by path");
};

function getEntry(blogID, path) {
  const get = require("models/entry").get;

  return new Promise((done) => get(blogID, path, done));
}

async function exact(blogID, path) {
  const entry = await getEntry(blogID, path);

  if (!entry || !entry.url || entry.deleted) throw new Error("No entry");

  return entry;
}

async function rough(blogID, path) {
  let finalPath;

  try {
    finalPath = await searchForExtension(blogID, path);
  } catch (err) {
    finalPath = null;
  }

  if (!finalPath) throw new Error("No path");

  const entry = await getEntry(blogID, finalPath);

  if (!entry || !entry.url || entry.deleted) throw new Error("No entry");

  return entry;
}

async function caseInsensitive(blogID, path) {
  const correctPath = await resolveCase(blogID, path);

  if (!correctPath) throw new Error("No path");

  const entry = await getEntry(blogID, correctPath);

  if (!entry || !entry.url || entry.deleted) throw new Error("No entry");

  return entry;
}

// e.g '/blog/post' -> '/blog/post.md'
async function searchForExtension(blogID, path) {
  const dir = dirname(path);
  const base = basename(path);

  const correctDir = await resolveCase(blogID, dir);

  if (!correctDir) throw new Error("No dir");

  const entries = await folder.listNames(blogID, correctDir);

  const contents = entries.map((entry) => entry.name);

  const perfectMatch = contents.find((item) => item.startsWith(base));

  if (perfectMatch) return join(correctDir, perfectMatch);

  const roughMatch = contents.find((item) =>
    normalize(item).startsWith(normalize(base))
  );

  if (roughMatch) return join(correctDir, roughMatch);

  throw new Error("No matching file");
}

// The stored spelling of a path, ignoring case. A relative path which climbs
// out of the folder matches nothing, rather than being held inside it.
async function resolveCase(blogID, path) {
  const normalized = normalizePath(path);

  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("No path matches: " + path);
  }

  return folder.resolveCaseInsensitive(blogID, normalized);
}

function normalize(str) {
  return stripNonAlphaNumeric(makeSlug(str));
}

function stripNonAlphaNumeric(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, "");
}

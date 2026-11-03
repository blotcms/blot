// Read-only scan of blog folders for filenames which are fine on a POSIX disk
// but awkward as S3 keys ({blogID}/folder/{path}), ahead of moving blog
// folders to S3 (app/storage/README §7, #2258). Nothing is written, renamed or
// deleted, and symlinks are not followed.
//
// Names are read as Buffers, so bytes which are not valid UTF-8 are reported
// rather than silently replaced. The walk is gentle on the disk: blogs one at
// a time, directories one at a time, streaming the listing, so only the names
// in the directory being looked at are held in memory.
//
// One line per offending path: blog ID, category, path (control characters
// and invalid bytes escaped; directories end in "/"). Then a summary with
// counts per category. Exits 0 whether or not anything is found. Filenames
// can be customer data, so the report goes to stdout only; keep it out of
// issues, PRs and chat.
//
// Categories:
//   key-too-long     {blogID}/folder/{path} is over 1024 bytes of UTF-8
//   invalid-utf8     the name is not valid UTF-8
//   control-char     C0, DEL or C1 control character in the name
//   edge-whitespace  leading or trailing whitespace
//   trailing-dot     the name ends in "."
//   double-space     two whitespace characters in a row
//   dot-segment      the name is only dots (".", "..", "...") once trimmed
//   slash-like       backslash, or a lookalike of "/" (U+2044, U+2215, U+29F8,
//                    U+FF0F), which S3 tools and CDNs may treat as a separator
//   nfc-collision    another name in the same directory differs only by
//                    Unicode normalisation (NFC vs NFD)
//   case-collision   another name in the same directory differs only by case
//                    (the index needs a lowercased lookup)
//
// Usage: node scripts/storage/scan-folder-filenames.js [blog-identifier]
//
// On the production host:
//   docker exec <container> node scripts/storage/scan-folder-filenames.js [blog-identifier] > scan.txt

const fs = require("fs");
const { join } = require("path");

const MAX_KEY_BYTES = 1024;

// Control characters (C0, DEL, C1), and Unicode line/paragraph separators.
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]");
const CONTROL_ALL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]", "g");
const SLASH_LIKE = /[\\⁄∕⧸／]/;
const DOT_ONLY = /^\.+$/;

const CATEGORIES = [
  "key-too-long",
  "invalid-utf8",
  "control-char",
  "edge-whitespace",
  "trailing-dot",
  "double-space",
  "dot-segment",
  "slash-like",
  "nfc-collision",
  "case-collision",
];

// ignoreBOM keeps a leading U+FEFF in the text instead of stripping it, since
// it is part of the name.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decode(buffer) {
  try {
    return decoder.decode(buffer);
  } catch (e) {
    return null;
  }
}

// Printable text for the report: control characters as \uXXXX, and for a name
// that is not valid UTF-8, every byte outside printable ASCII as \xNN.
function display(buffer) {
  const text = decode(buffer);

  if (text !== null) {
    return text.replace(
      CONTROL_ALL,
      (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")
    );
  }

  let out = "";

  for (const byte of buffer) {
    out +=
      byte >= 0x20 && byte < 0x7f
        ? String.fromCharCode(byte)
        : "\\x" + byte.toString(16).padStart(2, "0");
  }

  return out;
}

// Problems with one name on its own. `keyBytes` is the length in bytes of the
// whole key, which the caller works out. Returns an array of categories.
function classifyName(name, keyBytes) {
  const found = [];

  if (keyBytes > MAX_KEY_BYTES) found.push("key-too-long");

  const text = decode(name);

  if (text === null) {
    found.push("invalid-utf8");
    return found;
  }

  if (CONTROL.test(text)) found.push("control-char");
  if (/^\s|\s$/.test(text)) found.push("edge-whitespace");
  if (text.endsWith(".") && !DOT_ONLY.test(text)) found.push("trailing-dot");
  if (/\s\s/.test(text)) found.push("double-space");
  if (DOT_ONLY.test(text.trim())) found.push("dot-segment");
  if (SLASH_LIKE.test(text)) found.push("slash-like");

  return found;
}

// Problems between the names of one directory: pairs which differ only by
// normalisation or only by case. Takes the names (Buffers) and returns a Map
// of index into names -> array of categories.
function classifyDirectory(names) {
  const byNFC = new Map();
  const byLower = new Map();
  const found = new Map();

  names.forEach((name, i) => {
    const text = decode(name);

    if (text === null) return;

    const nfc = text.normalize("NFC");
    const lower = nfc.toLowerCase();

    if (!byNFC.has(nfc)) byNFC.set(nfc, []);
    byNFC.get(nfc).push(i);

    if (!byLower.has(lower)) byLower.set(lower, []);
    byLower.get(lower).push(i);
  });

  function add(i, category) {
    if (!found.has(i)) found.set(i, []);
    found.get(i).push(category);
  }

  for (const group of byNFC.values()) {
    if (group.length > 1) group.forEach((i) => add(i, "nfc-collision"));
  }

  // Names which are only NFC/NFD twins are already reported above; this is
  // for groups with more than one distinct NFC form.
  for (const [lower, group] of byLower) {
    const forms = new Set(group.map((i) => decode(names[i]).normalize("NFC")));

    if (forms.size > 1) group.forEach((i) => add(i, "case-collision"));
  }

  return found;
}

// path.join doesn't take Buffers, and a name which isn't valid UTF-8 can't go
// through a string without being altered.
function child(directory, name) {
  return Buffer.concat([Buffer.from(directory), Buffer.from("/"), name]);
}

// Walks one blog's folder, calling report(category, pathBuffer, isDirectory)
// for each problem, depth first, one directory at a time. `prefixBytes` is the
// length of "{blogID}/folder/".
async function scanFolder(root, prefixBytes, report) {
  async function visit(directory, relative) {
    const entries = [];
    const handle = await fs.promises.opendir(directory, { encoding: "buffer" });

    for await (const entry of handle) {
      let isDirectory = entry.isDirectory();
      let isSymlink = entry.isSymbolicLink();

      // Some filesystems don't say what an entry is without asking.
      if (!isDirectory && !isSymlink && !entry.isFile()) {
        try {
          const stat = await fs.promises.lstat(child(directory, entry.name));
          isDirectory = stat.isDirectory();
          isSymlink = stat.isSymbolicLink();
        } catch (e) {
          continue;
        }
      }

      entries.push({ name: entry.name, isDirectory, isSymlink });
    }

    const between = classifyDirectory(entries.map((e) => e.name));

    for (let i = 0; i < entries.length; i++) {
      const { name, isDirectory } = entries[i];
      const path = Buffer.concat([relative, Buffer.from("/"), name]);
      // A directory with files in it has no key of its own, but a file below
      // it does, and that is at least as long; the marker object adds a "/".
      const keyBytes = prefixBytes + path.length - 1 + (isDirectory ? 1 : 0);
      const categories = classifyName(name, keyBytes).concat(between.get(i) || []);

      for (const category of categories) {
        report(category, Buffer.concat([path, Buffer.from(isDirectory ? "/" : "")]));
      }
    }

    // Symlinks are not followed, and nothing below them is looked at.
    for (const entry of entries) {
      if (!entry.isDirectory || entry.isSymlink) continue;

      await visit(
        child(directory, entry.name),
        Buffer.concat([relative, Buffer.from("/"), entry.name])
      );
    }
  }

  await visit(root, Buffer.alloc(0));
}

module.exports = { classifyName, classifyDirectory, scanFolder, display, CATEGORIES };

if (require.main === module) {
  const identifier = process.argv[2];

  if (identifier && identifier.startsWith("--")) {
    console.error("Usage: node scripts/storage/scan-folder-filenames.js [blog-identifier]");
    process.exit(2);
  }

  const config = require("config");
  const Blog = require("models/blog");
  const folderRoot = require("storage/folder/s3").root;

  const counts = {};
  let blogs = 0;
  let failed = 0;

  function get(by) {
    return new Promise((resolve, reject) =>
      Blog.get(by, (err, blog) => (err ? reject(err) : resolve(blog)))
    );
  }

  // scripts/get/blog.js would also generate a login token, which writes to
  // Redis. Look the blog up by ID, ID prefix, handle, then domain instead.
  async function resolveBlog(identifier) {
    const text = identifier.trim().replace(/\/+$/, "");
    let blog = await get({ id: text });

    if (!blog) {
      const ids = await new Promise((resolve, reject) =>
        Blog.getAllIDs((err, ids) => (err ? reject(err) : resolve(ids)))
      );
      const id = ids.sort().find((id) => id.startsWith(text));
      if (id) blog = await get({ id });
    }

    if (!blog) blog = await get({ handle: text });

    if (!blog) {
      const host = text.toLowerCase().replace(/^[a-z][a-z\d+.-]*:\/\//, "").split("/")[0];
      blog = await get({ domain: host });
    }

    if (!blog) throw new Error("No blog: " + identifier);

    return blog.id;
  }

  async function blogIDs() {
    if (identifier) return [await resolveBlog(identifier)];

    return new Promise((resolve, reject) =>
      Blog.getAllIDs((err, ids) => (err ? reject(err) : resolve(ids.sort())))
    );
  }

  function write(text) {
    return new Promise((resolve) => process.stdout.write(text, resolve));
  }

  async function main() {
    for (const blogID of await blogIDs()) {
      const root = join(config.blog_folder_dir, blogID);
      const prefixBytes = Buffer.byteLength(folderRoot(blogID));

      blogs++;

      try {
        await scanFolder(root, prefixBytes, (category, path) => {
          counts[category] = (counts[category] || 0) + 1;
          console.log(`${blogID}\t${category}\t${display(path)}`);
        });
      } catch (err) {
        if (err.code === "ENOENT") continue;
        failed++;
        // Not err.message: filesystem errors put the full path in it.
        console.error(`${blogID}: failed: ${err.code || "unknown error"}`);
      }
    }

    let summary = `\nScanned ${blogs} blog${blogs === 1 ? "" : "s"}.\n`;

    for (const category of CATEGORIES) {
      summary += `${category}: ${counts[category] || 0}\n`;
    }

    if (failed) summary += `Blogs which could not be read: ${failed}.\n`;

    // Wait for stdout to flush: exiting straight after a write can truncate
    // a report piped to a file.
    await write(summary);
  }

  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err.code || err.message || "failed");
      process.exit(1);
    });
}

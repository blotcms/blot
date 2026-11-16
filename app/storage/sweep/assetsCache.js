const client = require("models/client");
const Keys = require("helper/transformer/keys");
const { remove } = require("./cache");

// The transformer cache (helper/transformer) entries that point into
// _assets/<hash>/ directories, which are deleted with the directory so the
// next build converts again rather than linking a directory that's gone (see
// ./cache, which does the same for the swept scopes; _assets is not swept, so
// its names are here).
//
// - "img-converter": build/converters/img, converted images;
// - "gdoc-images": build/converters/gdoc/images, a document's images.
//
// Read as ./cache does, with no SCAN: each name's keys are in its
// `everything` set and their values are read with MGET a batch at a time.
const NAMES = ["img-converter", "gdoc-images"];
const BATCH = 500;
const ASSET_DIRECTORY = /_assets\/([a-f0-9]{32})\//g;

// Deletes the cache entries (the content keys which name a directory in
// `hashes`, and the URL keys which point at them) of the blog, and resolves
// to how many keys it deleted. With no hashes it does nothing.
async function removePointingAt(blogID, hashes) {
  if (!hashes.size) return 0;

  let deleted = 0;

  for (const name of NAMES) {
    const keys = Keys(blogID, name);
    const prefix = keys.everything.slice(0, -"everything".length);
    const members = await client.sMembers(keys.everything);
    const doomed = new Set(); // content keys to delete
    const urls = []; // [url content key, the content key it points at]

    for (let i = 0; i < members.length; i += BATCH) {
      const batch = members.slice(i, i + BATCH);
      const got = await client.mGet(batch);

      batch.forEach((key, j) => {
        const value = got[j];
        const rest = key.startsWith(prefix) ? key.slice(prefix.length) : "";

        if (value === null || value === undefined) return;

        if (rest.startsWith("content:")) {
          const text = typeof value === "string" ? value : String(value);

          for (const match of text.matchAll(ASSET_DIRECTORY)) {
            if (hashes.has(match[1])) {
              doomed.add(key);
              break;
            }
          }
        } else if (rest.startsWith("url:content:")) {
          urls.push([key, prefix + "content:" + value]);
        }
      });
    }

    const entries = Array.from(doomed).map((key) => ({ name, key }));

    for (const [urlKey, contentKey] of urls) {
      if (!doomed.has(contentKey)) continue;

      entries.push(
        { name, key: urlKey },
        { name, key: prefix + "url:headers:" + urlKey.split(":").pop() }
      );
    }

    await remove(blogID, entries);
    deleted += entries.length;
  }

  return deleted;
}

module.exports = { removePointingAt, NAMES };

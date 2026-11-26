const client = require("models/client");
const Keys = require("helper/transformer/keys");
const { referencesIn } = require("./references");

// The transformer cache (helper/transformer) entries that point at generated
// directories, so that the sweep can delete them with the directory and find
// out whether a build has made the directory again.
//
// Only the names that write into the swept scopes (references.SCOPES):
// - "image-cache": build/plugins/image, into _image_cache;
// - "thumbnails": build/thumbnail, into _thumbnails.
// The other names are left alone: "img-converter" and "gdoc-images" write to
// _assets, which is never swept.
//
// Each name's keys are listed in its `everything` set, so there is no SCAN:
// the members are read with MGET, a batch at a time. A name's keys are
//   <prefix>:content:<hash>        JSON result of a transform; it names the
//                                  directories it made
//   <prefix>:url:content:<urlhash> the content hash a URL last gave
//   <prefix>:url:headers:<urlhash> the response headers it gave
// A URL pair belongs with the content key its hash points at.
const NAMES = ["image-cache", "thumbnails"];
const LEGACY = /blotcdn\.com|\/image-cache\/|\/thumbnails\/\d+\//;
const BATCH = 500;

// What the cache holds for a blog:
// - pointers: "<scope>/<id>" -> [{ name, key }], every key to delete with the
//   directory (the content key and the URL keys that point at it);
// - stale: [{ name, key }], members of an `everything` set with nothing
//   behind them (the value is gone), URL keys whose content is gone, and
//   legacy results (marked `legacy: true`) with their URL keys.
// Nothing is written.
async function read(blogID) {
  const pointers = new Map();
  const stale = [];

  for (const name of NAMES) {
    const keys = Keys(blogID, name);
    const prefix = keys.everything.slice(0, -"everything".length);
    const members = await client.sMembers(keys.everything);
    const values = new Map();

    for (let i = 0; i < members.length; i += BATCH) {
      const batch = members.slice(i, i + BATCH);
      const got = await client.mGet(batch);

      batch.forEach((key, j) => values.set(key, got[j]));
    }

    const contentKeys = new Map(); // content key -> its directories
    const urls = []; // [url content key, the content key it points at]
    const legacy = new Set(); // content keys that are legacy results

    for (const [key, value] of values) {
      const rest = key.startsWith(prefix) ? key.slice(prefix.length) : "";

      if (value === null || value === undefined) {
        stale.push({ name, key });
      } else if (rest.startsWith("content:")) {
        const dirs = referencesIn(value, new Set());

        // Results from before the _image_cache/_thumbnails layout, pointing
        // at the old CDN (blotcdn.com, which answers 403 now). Nothing can
        // use them: the image plugin reads `src`, which they lack, so a post
        // that hits one never gets its _image_cache copy, and thumbnails
        // would link them. Deleting them lets the next build make the files
        // properly.
        if (!dirs.size && LEGACY.test(String(value))) {
          legacy.add(key);
          stale.push({ name, key, legacy: true });
          continue;
        }

        contentKeys.set(key, dirs);

        for (const dir of dirs) add(pointers, dir, { name, key });
      } else if (rest.startsWith("url:content:")) {
        urls.push([key, prefix + "content:" + value]);
      }
    }

    for (const [urlKey, contentKey] of urls) {
      const headersKey = prefix + "url:headers:" + urlKey.split(":").pop();

      if (legacy.has(contentKey)) {
        stale.push(
          { name, key: urlKey, legacy: true },
          { name, key: headersKey, legacy: true }
        );
        continue;
      }

      if (!values.has(contentKey) || values.get(contentKey) === null) {
        // Its content has gone: the URL can't be used, and its headers would
        // make the next download ask for "not modified" with nothing to use
        stale.push({ name, key: urlKey }, { name, key: headersKey });
        continue;
      }

      for (const dir of contentKeys.get(contentKey) || []) {
        add(pointers, dir, { name, key: urlKey });
        add(pointers, dir, { name, key: headersKey });
      }
    }
  }

  return { pointers, stale };
}

function add(map, dir, entry) {
  if (!map.has(dir)) map.set(dir, []);
  map.get(dir).push(entry);
}

// Deletes the keys and takes them out of their `everything` sets, a batch per
// transaction
async function remove(blogID, entries) {
  const byName = new Map();

  for (const { name, key } of entries) {
    if (!byName.has(name)) byName.set(name, new Set());
    byName.get(name).add(key);
  }

  for (const [name, set] of byName) {
    const everything = Keys(blogID, name).everything;
    const keys = Array.from(set);

    for (let i = 0; i < keys.length; i += BATCH) {
      const batch = keys.slice(i, i + BATCH);

      await client.multi().del(batch).sRem(everything, batch).exec();
    }
  }
}

module.exports = { read, remove, NAMES };

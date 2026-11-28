// Rewrites entries stored with their HTML written out more than once in the
// compact form Entry.set now writes, where `body`, `teaser` and `teaserBody`
// are stored as a position in `html` or `teaser` when they repeat it
// (models/entry/codec, blotcms/blot#3014). Readers accept both forms, so the
// site works the same before, during and after a run; this only frees the
// memory sooner than rebuilds would.
//
// Safe to stop and re-run: an entry already compact is left as it is. Takes
// no lock. Each write is a compare-and-set against the exact value it read,
// so an entry saved by a build in between is left alone (that build already
// stored it compact). The TTL of a deleted entry is kept.
//
// --expand does the reverse, for a rollback past the release that taught
// Entry.get to read the compact form (#3023): releases before it read `body`
// and the teasers as stored. The script runs from the deployed release, and
// every unit keeps writing compact entries while the writer (#3024) is
// deployed, so roll back in this order:
//
//   1. Deploy a revert of the writer: nothing writes compact entries any
//      more, and every unit still reads them.
//   2. Run this script with --expand --apply.
//   3. Only then roll back past the reader.
//
// Dry run by default: reports how many entries would be rewritten and the
// bytes they take now and would take after. Pass --apply to write.
// Usage: node scripts/entry/compact-entries.js [blog-identifier] [--expand] [--apply]

const client = require("models/client");
const codec = require("models/entry/codec");
const getBlog = require("../get/blog");

// Replace the entry only if it is still exactly what was read
const SET_IF_UNCHANGED = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
  return 1
end
return 0
`;

// Keys per SCAN reply, and entries read per MGET: entries can be megabytes
const SCAN_COUNT = 1000;
const READ_BATCH = 20;

// blog:<id>:entry:<path>, not blog:<id>:tags:entry:<path> (sets)
const ENTRY_KEY = /^blog:[^:]+:entry:/;

async function pattern(identifier) {
  if (!identifier) return "blog:*:entry:*";

  const { blog } = await getBlog(identifier);

  if (!blog) throw new Error("No blog: " + identifier);

  return "blog:" + blog.id + ":entry:*";
}

// Resolves to the totals of a run over every entry, or one blog's
async function run({ apply = false, expand = false, identifier } = {}) {
  const totals = {
    entries: 0,
    rewritten: 0,
    written: 0,
    changed: 0,
    unreadable: 0,
    bytesBefore: 0,
    bytesAfter: 0,
  };

  // The value to store instead, or null if the stored one is already right
  function replacementFor(key, value) {
    let entry;

    try {
      entry = codec.decode(value);
    } catch (err) {
      totals.unreadable++;
      console.error("Unreadable entry, left as it is:", key);
      return null;
    }

    const replacement = expand ? JSON.stringify(entry) : codec.encode(entry);

    if (replacement === value) return null;

    if (JSON.stringify(codec.decode(replacement)) !== JSON.stringify(entry)) {
      throw new Error("Rewritten entry does not read back the same: " + key);
    }

    return replacement;
  }

  async function rewriteBatch(keys) {
    const values = await client.mGet(keys);

    for (let i = 0; i < keys.length; i++) {
      const value = values[i];

      // Deleted (expired) since the scan
      if (!value) continue;

      const replacement = replacementFor(keys[i], value);

      if (replacement === null) continue;

      totals.rewritten++;
      totals.bytesBefore += Buffer.byteLength(value);
      totals.bytesAfter += Buffer.byteLength(replacement);

      if (!apply) continue;

      const written = await client.eval(SET_IF_UNCHANGED, {
        keys: [keys[i]],
        arguments: [value, replacement],
      });

      if (written) totals.written++;
      else totals.changed++;
    }
  }

  function report() {
    const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + "MB";
    console.log(
      `Entries: ${totals.entries}.`,
      `To rewrite: ${totals.rewritten} (${mb(totals.bytesBefore)} now, ${mb(
        totals.bytesAfter
      )} after).`,
      apply ? `Written: ${totals.written}.` : "",
      totals.changed ? `Changed underneath: ${totals.changed}.` : "",
      totals.unreadable ? `Unreadable: ${totals.unreadable}.` : ""
    );
  }

  console.log(
    (expand ? "Expanding entries" : "Compacting entries") +
      (apply ? "" : ": dry run (pass --apply to write)")
  );

  let scanned = 0;

  for await (const keys of client.scanIterator({
    MATCH: await pattern(identifier),
    COUNT: SCAN_COUNT,
    TYPE: "string",
  })) {
    const entryKeys = keys.filter((key) => ENTRY_KEY.test(key));

    totals.entries += entryKeys.length;

    for (let i = 0; i < entryKeys.length; i += READ_BATCH) {
      await rewriteBatch(entryKeys.slice(i, i + READ_BATCH));
      // Let the heap reclaim the batch's values before the next is read
      await new Promise(setImmediate);
    }

    scanned += keys.length;
    if (scanned % 100000 < keys.length) report();
  }

  report();

  return totals;
}

module.exports = run;

if (require.main === module) {
  const args = process.argv.slice(2);

  run({
    apply: args.includes("--apply"),
    expand: args.includes("--expand"),
    identifier: args.find((arg) => !arg.startsWith("--")),
  }).then(
    (totals) => process.exit(totals.unreadable ? 1 : 0),
    (err) => {
      console.error(err);
      process.exit(1);
    }
  );
}

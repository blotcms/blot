// Compresses the source of every template view stored as written (the content
// field of a view hash) into contentBr, the form app/models/template/util/
// viewContent describes. Run once getView reads both forms on every unit.
//
// Safe to stop and re-run: a view already compressed, or too short to be, is
// skipped. Each write replaces content only if it is still exactly what was
// read (compared by SHA-1 in a short script), so a save in between is never
// overwritten; the save's own source is kept as written.
//
// --revert does the opposite, writing every compressed source back as
// written: run it before deploying code older than the reader.
//
// Dry run by default. Pass --apply to write.
// Usage: node scripts/template/compress-views.js [--apply] [--revert]

const crypto = require("crypto");
const zlib = require("zlib");
const { promisify } = require("util");
const { RESP_TYPES } = require("redis");
const client = require("models/client");
const viewContent = require("models/template/util/viewContent");

const brotliDecompress = promisify(zlib.brotliDecompress);

// Moves the source from one field to the other if the first still holds
// exactly the bytes read: KEYS[1] the view, ARGV[1] the field to move from,
// ARGV[2] its SHA-1, ARGV[3] the field to move to, ARGV[4] its new value
const MOVE_IF_UNCHANGED = `
local value = redis.call('HGET', KEYS[1], ARGV[1])
if value and redis.sha1hex(value) == ARGV[2] then
  redis.call('HSET', KEYS[1], ARGV[3], ARGV[4])
  redis.call('HDEL', KEYS[1], ARGV[1])
  return 1
end
return 0
`;

function newTotals() {
  return {
    views: 0,
    skipped: 0,
    moved: 0,
    changed: 0,
    bytesBefore: 0,
    bytesAfter: 0,
  };
}

// Compresses one view, or with options.revert writes it back as written.
// Only reports what it would do unless options.apply. Adds to totals.
async function processView(viewKey, options, totals) {
  const from = options.revert ? viewContent.FIELD : "content";
  const to = options.revert ? "content" : viewContent.FIELD;

  totals.views++;

  // Read as Buffers, as getView does (see util/viewContent)
  const value = await client
    .withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer })
    .hGet(viewKey, from);

  if (!value) return totals.skipped++;

  const next = options.revert
    ? await brotliDecompress(value)
    : await viewContent.pack(value.toString("utf8"));

  if (!next) return totals.skipped++;

  totals.bytesBefore += value.length;
  totals.bytesAfter += next.length;

  if (!options.apply) return totals.moved++;

  const moved = await client.eval(MOVE_IF_UNCHANGED, {
    keys: [viewKey],
    arguments: [
      from,
      crypto.createHash("sha1").update(value).digest("hex"),
      to,
      next,
    ],
  });

  if (moved) totals.moved++;
  else totals.changed++;
}

async function main(options) {
  const totals = newTotals();

  console.log(
    (options.apply ? "Applying: " : "Dry run: ") +
      (options.revert
        ? "writing compressed views back as written"
        : "compressing views")
  );

  for await (const keys of client.scanIterator({
    MATCH: "template:*:view:*",
    TYPE: "hash",
    COUNT: 1000,
  })) {
    for (const viewKey of keys) await processView(viewKey, options, totals);

    if (totals.views % 10000 < keys.length) console.log(JSON.stringify(totals));
  }

  console.log(JSON.stringify(totals));
  console.log(
    options.revert ? "Written back:" : "Compressed:",
    totals.moved,
    "views; source bytes",
    totals.bytesBefore,
    "->",
    totals.bytesAfter,
    totals.changed
      ? "; " + totals.changed + " saved meanwhile, left as they are"
      : ""
  );

  return totals;
}

if (require.main === module) {
  const args = process.argv.slice(2);

  main({ apply: args.includes("--apply"), revert: args.includes("--revert") })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { main, processView, newTotals };

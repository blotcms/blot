// Reads many byte ranges of one object with as few round trips as it can:
// ranges which are close together are merged into one read, and the merged
// reads run in parallel with a limit.
//
// This is what makes reading objects out of S3 viable: stock git asks for one
// object at a time, while the callers here know all the ranges they want up
// front (an index bucket, the entries of a tree walk, the objects of a push).
const { mapLimit } = require("./limit");

// Two ranges with at most this many unwanted bytes between them are read as
// one. Over S3 a round trip costs far more than 64 KB of transfer.
const MAX_GAP = 64 * 1024;

// A merged read is never longer than this, so memory per read is bounded
const MAX_READ = 8 * 1024 * 1024;

const CONCURRENCY = 8;

// Merges {offset, length} ranges into the reads to make: sorted, with each
// holding the indexes of the requested ranges it covers.
function plan(ranges, { maxGap = MAX_GAP, maxRead = MAX_READ } = {}) {
  const order = ranges
    .map((range, index) => ({ ...range, index }))
    .filter((range) => range.length > 0)
    .sort((a, b) => a.offset - b.offset);

  const reads = [];
  for (const range of order) {
    const last = reads[reads.length - 1];
    const end = range.offset + range.length;

    if (last && range.offset - last.end <= maxGap && Math.max(end, last.end) - last.offset <= maxRead) {
      last.end = Math.max(end, last.end);
      last.members.push(range);
    } else {
      reads.push({ offset: range.offset, end, members: [range] });
    }
  }

  return reads;
}

// Returns one Buffer per requested range, in order. A range running past the
// end of the object comes back short. The total length of the ranges is the
// caller's to bound; no more than concurrency * maxRead bytes are in flight.
async function readRanges(store, key, ranges, options = {}) {
  const { concurrency = CONCURRENCY } = options;
  const results = ranges.map(() => Buffer.alloc(0));
  const reads = plan(ranges, options);

  await mapLimit(reads, concurrency, async (read) => {
    const buffer = await store.read(key, read.offset, read.end - read.offset);
    for (const member of read.members) {
      const start = member.offset - read.offset;
      results[member.index] = buffer.subarray(start, start + member.length);
    }
  });

  return results;
}

module.exports = { readRanges, plan };

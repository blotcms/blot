// Count-only tag lists are placeholder arrays used solely for `.length`.
// Tags.list fills them with null (`new Array(count).fill(null)`);
// Tags.popular uses `Array.from({ length: count })`, which is dense
// undefined. Compact both forms to a scalar so the LRU does not retain
// (or size-charge) one slot per post.
function isCountOnlyEntries(entries) {
  return Array.isArray(entries) && entries.every((id) => id == null);
}

function compactTags(tags) {
  return tags.map((tag) => {
    if (!isCountOnlyEntries(tag.entries)) return tag;
    const { entries, ...rest } = tag;
    return { ...rest, entryCount: entries.length };
  });
}

function expandTags(tags) {
  return tags.map((tag) => {
    if (!Object.prototype.hasOwnProperty.call(tag, "entryCount")) return tag;
    const { entryCount, ...rest } = tag;
    return { ...rest, entries: new Array(entryCount).fill(null) };
  });
}

module.exports = { compactTags, expandTags };

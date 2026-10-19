// Containers handed out by augmentedEntries.shareEntries: frozen, already
// augmented and already given first/last/position when the cache was
// filled, and shared by every request on the same host. eachEntry skips
// them rather than walking the whole catalog again on every render.
// Its own module so eachEntry can read it without requiring
// augmentedEntries, which requires eachEntry.
const shared = new WeakSet();

module.exports = {
  add: (value) => shared.add(value),
  has: (value) => !!value && typeof value === "object" && shared.has(value),
};

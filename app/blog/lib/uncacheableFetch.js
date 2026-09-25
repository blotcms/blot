// A cache's fetchMethod signals "don't persist this" by returning undefined
// - but lru-cache then resolves every coalesced cache.fetch() call to
// undefined too, which would throw away the real value each caller needs
// (e.g. a genuinely empty result we don't want to poison the cache with,
// but still have to render). Throwing this instead rejects cache.fetch()
// for the fetchMethod call and every request coalesced onto it, without
// writing anything to the cache; each catch block unwraps .payload to get
// the real value back. See recent_entries.js, latest_entry.js, tagged.js.
class Uncacheable extends Error {
  constructor(payload) {
    super("uncacheable fetch result");
    this.payload = payload;
  }
}

module.exports = { Uncacheable };

var Mustache = require("mustache");
var LRUCache = require("lru-cache").LRUCache;
var ensure = require("helper/ensure");

var ERROR = require("./error");
var OVERFLOW = "Maximum call stack size exceeded";

// Mustache's default templateCache is a plain object keyed on the full
// template string, with no eviction. Swap in a bounded LRU cache (same
// get/set/clear interface Mustache expects) so repeated renders of view
// templates still hit the cache, but one-off strings eventually fall out
// instead of growing without bound for the lifetime of the process.
// See https://github.com/blotcms/blot/issues/1851
Mustache.templateCache = new LRUCache({
  max: 500,
  maxSize: 5 * 1024 * 1024,
  sizeCalculation: function (tokens) {
    return JSON.stringify(tokens).length;
  },
});

// This function basically wraps mustache
// and gives me some nice error messages...
module.exports = function render(content, locals, partials) {
  ensure(content, "string").and(locals, "object").and(partials, "object");

  var output;

  try {
    output = Mustache.render(content, locals, partials);
  } catch (e) {
    if (e.message === OVERFLOW) {
      throw ERROR.INFINITE();
    } else if (e.message.indexOf("Unclosed tag") === 0) {
      throw ERROR.UNCLOSED();
    } else {
      throw ERROR();
    }
  }

  return output;
};

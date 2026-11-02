const { getTotal } = require("../../lib/models");
const asRetriever = require("../../lib/asRetriever");

// One ZCARD, so not worth a cache
async function totalPosts(req, res) {
  return getTotal(req.blog.id);
}

module.exports = asRetriever(totalPosts);

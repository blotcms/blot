const { getTotal } = require("../../lib/models");
const asRetriever = require("../../lib/asRetriever");

async function totalPosts(req, res) {
  return getTotal(req.blog.id);
};

module.exports = asRetriever(totalPosts);

var url = require("url");
var moment = require("moment");

module.exports = function (item) {
  return function (callback) {
    var entry = {};

    entry.draft =
      item["wp:status"][0] === "draft" ||
      item["wp:status"][0] === "private" ||
      item["wp:status"][0] === "pending";

    entry.page = item["wp:post_type"][0] === "page";

    entry.permalink = url.parse(item.link[0]).path;

    entry.html = item["content:encoded"][0];

    entry.title = item.title[0].trim();

    entry.dateStamp =
      entry.created =
      entry.updated =
        moment(item.pubdate[0]).valueOf();

    if (item.category) {
      entry.tags = item.category.map(function (category) {
        return category._;
      });
    }

    callback(null, entry);
  };
};

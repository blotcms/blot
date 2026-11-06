const makeSlug = require("helper/makeSlug");

module.exports = ($) => {
  $("h2:not(h1 + h2),h3").each((i, el) => {
    const text = $(el).text();
    const id = $(el).attr("id") || makeSlug(text);
    $(el).attr("id", id || makeSlug(text));
    const innerHTML = $(el).html();
    // if the heading already contains a link, don't add another
    if ($(el).find("a").length === 0) {
      $(el).html(`<a href="#${id}">${innerHTML}</a>`);
    }
  });
};

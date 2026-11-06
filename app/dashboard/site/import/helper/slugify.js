module.exports = function slugify(str) {
  var slug;

  slug = str.trim();
  slug = slug.split("  ").join(" ").split(" ").join("-");
  slug = slug.replace(/&amp;|&/g, "and");
  slug = slug.replace(/’|'|,|\.|"|”|“|#|\?|:|!/g, "");
  slug = slug.replace(/--/g, "-");

  return slug;
};

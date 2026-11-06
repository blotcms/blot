module.exports = function (req, res, next) {
  res.locals.breadcrumbs = new Breadcrumbs();
  next();
};

function Breadcrumbs() {
  var list = [];

  // slug is relative to the previous crumb's URL, unless it starts with "/"
  list.add = function (label, slug = label.toLowerCase()) {
    var base = "/";

    if (list.length) base = list[list.length - 1].url;

    var url = slug.startsWith("/") ? slug : require("path").join(base, slug);

    list.push({ label: label, url: url });

    for (var i = 0; i < list.length; i++) {
      list[i].first = i === 0;
      list[i].last = i === list.length - 1;
      list[i].only = i === 0 && list.length === 1;
    }
  };

  return list;
}

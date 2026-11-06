module.exports = function (req, res, next) {
  res.locals.breadcrumbs = new Breadcrumbs();
  next();
};

function Breadcrumbs() {
  var list = [];

  list.add = function (label, slug = label.toLowerCase()) {
    var base = "/";

    if (list.length) base = list[list.length - 1].url;

    list.push({ label: label, url: require("path").join(base, slug) });

    for (var i = 0; i < list.length; i++) {
      list[i].first = i === 0;
      list[i].last = i === list.length - 1;
      list[i].only = i === 0 && list.length === 1;
    }
  };

  return list;
}

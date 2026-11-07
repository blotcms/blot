var Redirects = require("models/redirects");
var formJSON = require("helper/formJSON");
var arrayify = require("helper/arrayify");

const normalize = (redirect) => {
  redirect = redirect.trim();

  // apple -> /apple
  if (redirect.indexOf("/") === -1) redirect = "/" + redirect;

  // lacks protocol
  // foo/bar -> /foo/bar
  if (redirect.indexOf("://") === -1 && redirect[0] !== "/")
    redirect = "/" + redirect;

  return redirect;
};

module.exports = async function (req, res, next) {
  if (!req.body.has_redirects) return next();

  var mappings = formJSON(req.body, { redirects: "object" });

  mappings = arrayify(mappings.redirects)
    .filter((mapping) => !!mapping.from && !!mapping.to)

    .map(({ from, to }) => {
      return { from: normalize(from), to: normalize(to) };
    });

  try {
    await Redirects.set(req.blog.id, mappings);
  } catch (err) {
    return next(err);
  }

  next();
};

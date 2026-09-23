const cleanupFiles = require("./cleanup-files");
const { isAjaxRequest } = require("./ajax-response");

const first = (files) => Array.isArray(files && files.image)
  ? files.image[0]
  : files && files.image;

module.exports = async function preflightImage(req, res, next) {
  const declaration = (res.locals.images || []).find(
    (item) => item.key === req.params.key
  );

  if (!declaration) {
    await cleanupFiles(req.files);
    const error = new Error("Unknown image setting");
    error.status = 404;
    return next(error);
  }

  const old = req.template.locals[declaration.key];
  const file = first(req.files);
  const remove = req.body.remove === "1";

  // Do not fork a SITE template for a request that cannot change anything.
  if (!remove && (!file || !file.size)) {
    await cleanupFiles(req.files);
    return isAjaxRequest(req)
      ? res.json({ image: old || null })
      : res.message(
        req.body.redirect || res.locals.base,
        old && old.url ? "No changes" : "Choose an image"
      );
  }

  return next();
};

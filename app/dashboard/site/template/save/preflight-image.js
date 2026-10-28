const cleanupFiles = require("./cleanup-files");
const { isAjaxRequest } = require("./ajax-response");
const { validate, normalizeShape } = require("../../../../build/thumbnail/template-image");

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
  const updateMask = req.body.update_mask === "1" && declaration.key === "profile_image" && (!file || !file.size);

  if (!remove && updateMask) {
    if (!old || !old.url) {
      await cleanupFiles(req.files);
      const error = new Error("Upload a profile photo before changing its shape");
      error.status = 400;
      return next(error);
    }

    try {
      normalizeShape(req.body.photo_shape);
    } catch (error) {
      await cleanupFiles(req.files);
      return next(error);
    }

    return next();
  }

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

  if (!remove && file && file.size) {
    try {
      await validate(file.path, {
        x: req.body.crop_x,
        y: req.body.crop_y,
        width: req.body.crop_width,
        height: req.body.crop_height,
      }, req.body.photo_shape);
    } catch (error) {
      await cleanupFiles(req.files);
      return next(error);
    }
  }

  return next();
};

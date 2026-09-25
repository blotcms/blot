const desnake = require("./util/desnake");

module.exports = function imageInputs(req, res, next) {
  const locals = req.template.locals || {};
  const images = Object.keys(locals)
    .filter((key) => key.endsWith("_image"))
    .map((key) => ({
      key,
      value: locals[key] && locals[key].url ? locals[key] : null,
      label: desnake(key.slice(0, -"_image".length)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  res.locals.images = images;
  res.locals.profile_image_control =
    images.find((image) => image.key === "profile_image") || null;
  res.locals.other_images = images.filter(
    (image) => image.key !== "profile_image"
  );
  next();
};

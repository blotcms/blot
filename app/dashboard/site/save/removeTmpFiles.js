var fs = require("fs-extra");
module.exports = async function (req, res, next) {
  try {
    if (!req.files) return next();

    // req.files is multiparty's { field: [file, ...] } map (or a single
    // file for avatar); Object.values matches what async.each iterated
    await Promise.all(
      Object.values(req.files).map((file) => fs.remove(file.path))
    );

    next();
  } catch (err) {
    next(err);
  }
};

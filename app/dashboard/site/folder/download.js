const { basename } = require("path");
const folder = require("storage/folder");

module.exports = async (req, res, next) => {
  let file;

  try {
    file = req.params.path.normalize("NFC");
  } catch (e) {
    return res.status(404).send("Error downloading file");
  }

  try {
    // Dotfiles stay hidden, as they were when this called res.sendFile
    await folder.serve(req, res, req.blog.id, file, {
      dotfiles: "ignore",
      headers: {
        "Content-disposition":
          "attachment; filename=" + encodeURIComponent(basename(file)),
      },
    });
  } catch (e) {
    next(e);
  }
};

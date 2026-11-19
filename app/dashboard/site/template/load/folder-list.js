const folderRoot = require("./util/folder-root");

// GET /:templateSlug/folders?path=/Posts answers { path, exists,
// directories } for the folder picker: the normalised path, whether it is a
// directory in the blog's folder, and the names of the directories directly
// inside it. One level a request, so a large folder is never read whole.
module.exports = async function folderList(req, res, next) {
  try {
    const path = folderRoot.normalize(
      typeof req.query.path === "string" ? req.query.path : "/"
    );

    res.set("Cache-Control", "no-store");

    if (path === null) {
      return res.status(400).json({ error: "A folder can't contain .." });
    }

    const found = await folderRoot.find(req.blog.id, path);

    res.json({
      path,
      exists: found !== null,
      directories:
        found === null ? [] : await folderRoot.directories(req.blog.id, found),
    });
  } catch (err) {
    next(err);
  }
};

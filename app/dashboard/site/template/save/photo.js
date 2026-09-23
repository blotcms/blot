const fs = require("fs-extra");
const Blog = require("models/blog");
const saveAvatar = require("dashboard/site/save/avatar");
const uploadFavicon = require("./upload-favicon");

const setBlog = (id, updates) => new Promise((resolve, reject) => {
  Blog.set(id, updates, (error) => error ? reject(error) : resolve());
});

const runAvatar = (req, res) => new Promise((resolve, reject) => {
  saveAvatar(req, res, (error) => error ? reject(error) : resolve());
});

module.exports = async function savePhoto(req, res, next) {
  const uploaded = req.files && (Array.isArray(req.files.avatar) ? req.files.avatar[0] : req.files.avatar);
  const previousAvatar = req.blog.avatar || "";
  const wantsFavicon = req.body.use_favicon === "1" && res.locals.favicon_supported && uploaded && uploaded.size;

  req.updates = {};
  req.preserveAvatarUpload = Boolean(wantsFavicon);

  try {
    if (uploaded && uploaded.size) await runAvatar(req, res);
    else if (Object.prototype.hasOwnProperty.call(req.body, "avatar") && req.body.avatar === "") req.updates.avatar = "";

    if (Object.prototype.hasOwnProperty.call(req.updates, "avatar")) {
      await setBlog(req.blog.id, { avatar: req.updates.avatar });
      req.blog.avatar = req.updates.avatar;
      if (res.locals.blog) res.locals.blog.avatar = req.updates.avatar;
    }

    if (wantsFavicon) {
      req.files = { favicon: uploaded };
      req.query = { ...req.query, ajax: "1" };
      let faviconError;
      await uploadFavicon(req, { json() {} }, (error) => { faviconError = error; });
      if (faviconError) throw faviconError;
      res.locals.favicon = req.template.locals.favicon;
    } else if (uploaded) {
      await fs.remove(uploaded.path);
    }

    return res.message(res.locals.base, wantsFavicon ? "Saved photo and favicon!" : "Saved photo!");
  } catch (error) {
    // Do not leave a new avatar behind, or expose it in the blog, if the
    // optional favicon half of the combined operation fails.
    if (req.savedAvatarPath) await fs.remove(req.savedAvatarPath).catch(() => {});
    if (req.blog.avatar !== previousAvatar) {
      await setBlog(req.blog.id, { avatar: previousAvatar }).catch(() => {});
      req.blog.avatar = previousAvatar;
    }
    if (uploaded) await fs.remove(uploaded.path).catch(() => {});
    return next(error);
  }
};

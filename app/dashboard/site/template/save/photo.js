const fs = require("fs-extra");
const Blog = require("models/blog");
const Template = require("models/template");
const saveAvatar = require("dashboard/site/save/avatar");
const forkIfNeeded = require("./fork-if-needed");
const cleanupFiles = require("./cleanup-files");
const { createFavicon } = require("./upload-favicon");

const setBlog = (id, updates) => new Promise((resolve, reject) => {
  Blog.set(id, updates, (error) => error ? reject(error) : resolve());
});

const runAvatar = (req, res) => new Promise((resolve, reject) => {
  saveAvatar(req, res, (error) => error ? reject(error) : resolve());
});

const runForkIfNeeded = (req, res) => new Promise((resolve, reject) => {
  forkIfNeeded(req, res, (error) => error ? reject(error) : resolve());
});

const removeTemplateFromFolder = (blogID, templateID) => new Promise((resolve, reject) => {
  Template.removeFromFolder(blogID, templateID, (error) => error ? reject(error) : resolve());
});

const dropTemplate = (blogID, templateSlug) => new Promise((resolve, reject) => {
  Template.drop(blogID, templateSlug, (error) => error ? reject(error) : resolve());
});

async function rollbackFork(req, res) {
  const fork = req.templateFork;
  if (!fork || !fork.template) return;

  // Restore the installed template before deleting the copy. If restoration
  // fails, leave the fork in place so the site's selected template still exists.
  if (fork.restoreBlogTemplate) {
    await setBlog(req.blog.id, { template: fork.originalBlogTemplate });
    req.blog.template = fork.originalBlogTemplate;
  }

  await removeTemplateFromFolder(req.blog.id, fork.template.id);
  await dropTemplate(req.blog.id, fork.template.id.split(":").slice(1).join(":"));
  req.template = res.locals.template = fork.originalTemplate;
  res.locals.templateForked = false;
  req.templateFork = null;
}

function updateAvatarLocals(req, res, avatar) {
  req.blog.avatar = avatar;
  if (res.locals.blog) res.locals.blog.avatar = avatar;
}

module.exports = async function savePhoto(req, res, next) {
  const uploaded = req.files && (Array.isArray(req.files.avatar) ? req.files.avatar[0] : req.files.avatar);
  const previousAvatar = req.blog.avatar || "";
  const hasUpload = Boolean(uploaded && uploaded.size);
  const hasFavicon = Boolean(req.template.locals && req.template.locals.favicon);
  const canSaveFavicon = Boolean(res.locals.favicon_supported && hasUpload);
  // New favicons are generated automatically from the center square crop of
  // the uploaded photo. Replacing an existing favicon remains opt-in.
  const wantsFavicon = canSaveFavicon && (!hasFavicon || req.body.use_favicon === "1");
  let photoPath = `${req.baseUrl}/${req.params.templateSlug}/photo`;
  let avatarWriteStarted = false;
  let avatarChanged = false;

  req.updates = {};
  req.preserveAvatarUpload = wantsFavicon;

  try {
    if (hasUpload) await runAvatar(req, res);
    else if (Object.prototype.hasOwnProperty.call(req.body, "avatar") && req.body.avatar === "") req.updates.avatar = "";

    if (Object.prototype.hasOwnProperty.call(req.updates, "avatar") && req.updates.avatar !== previousAvatar) {
      avatarWriteStarted = true;
      await setBlog(req.blog.id, { avatar: req.updates.avatar });
      updateAvatarLocals(req, res, req.updates.avatar);
      avatarChanged = true;
    }

    if (wantsFavicon) {
      try {
        // Validate and save the photo first. A later favicon failure should be
        // shown to the user without discarding the photo they chose to save.
        await runForkIfNeeded(req, res);
        const faviconTemplateSlug = req.templateFork
          ? req.template.id.split(":").slice(1).join(":")
          : req.params.templateSlug;
        res.locals.favicon = await createFavicon(
          req.blog,
          req.template,
          faviconTemplateSlug,
          uploaded.path,
          { x: req.body.crop_x, y: req.body.crop_y, size: req.body.crop_size },
          { onFileProcessed: () => cleanupFiles({ favicon: uploaded }) }
        );
        if (req.templateFork) photoPath = `${req.baseUrl}/${faviconTemplateSlug}/photo`;
      } catch (error) {
        try {
          await rollbackFork(req, res);
        } catch (rollbackError) {
          rollbackError.message = `${error.message}; also failed to restore the template: ${rollbackError.message}`;
          error = rollbackError;
        }
        if (uploaded) await fs.remove(uploaded.path).catch(() => {});
        error.message = `Your photo was saved, but the favicon could not be created: ${error.message}`;
        return next(error);
      }
    } else if (uploaded) {
      await fs.remove(uploaded.path);
    }

    const message = wantsFavicon
      ? "Saved photo and favicon!"
      : avatarChanged
        ? (req.updates.avatar ? "Saved photo!" : "Removed photo!")
        : "No changes";
    return res.message(photoPath, message);
  } catch (error) {
    let finalError = error;

    if (req.templateFork) {
      try {
        await rollbackFork(req, res);
      } catch (rollbackError) {
        rollbackError.message = `${error.message}; also failed to restore the template: ${rollbackError.message}`;
        finalError = rollbackError;
      }
    }

    let avatarRestored = true;
    if (avatarWriteStarted && !avatarChanged) {
      try {
        await setBlog(req.blog.id, { avatar: previousAvatar });
        updateAvatarLocals(req, res, previousAvatar);
      } catch (rollbackError) {
        avatarRestored = false;
        rollbackError.message = `${error.message}; also failed to restore the previous photo: ${rollbackError.message}`;
        finalError = rollbackError;
      }
    }

    // Keep the new file if the database could not be restored; the stored URL
    // may still point at it. Otherwise it is safe to discard the failed upload.
    if (!avatarChanged && avatarRestored && req.savedAvatarPath) {
      await fs.remove(req.savedAvatarPath).catch(() => {});
    }
    if (uploaded) await fs.remove(uploaded.path).catch(() => {});
    return next(finalError);
  }
};

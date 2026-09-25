const fs = require("fs-extra");
const { join, extname } = require("path");
const { v4: uuid } = require("uuid");
const config = require("config");
const Template = require("models/template");
const { isAjaxRequest } = require("./ajax-response");
const cleanupFiles = require("./cleanup-files");

const firstFile = (files = {}) => {
  for (const key of Object.keys(files)) {
    const list = files[key];
    if (Array.isArray(list) && list.length) {
      return list[0];
    }
  }
  return null;
};

const updateTemplate = (blogID, templateSlug, locals) =>
  new Promise((resolve, reject) => {
    Template.update(blogID, templateSlug, { locals }, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });

module.exports = async (req, res, next) => {
  const key = req.params.key;
  const files = req.files || {};

  // Always clean up uploaded files, even on validation errors
  if (!key || !/_url$/i.test(key)) {
    await cleanupFiles(files);
    return res.status(400).json({ error: "Invalid upload key" });
  }

  if (
    !req.template.locals ||
    !Object.prototype.hasOwnProperty.call(req.template.locals, key)
  ) {
    await cleanupFiles(files);
    return res.status(400).json({ error: "Unknown template field" });
  }

  if (!req.body._url || req.body._url !== key) {
    await cleanupFiles(files);
    return res.status(400).json({ error: "Mismatched upload key" });
  }

  // Check if delete button was clicked (submit button with name="upload" and empty value)
  const isDelete = req.body.upload === "" && (!req.files || !req.files.upload);

  const file = firstFile(files);

  // Handle clearing (delete button clicked or no file uploaded)
  if (isDelete || !file || !file.size) {
    await cleanupFiles(files);
    req.template.locals[key] = "";

    try {
      await updateTemplate(
        req.blog.id,
        req.template.slug,
        req.template.locals
      );
    } catch (err) {
      return next(err);
    }
    res.locals.template = req.template;

    if (isAjaxRequest(req)) {
      return res.json({ url: "", key });
    }

    const redirect = req.body.redirect || req.baseUrl + req.url;
    return res.message(redirect, "Removed file");
  }

  const subdir = req.blog.id + "/_template_assets";
  const templateDir = join(config.blog_static_files_dir, subdir);
  const extension = extname(file.originalFilename || file.path).toLowerCase();
  const filename = `${uuid()}${extension}`;
  const finalPath = join(templateDir, filename);

  try {
    await fs.ensureDir(templateDir);
    await fs.move(file.path, finalPath, { overwrite: true });
    await cleanupFiles(files);
  } catch (err) {
    await cleanupFiles(files);
    return next(err);
  }

  const cdnUrl =
    `${config.cdn.origin}/${subdir}/` + encodeURIComponent(filename);

  req.template.locals[key] = cdnUrl;

  try {
    await updateTemplate(
      req.blog.id,
      req.template.slug,
      req.template.locals
    );
  } catch (err) {
    await fs.remove(finalPath).catch(() => {});
    return next(err);
  }
  res.locals.template = req.template;

  if (isAjaxRequest(req)) {
    return res.json({ url: cdnUrl, key });
  }

  const redirect = req.body.redirect || req.baseUrl + req.url;
  return res.message(redirect, "Uploaded file");
};

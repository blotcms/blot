const { extname } = require("path");
const { v4: uuid } = require("uuid");
const assets = require("storage/assets");
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
        req.params.templateSlug,
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

  const extension = extname(file.originalFilename || file.path).toLowerCase();
  const filename = `${uuid()}${extension}`;
  const assetPath = `_template_assets/${filename}`;

  try {
    await assets.writeFrom(req.blog.id, assetPath, file.path, {
      move: true,
      overwrite: true,
    });
    await cleanupFiles(files);
  } catch (err) {
    await cleanupFiles(files);
    return next(err);
  }

  const cdnUrl = assets.url(
    req.blog.id,
    `_template_assets/${encodeURIComponent(filename)}`
  );

  req.template.locals[key] = cdnUrl;

  try {
    await updateTemplate(
      req.blog.id,
      req.params.templateSlug,
      req.template.locals
    );
  } catch (err) {
    await assets.remove(req.blog.id, assetPath).catch(() => {});
    return next(err);
  }
  res.locals.template = req.template;

  if (isAjaxRequest(req)) {
    return res.json({ url: cdnUrl, key });
  }

  const redirect = req.body.redirect || req.baseUrl + req.url;
  return res.message(redirect, "Uploaded file");
};

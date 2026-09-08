const fs = require("fs-extra");
const { join } = require("path");
const config = require("config");
const Template = require("models/template");
const clfdate = require("helper/clfdate");
const cleanupFiles = require("./cleanup-files");
const writeChangeToFolder = require("./writeChangeToFolder");
const { isAjaxRequest } = require("./ajax-response");
const { generate, PNG_SIZES } = require("./favicon-assets");

const faviconDirectory = (blog) => join(config.blog_static_files_dir, blog.id, "_template_assets");
const faviconURL = (blog, filename) => `${config.cdn.origin}/${blog.id}/_template_assets/${encodeURIComponent(filename)}`;

function firstFile(files = {}) {
  const list = files.favicon;
  return Array.isArray(list) ? list[0] : list;
}

function assetPaths(blog, favicon) {
  if (!favicon || !favicon.prefix || !/^favicon-[a-f0-9-]+$/.test(favicon.prefix)) return [];
  const dir = faviconDirectory(blog);
  return [
    join(dir, `${favicon.prefix}.ico`),
    ...Object.values(PNG_SIZES).map((size) => join(dir, `${favicon.prefix}-${size}.png`)),
  ];
}

const update = (blog, slug, locals) => new Promise((resolve, reject) =>
  Template.update(blog.id, slug, { locals }, (err) => err ? reject(err) : resolve())
);

const persistToFolder = (blog, template) => new Promise((resolve, reject) =>
  writeChangeToFolder(blog, template, {}, (err) => err ? reject(err) : resolve())
);

const listTemplates = (blogID) => new Promise((resolve) =>
  Template.getTemplateList(blogID, (err, list) => resolve(err || !list ? [] : list))
);

// Duplicating a template copies its favicon local verbatim, so two templates in
// the same blog can point at the same generated files. Only remove a previous
// favicon's assets once no other template still references that prefix.
async function removeAssetsIfUnreferenced(req, favicon) {
  const paths = assetPaths(req.blog, favicon);
  if (!paths.length) return;

  const others = await listTemplates(req.blog.id);
  const stillUsed = others.some(
    (t) => t && t.id !== req.template.id && t.locals && t.locals.favicon && t.locals.favicon.prefix === favicon.prefix
  );
  if (stillUsed) return;

  await Promise.all(
    paths.map((path) =>
      fs.remove(path).catch((err) =>
        console.log(clfdate(), "uploadFavicon", "Failed to remove old asset", path, err.message)
      )
    )
  );
}

module.exports = async function uploadFavicon(req, res, next) {
  const file = firstFile(req.files);
  const previous = req.template.locals.favicon;
  const isDelete = req.body.remove === "1";

  // A plain "Save changes" with no new file must not touch an existing favicon;
  // only the explicit Delete button (remove=1) clears it.
  if (!isDelete && (!file || !file.size)) {
    await cleanupFiles(req.files);
    if (isAjaxRequest(req)) return res.json({ favicon: previous || null });
    return res.message(req.body.redirect || res.locals.base, previous ? "No changes" : "Choose an image for your favicon");
  }

  if (isDelete) {
    await cleanupFiles(req.files);
    delete req.template.locals.favicon;
    try {
      await update(req.blog, req.params.templateSlug, req.template.locals);
      // Keep the old files until the folder's package.json also stops
      // referencing them: if this fails, a folder reload restores the old
      // (working) favicon rather than pointing at deleted files.
      await persistToFolder(req.blog, req.template);
    } catch (error) {
      return next(error);
    }
    await removeAssetsIfUnreferenced(req, previous);
    return isAjaxRequest(req) ? res.json({ favicon: null }) : res.message(req.body.redirect || res.locals.base, "Removed favicon");
  }

  let created;
  try {
    created = await generate(file.path, faviconDirectory(req.blog), {
      x: req.body.crop_x,
      y: req.body.crop_y,
      size: req.body.crop_size,
    });
    await cleanupFiles(req.files);
  } catch (error) {
    await cleanupFiles(req.files);
    return next(error);
  }

  const favicon = {
    prefix: created.prefix,
    ico: faviconURL(req.blog, `${created.prefix}.ico`),
    png16: faviconURL(req.blog, `${created.prefix}-16.png`),
    png32: faviconURL(req.blog, `${created.prefix}-32.png`),
    appleTouch: faviconURL(req.blog, `${created.prefix}-180.png`),
  };
  req.template.locals.favicon = favicon;

  try {
    await update(req.blog, req.params.templateSlug, req.template.locals);
  } catch (error) {
    // Metadata never took on the new URLs, so discard the freshly generated files.
    await Promise.all(assetPaths(req.blog, favicon).map((path) => fs.remove(path).catch(() => {})));
    return next(error);
  }

  try {
    await persistToFolder(req.blog, req.template);
  } catch (error) {
    // Redis now points at the new favicon but the folder's package.json still
    // points at the old one. Leave both sets of files in place: a folder reload
    // will restore the old (working) favicon, and deleting either set here would
    // leave one of the two references dangling.
    return next(error);
  }

  // Redis and the folder now agree on the new favicon; the previous files are
  // safe to drop unless another template still references them.
  await removeAssetsIfUnreferenced(req, previous);

  return isAjaxRequest(req) ? res.json({ favicon }) : res.message(req.body.redirect || res.locals.base, "Updated favicon");
};

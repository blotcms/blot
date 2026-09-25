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

const listTemplates = (blogID) => new Promise((resolve, reject) =>
  Template.getTemplateList(blogID, (err, list) => err ? reject(err) : resolve(list || []))
);

// Duplicating a template copies its favicon local verbatim, so two templates in
// the same blog can point at the same generated files. Only remove a previous
// favicon's assets once no other template still references that prefix.
async function removeAssetsIfUnreferenced(blog, favicon) {
  const paths = assetPaths(blog, favicon);
  if (!paths.length) return;

  let others;
  try {
    others = await listTemplates(blog.id);
  } catch (err) {
    console.log(clfdate(), "uploadFavicon", "Unable to check old asset references; retaining files", err.message);
    return;
  }
  const stillUsed = others.some(
    (t) => t && t.locals && t.locals.favicon && t.locals.favicon.prefix === favicon.prefix
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

async function deleteFavicon(blog, template, slug) {
  const previous = template.locals.favicon;
  delete template.locals.favicon;
  await update(blog, slug, template.locals);
  // Keep the old files until the folder's package.json also stops
  // referencing them: if this fails, a folder reload restores the old
  // (working) favicon rather than pointing at deleted files.
  await persistToFolder(blog, template);
  await removeAssetsIfUnreferenced(blog, previous);
}

// Generates a favicon from filePath and persists it to the template's
// metadata and folder, rolling back on failure. This is the part shared by
// the upload route below and the profile-photo upload flow (upload-image.js),
// which needs the same generate/persist/rollback behavior but isn't itself
// an Express request - calling this directly keeps that call site from
// depending on req/res internals it doesn't otherwise need.
async function createFavicon(blog, template, slug, filePath, cropBox, { onFileProcessed, source } = {}) {
  const previous = template.locals.favicon;

  const created = await generate(filePath, faviconDirectory(blog), cropBox, { source });
  if (onFileProcessed) await onFileProcessed();

  const favicon = {
    prefix: created.prefix,
    ico: faviconURL(blog, `${created.prefix}.ico`),
    png16: faviconURL(blog, `${created.prefix}-16.png`),
    png32: faviconURL(blog, `${created.prefix}-32.png`),
    appleTouch: faviconURL(blog, `${created.prefix}-180.png`),
  };
  template.locals.favicon = favicon;

  try {
    await update(blog, slug, template.locals);
  } catch (error) {
    // Metadata never took on the new URLs, so discard the freshly generated files.
    await Promise.all(assetPaths(blog, favicon).map((path) => fs.remove(path).catch(() => {})));
    throw error;
  }

  try {
    await persistToFolder(blog, template);
  } catch (error) {
    // Put Redis and package.json back on the previous working value. Only
    // discard the generated files after both references have been restored.
    if (previous) template.locals.favicon = previous;
    else delete template.locals.favicon;
    try {
      await update(blog, slug, template.locals);
      await persistToFolder(blog, template);
      await Promise.all(assetPaths(blog, favicon).map((path) => fs.remove(path).catch(() => {})));
    } catch (_) {
      // A failed rollback may still have a package.json reference to either
      // set, so retaining both is safer than creating a broken favicon URL.
    }
    throw error;
  }

  // Redis and the folder now agree on the new favicon; the previous files are
  // safe to drop unless another template still references them.
  await removeAssetsIfUnreferenced(blog, previous);

  return favicon;
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
    try {
      await deleteFavicon(req.blog, req.template, req.params.templateSlug);
    } catch (error) {
      return next(error);
    }
    return isAjaxRequest(req) ? res.json({ favicon: null }) : res.message(req.body.redirect || res.locals.base, "Removed favicon");
  }

  let favicon;
  try {
    favicon = await createFavicon(
      req.blog,
      req.template,
      req.params.templateSlug,
      file.path,
      { x: req.body.crop_x, y: req.body.crop_y, size: req.body.crop_size },
      { onFileProcessed: () => cleanupFiles(req.files) }
    );
  } catch (error) {
    await cleanupFiles(req.files);
    return next(error);
  }

  return isAjaxRequest(req) ? res.json({ favicon }) : res.message(req.body.redirect || res.locals.base, "Updated favicon");
};

module.exports.removeAssetsIfUnreferenced = removeAssetsIfUnreferenced;
module.exports.createFavicon = createFavicon;

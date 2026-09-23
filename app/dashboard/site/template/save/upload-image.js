const fs = require("fs-extra");
const { join, basename } = require("path");
const config = require("config");
const Template = require("models/template");
const client = require("models/client");
const templateKey = require("models/template/key");
const clfdate = require("helper/clfdate");
const cleanupFiles = require("./cleanup-files");
const writeChangeToFolder = require("./writeChangeToFolder");
const previewReload = require("helper/publishPreviewReload");
const { isAjaxRequest } = require("./ajax-response");
const { generate } = require("../../../../build/thumbnail/template-image");

const directory = (blog) => join(config.blog_static_files_dir, blog.id, "_template_assets");
const url = (blog, name) => `${config.cdn.origin}/${blog.id}/_template_assets/${encodeURIComponent(name)}`;
const first = (files) => Array.isArray(files && files.image) ? files.image[0] : files && files.image;
const update = (blog, slug, locals) => new Promise((resolve, reject) => Template.update(blog.id, slug, { locals }, (error) => error ? reject(error) : resolve()));
const sync = (blog, template) => new Promise((resolve, reject) => writeChangeToFolder(blog, template, {}, (error) => error ? reject(error) : resolve()));
const operations = { update, sync };

function filenames(value) {
  if (!value || !value.url) return [];
  return [value.url, ...Object.values(value.thumbnails || {}).map((item) => item.url)]
    .map((assetURL) => basename(decodeURIComponent(new URL(assetURL, "http://local").pathname)))
    .filter((name) => /^image-[a-f0-9-]+-(original|small|medium|large|square)\.webp$/.test(name));
}

function getTemplatesStrictly(blogID) {
  return Promise.all([
    client.sMembers(templateKey.blogTemplates("SITE")),
    client.sMembers(templateKey.blogTemplates(blogID)),
  ]).then(([siteIDs, blogIDs]) => {
    const ids = [...new Set([...(siteIDs || []), ...(blogIDs || [])])];
    return Promise.all(ids.map((id) => new Promise((resolve, reject) => {
      Template.getMetadata(id, (error, metadata) => {
        if (error) return reject(error);
        if (!metadata) return reject(new Error(`Missing metadata for template ${id}`));
        resolve(metadata);
      });
    })));
  });
}

async function removeAssets(blog, image) {
  await Promise.all(filenames(image).map((name) =>
    fs.remove(join(directory(blog), name)).catch(() => {})
  ));
}

async function removeAssetsIfUnreferenced(req, old) {
  const names = filenames(old);
  if (!names.length) return;

  let list;
  try {
    // getTemplateList intentionally skips per-template metadata errors. Cleanup
    // must use a strict listing so a partial result cannot hide a shared file.
    list = await getTemplatesStrictly(req.blog.id);
  } catch (error) {
    console.log(clfdate(), "uploadImage", "Unable to check old asset references; retaining files", error.message);
    return;
  }

  // The current template must be included: two locals in one template can
  // deliberately share an uploaded image. By the time cleanup runs, the
  // changed local has already been persisted with its replacement value.
  const referenced = list.some((template) =>
    Object.values(template.locals || {}).some((value) => value && value.url === old.url)
  );
  if (!referenced) {
    await Promise.all(names.map((name) =>
      fs.remove(join(directory(req.blog), name)).catch(() => {})
    ));
  }
}

async function removeTemplateAssetsIfUnreferenced(req, images) {
  const uniqueImages = new Map();
  for (const image of images || []) {
    if (image && image.url) uniqueImages.set(image.url, image);
  }

  await Promise.all([...uniqueImages.values()].map((image) =>
    removeAssetsIfUnreferenced(req, image)
  ));
}

function restoreLocal(locals, key, previous, hadPrevious) {
  if (hadPrevious) locals[key] = previous;
  else delete locals[key];
}

async function rollbackLocal(req, key, previous, hadPrevious) {
  restoreLocal(req.template.locals, key, previous, hadPrevious);
  try {
    await operations.update(req.blog, req.template.slug || req.params.templateSlug, req.template.locals);
    await operations.sync(req.blog, req.template);
    return true;
  } catch (error) {
    console.log(clfdate(), "uploadImage", "Unable to restore previous image metadata", error.message);
    return false;
  }
}

async function persistLocal(req, key, value, previous, hadPrevious) {
  req.template.locals[key] = value;

  try {
    await operations.update(req.blog, req.template.slug || req.params.templateSlug, req.template.locals);
  } catch (error) {
    if (await rollbackLocal(req, key, previous, hadPrevious)) await removeAssets(req.blog, value);
    return error;
  }

  try {
    await operations.sync(req.blog, req.template);
  } catch (error) {
    if (await rollbackLocal(req, key, previous, hadPrevious)) await removeAssets(req.blog, value);
    return error;
  }

  return null;
}

module.exports = async function uploadImage(req, res, next) {
  const declaration = (res.locals.images || []).find((item) => item.key === req.params.key);
  if (!declaration) {
    await cleanupFiles(req.files);
    const error = new Error("Unknown image setting");
    error.status = 404;
    return next(error);
  }

  const locals = req.template.locals || (req.template.locals = {});
  const key = declaration.key;
  const hadPrevious = Object.prototype.hasOwnProperty.call(locals, key);
  const previous = locals[key];
  const file = first(req.files);
  const remove = req.body.remove === "1";

  if (!remove && (!file || !file.size)) {
    await cleanupFiles(req.files);
    return isAjaxRequest(req)
      ? res.json({ image: previous || null })
      : res.message(req.body.redirect || res.locals.base, previous && previous.url ? "No changes" : "Choose an image");
  }

  if (remove) {
    await cleanupFiles(req.files);
    const error = await persistLocal(req, key, {}, previous, hadPrevious);
    if (error) return next(error);
    await removeAssetsIfUnreferenced(req, previous);
    previewReload.publish(req.blog.id);
    return isAjaxRequest(req)
      ? res.json({ image: null })
      : res.message(req.body.redirect || res.locals.base, "Removed image");
  }

  let made;
  try {
    made = await generate(file.path, directory(req.blog), {
      x: req.body.crop_x,
      y: req.body.crop_y,
      size: req.body.crop_size,
    });
    await cleanupFiles(req.files);
  } catch (error) {
    await cleanupFiles(req.files);
    return next(error);
  }

  const image = {
    url: url(req.blog, made.original.name),
    width: made.original.width,
    height: made.original.height,
    thumbnails: {},
  };
  for (const [name, item] of Object.entries(made.thumbnails)) {
    image.thumbnails[name] = {
      url: url(req.blog, item.name),
      width: item.width,
      height: item.height,
    };
  }

  const error = await persistLocal(req, key, image, previous, hadPrevious);
  if (error) return next(error);

  await removeAssetsIfUnreferenced(req, previous);
  previewReload.publish(req.blog.id);
  return isAjaxRequest(req)
    ? res.json({ image })
    : res.message(req.body.redirect || res.locals.base, "Updated image");
};

module.exports.removeAssetsIfUnreferenced = removeAssetsIfUnreferenced;
module.exports.removeTemplateAssetsIfUnreferenced = removeTemplateAssetsIfUnreferenced;
module.exports.operations = operations;

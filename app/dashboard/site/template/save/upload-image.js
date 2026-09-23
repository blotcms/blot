const fs = require("fs-extra");
const { join, basename } = require("path");
const config = require("config");
const Template = require("models/template");
const cleanupFiles = require("./cleanup-files");
const writeChangeToFolder = require("./writeChangeToFolder");
const previewReload = require("helper/publishPreviewReload");
const { isAjaxRequest } = require("./ajax-response");
const { generate } = require("../../../../build/thumbnail/template-image");

const directory = (blog) => join(config.blog_static_files_dir, blog.id, "_template_assets");
const url = (blog, name) => `${config.cdn.origin}/${blog.id}/_template_assets/${encodeURIComponent(name)}`;
const first = (files) => Array.isArray(files && files.image) ? files.image[0] : files && files.image;
const update = (blog, slug, locals) => new Promise((resolve, reject) => Template.update(blog.id, slug, { locals }, (e) => e ? reject(e) : resolve()));
const sync = (blog, template) => new Promise((resolve, reject) => writeChangeToFolder(blog, template, {}, (e) => e ? reject(e) : resolve()));
const templates = (id) => new Promise((resolve) => Template.getTemplateList(id, (e, list) => resolve(e ? [] : list || [])));

function filenames(value) {
  if (!value || !value.url) return [];
  return [value.url, ...Object.values(value.thumbnails || {}).map((item) => item.url)]
    .map((value) => basename(decodeURIComponent(new URL(value, "http://local").pathname)))
    .filter((name) => /^image-[a-f0-9-]+-(original|small|medium|large|square)\.webp$/.test(name));
}
async function removeAssetsIfUnreferenced(req, old) {
  const names = filenames(old); if (!names.length) return;
  const list = await templates(req.blog.id);
  const referenced = list.some((template) => template && template.id !== req.template.id && Object.values(template.locals || {}).some((value) => value && value.url === old.url));
  if (!referenced) await Promise.all(names.map((name) => fs.remove(join(directory(req.blog), name)).catch(() => {})));
}

module.exports = async function uploadImage(req, res, next) {
  const declaration = (res.locals.images || []).find((item) => item.key === req.params.key);
  if (!declaration) { await cleanupFiles(req.files); const error = new Error("Unknown image setting"); error.status = 404; return next(error); }
  const old = req.template.locals[declaration.key];
  const file = first(req.files);
  const remove = req.body.remove === "1";
  if (!remove && (!file || !file.size)) { await cleanupFiles(req.files); return isAjaxRequest(req) ? res.json({ image: old || null }) : res.message(req.body.redirect || res.locals.base, old && old.url ? "No changes" : "Choose an image"); }
  if (remove) {
    await cleanupFiles(req.files); req.template.locals[declaration.key] = {};
    try { await update(req.blog, req.params.templateSlug, req.template.locals); await sync(req.blog, req.template); }
    catch (error) { return next(error); }
    await removeAssetsIfUnreferenced(req, old); previewReload.publish(req.blog.id);
    return isAjaxRequest(req) ? res.json({ image: null }) : res.message(req.body.redirect || res.locals.base, "Removed image");
  }
  let made;
  try { made = await generate(file.path, directory(req.blog), { x: req.body.crop_x, y: req.body.crop_y, size: req.body.crop_size }); await cleanupFiles(req.files); }
  catch (error) { await cleanupFiles(req.files); return next(error); }
  const image = { url: url(req.blog, made.original.name), width: made.original.width, height: made.original.height, thumbnails: {} };
  for (const [name, item] of Object.entries(made.thumbnails)) image.thumbnails[name] = { url: url(req.blog, item.name), width: item.width, height: item.height };
  req.template.locals[declaration.key] = image;
  try { await update(req.blog, req.params.templateSlug, req.template.locals); }
  catch (error) { await Promise.all(filenames(image).map((name) => fs.remove(join(directory(req.blog), name)).catch(() => {}))); return next(error); }
  try { await sync(req.blog, req.template); } catch (error) { return next(error); }
  await removeAssetsIfUnreferenced(req, old); previewReload.publish(req.blog.id);
  return isAjaxRequest(req) ? res.json({ image }) : res.message(req.body.redirect || res.locals.base, "Updated image");
};

module.exports.removeAssetsIfUnreferenced = removeAssetsIfUnreferenced;

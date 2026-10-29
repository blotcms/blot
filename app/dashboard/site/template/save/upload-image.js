const sharp = require("sharp");
const { basename } = require("path");
const assets = require("storage/assets");
const Template = require("models/template");
const client = require("models/client");
const templateKey = require("models/template/key");
const clfdate = require("helper/clfdate");
const cleanupFiles = require("./cleanup-files");
const { createFavicon } = require("./upload-favicon");
const writeChangeToFolder = require("./writeChangeToFolder");
const previewReload = require("helper/publishPreviewReload");
const { isAjaxRequest } = require("./ajax-response");
const { generate, regenerate, MAX_PIXELS, normalizeShape } = require("../../../../build/thumbnail/template-image");
const { normalizedCrop } = require("../../../../build/thumbnail/crop");

const ASSETS = "_template_assets";
const directory = (blog) => assets.path(blog.id, ASSETS);
const assetPath = (name) => `${ASSETS}/${name}`;
const url = (blog, name) => assets.url(blog.id, assetPath(encodeURIComponent(name)));
const first = (files) => Array.isArray(files && files.image) ? files.image[0] : files && files.image;
const update = (blog, slug, locals) => new Promise((resolve, reject) => Template.update(blog.id, slug, { locals }, (error) => error ? reject(error) : resolve()));
const sync = (blog, template) => new Promise((resolve, reject) => writeChangeToFolder(blog, template, {}, (error) => error ? reject(error) : resolve()));
const operations = { update, sync };

async function saveProfileImageFavicon(req, file, source) {
  const templateSlug = req.templateFork
    ? req.template.id.split(":").slice(1).join(":")
    : req.params.templateSlug;
  return createFavicon(req.blog, req.template, templateSlug, file.path, {}, {
    onFileProcessed: () => cleanupFiles({ favicon: file }),
    source,
    shape: req.body.photo_shape,
  });
}

const nameFromURL = (assetURL) => basename(decodeURIComponent(new URL(assetURL, "http://local").pathname));

const CROP_EPSILON = 1e-6;
const sameCrop = (a, b) => (!a && !b) || Boolean(a && b && ["x", "y", "width", "height"].every((k) => Math.abs(a[k] - b[k]) < CROP_EPSILON));

function filenames(value) {
  if (!value || !value.url) return [];
  return [value.url, ...Object.values(value.thumbnails || {}).map((item) => item.url)]
    .map(nameFromURL)
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
    assets.remove(blog.id, assetPath(name)).catch(() => {})
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
  // Files are checked one by one because a forked template may still use an
  // image's original and other sizes after a shape change replaced its square.
  const referenced = new Set(list.flatMap((template) =>
    Object.values(template.locals || {}).flatMap(filenames)
  ));
  await Promise.all(names.filter((name) => !referenced.has(name)).map((name) =>
    assets.remove(req.blog.id, assetPath(name)).catch(() => {})
  ));
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

// The original and every thumbnail were written locally by generate()
async function commitGenerated(blog, made) {
  const names = [made.original && made.original.name, ...Object.values(made.thumbnails).map((item) => item.name)].filter(Boolean);
  try {
    await Promise.all(names.map((name) => assets.commit(blog.id, assetPath(name))));
  } catch (error) {
    await Promise.all(names.map((name) => assets.remove(blog.id, assetPath(name)).catch(() => {})));
    throw error;
  }
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
    if (await rollbackLocal(req, key, previous, hadPrevious) && (!previous || previous.url !== (value && value.url))) {
      await removeAssets(req.blog, value);
    }
    return error;
  }

  try {
    await operations.sync(req.blog, req.template);
  } catch (error) {
    if (await rollbackLocal(req, key, previous, hadPrevious) && (!previous || previous.url !== (value && value.url))) {
      await removeAssets(req.blog, value);
    }
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
  const editOnly = req.body.update_mask === "1" && key === "profile_image" && (!file || !file.size);
  const wantsFavicon = key === "profile_image" && res.locals.favicon_supported && !locals.favicon;

  if (!remove && !editOnly && (!file || !file.size)) {
    await cleanupFiles(req.files);
    return isAjaxRequest(req)
      ? res.json({ image: previous || null })
      : res.message(req.body.redirect || res.locals.base, previous && previous.url ? "No changes" : "Choose an image");
  }

  const cropFields = {
    x: req.body.crop_x,
    y: req.body.crop_y,
    width: req.body.crop_width,
    height: req.body.crop_height,
  };

  let mask;
  if (key === "profile_image") {
    try {
      mask = normalizeShape(req.body.photo_shape);
    } catch (error) {
      await cleanupFiles(req.files);
      return next(error);
    }
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

  if (editOnly) {
    // No crop submitted means keep the saved one
    const crop = normalizedCrop(cropFields) || previous.crop || null;
    if (previous.mask === mask && sameCrop(previous.crop, crop)) {
      await cleanupFiles(req.files);
      return isAjaxRequest(req)
        ? res.json({ image: previous })
        : res.message(req.body.redirect || res.locals.base, "No changes");
    }

    // The thumbnails are cropped and cut to the shape, so either changing
    // needs new thumbnails. The stored original is the whole (shrunk) photo.
    let made;
    try {
      const whole = await assets.read(req.blog.id, assetPath(nameFromURL(previous.url)));
      made = await regenerate(whole, directory(req.blog), crop, mask);
      await commitGenerated(req.blog, { thumbnails: made.thumbnails });
    } catch (error) {
      return next(error);
    }

    const updated = { ...previous, mask, thumbnails: {} };
    if (crop) updated.crop = crop;
    for (const [name, item] of Object.entries(made.thumbnails)) {
      updated.thumbnails[name] = { url: url(req.blog, item.name), width: item.width, height: item.height };
    }
    const error = await persistLocal(req, key, updated, previous, hadPrevious);
    // On failure the new thumbnails are kept: if the rollback could not be
    // confirmed, the saved metadata may still point at them.
    if (error) return next(error);
    await removeAssetsIfUnreferenced(req, previous);
    previewReload.publish(req.blog.id);
    return isAjaxRequest(req)
      ? res.json({ image: updated })
      : res.message(req.body.redirect || res.locals.base, "Updated photo");
  }

  // wantsFavicon also derives a separately-cropped favicon from this same
  // file below; sharing one decoded sharp() source across both avoids
  // reading and decoding the upload from disk twice.
  const source = wantsFavicon ? sharp(file.path, { pages: 1, limitInputPixels: MAX_PIXELS }) : null;

  let made;
  try {
    made = await generate(file.path, directory(req.blog), cropFields, {
      source,
      shape: mask,
      // A profile photo keeps its whole image so the crop can be edited later
      editable: key === "profile_image",
    });
    // generate() wrote the derivatives to the local directory
    await commitGenerated(req.blog, made);
    if (!wantsFavicon) await cleanupFiles(req.files);
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
  if (mask) image.mask = mask;
  if (made.crop) image.crop = made.crop;
  for (const [name, item] of Object.entries(made.thumbnails)) {
    image.thumbnails[name] = {
      url: url(req.blog, item.name),
      width: item.width,
      height: item.height,
    };
  }

  const error = await persistLocal(req, key, image, previous, hadPrevious);
  if (error) {
    await cleanupFiles(req.files);
    return next(error);
  }

  await removeAssetsIfUnreferenced(req, previous);
  if (wantsFavicon) {
    try {
      await saveProfileImageFavicon(req, file, source);
    } catch (error) {
      await cleanupFiles({ favicon: file });
      previewReload.publish(req.blog.id);
      error.message = `Your profile image was saved, but the favicon could not be created: ${error.message}`;
      return next(error);
    }
  }

  previewReload.publish(req.blog.id);
  return isAjaxRequest(req)
    ? res.json({ image })
    : res.message(req.body.redirect || res.locals.base, wantsFavicon ? "Updated profile photo and favicon!" : "Updated image");
};

module.exports.removeAssetsIfUnreferenced = removeAssetsIfUnreferenced;
module.exports.removeTemplateAssetsIfUnreferenced = removeTemplateAssetsIfUnreferenced;
module.exports.operations = operations;

// Gives a test site a profile photo the way the dashboard does when someone
// uploads one at /sites/{handle}/template/{slug}/images/profile_image: the
// photo is saved as the template's profile_image local, thumbnails and all,
// and written to the template's package.json in the blog's folder. Saving it
// forks a SITE template into the blog (fork-if-needed.js), so the blog ends up
// on its own copy, as it would after any other template edit.

const fs = require("fs-extra");
const os = require("os");
const { join } = require("path");
const sharp = require("sharp");
const Blog = require("models/blog");
const Template = require("models/template");
const makeID = require("models/template/util/makeID");
const slugForName = require("models/template/util/slugForName");
const createTemplate = require("dashboard/site/template/save/create-template");
const writeChangeToFolder = require("dashboard/site/template/save/writeChangeToFolder");
const {
  directory,
  url,
  commitGenerated,
} = require("dashboard/site/template/save/upload-image");
const { generate } = require("build/thumbnail/template-image");
const material = require("./material");

// Each photo is cut from the nth image in the demo folders, so it changes if
// they do. The size gives the shape of the crop; round puts it in a circle.
// empty and local get none.
const PHOTOS = {
  tiny: { image: 0, width: 400, height: 400 },
  huge: { image: 7, width: 400, height: 400 },
  torture: { image: 13, width: 1200, height: 200, round: true },
  arabic: { image: 21, width: 400, height: 400, round: true },
  japanese: { image: 34, width: 300, height: 400 },
  // Demo folder sites whose templates show the photo prominently
  clara: { image: 3, width: 400, height: 400, round: true },
  david: { image: 5, width: 400, height: 400 },
  bees: { image: 8, width: 400, height: 400 },
};

// The largest centred rectangle of the image with the wanted shape, as the
// fractions of the image the dashboard's cropper submits
function cropFor(width, height, aspect) {
  if (width / height > aspect) {
    const w = (height * aspect) / width;
    return { x: (1 - w) / 2, y: 0, width: w, height: 1 };
  }
  const h = width / aspect / height;
  return { x: 0, y: (1 - h) / 2, width: 1, height: h };
}

// The template the photo goes on: the blog's own copy of its template,
// forking it first if the blog is still on a SITE one
async function ownTemplate(blog) {
  const current = await Template.getMetadata(blog.template);
  if (!current) return null;
  if (current.owner === blog.id) return current;

  const id = makeID(blog.id, current.name);
  const existing = await Template.getMetadata(id).catch(() => null);
  const fork =
    existing ||
    (await createTemplate({
      owner: blog.id,
      slug: slugForName(blog.id, current.name),
      name: current.name,
      cloneFrom: current.id,
    }));
  await Blog.set(blog.id, { template: fork.id });
  return fork;
}

// Leaves a photo that's already saved alone, so a re-run changes nothing. To
// change one, remove it in the dashboard first.
module.exports = async function setProfileImage(blog) {
  const wanted = PHOTOS[blog.handle];
  if (!wanted) return;

  let template = await Template.getMetadata(blog.template);
  if (!template) return;
  const saved = template.locals && template.locals.profile_image;
  if (saved && saved.url) return;

  const images = await material.images();
  if (!images.length) return;
  const src = images[wanted.image % images.length];

  const temporary = await fs.mkdtemp(join(os.tmpdir(), "blot-profile-image-"));
  const file = join(temporary, "photo.jpg");
  let made;
  let mask;
  try {
    const info = await sharp(src)
      .rotate()
      .resize(2000, 2000, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toFile(file);
    const crop = cropFor(info.width, info.height, wanted.width / wanted.height);
    mask = wanted.round ? "circle" : undefined;
    template = await ownTemplate(blog);
    if (!template) return;
    made = await generate(file, directory(blog), crop, {
      shape: mask,
      editable: true,
    });
    await commitGenerated(blog, made);
  } catch (err) {
    console.warn("No profile photo for", blog.handle + ":", err.message);
    return;
  } finally {
    await fs.remove(temporary);
  }

  const image = {
    url: url(blog, made.original.name),
    width: made.original.width,
    height: made.original.height,
    thumbnails: {},
  };
  if (mask) image.mask = mask;
  if (made.crop) image.crop = made.crop;
  for (const [name, item] of Object.entries(made.thumbnails)) {
    image.thumbnails[name] = {
      url: url(blog, item.name),
      width: item.width,
      height: item.height,
    };
  }

  const locals = { ...template.locals, profile_image: image };
  await Template.update(blog.id, template.slug, { locals });
  await writeChangeToFolder(blog, { ...template, locals }, {});

  // The old avatar setting, which templates no longer read
  if (blog.avatar || blog.roundAvatar) {
    await Blog.set(blog.id, { avatar: "", roundAvatar: false });
  }
  console.log("Set profile photo for", blog.handle);
};

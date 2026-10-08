const fs = require("fs-extra");
const { extname, dirname, join, basename } = require("path");
const titlify = require("build/prepare/titlify");
const ensure = require("helper/ensure");
const LocalPath = require("helper/localPath");
const hash = require("helper/hash");
const sharp = require("sharp");
const assets = require("storage/assets");
const exif = require("./exif");
const Transformer = require("helper/transformer");

const EXTENSIONS_TO_CONVERT = [
  ".tif",
  ".tiff",
  ".webp",
  ".avif",
  ".heic",
  ".heif",
];
const SUPPORTED_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ...EXTENSIONS_TO_CONVERT,
];

function is(path) {
  return SUPPORTED_EXTENSIONS.includes(extname(path).toLowerCase());
}

async function read(blog, path, callback) {
  ensure(blog, "object").and(path, "string").and(callback, "function");

  const localPath = LocalPath(blog.id, path);
  const assetDirectory = assets.path(blog.id);
  // If we need to convert the image to another format, store the converted
  // image in the asset directory for the blog.

  try {
    const stat = await fs.stat(localPath);
    const name = basename(path);
    const pathForTitle = join(dirname(path), name);
    const title = titlify(pathForTitle);
    const isRetina = path.toLowerCase().includes("@2x") ? 'data-2x="true"' : "";
    let outputPath = path;

    let metadata = {};

    try {
      metadata = await sharp(localPath).metadata();
    } catch (metadataErr) {
      metadata = {};
    }

    const parsedExif = await exif.parseExif(localPath, blog.imageExif);

    const extras = Object.keys(parsedExif).length
      ? { exif: parsedExif }
      : undefined;

    if (EXTENSIONS_TO_CONVERT.includes(extname(path).toLowerCase())) {
      const transformer = new Transformer(blog.id, "img-converter");
      const hashPath = hash(path);
      const convertedFilename = `${name}.png`;
      const convertedRelativePath = `/_assets/${hashPath}/${convertedFilename}`;

      const absoluteFromRelative = (relativePath) =>
        join(assetDirectory, relativePath.replace(/^\//, ""));

      const writeConversion = async (sourcePath, relativePath) => {
        const absolutePath = absoluteFromRelative(relativePath);

        await fs.ensureDir(dirname(absolutePath));
        await fs.remove(absolutePath);
        await sharp(sourcePath).png().toFile(absolutePath);

        return { relativePath };
      };

      const convertImage = async (sourcePath) =>
        writeConversion(sourcePath, convertedRelativePath);

      const conversion = await lookupWithTransformer(
        transformer,
        path,
        convertImage
      );

      const conversionRelativePath =
        conversion?.relativePath || convertedRelativePath;
      const conversionAbsolutePath = absoluteFromRelative(
        conversionRelativePath
      );

      if (!(await fs.pathExists(conversionAbsolutePath))) {
        await writeConversion(localPath, conversionRelativePath);
      }

      outputPath = conversionRelativePath;
    }

    const contents = `<img src="${encodeURI(
      outputPath
    )}" title="${title}" alt="${title}" ${isRetina}/>`;

    callback(null, contents, stat, extras);
  } catch (err) {
    callback(err);
  }
}

function lookupWithTransformer(transformer, src, transform) {
  return new Promise((resolve, reject) => {
    transformer.lookup(
      src,
      (resolvedPath, done) => {
        Promise.resolve(transform(resolvedPath))
          .then((result) => done(null, result))
          .catch(done);
      },
      (err, result) => {
        if (err) return reject(err);
        resolve(result);
      }
    );
  });
}

module.exports = { is, read, id: "img" };

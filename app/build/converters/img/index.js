const fs = require("fs-extra");
const { extname, dirname, join, basename } = require("path");
const titlify = require("build/prepare/titlify");
const ensure = require("helper/ensure");
const { withLocalHeld } = require("build/converters/folderStat");
const hash = require("helper/hash");
const sandbox = require("sandbox");
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

async function read(blog, path) {
  ensure(blog, "object").and(path, "string");

  // If we need to convert the image to another format, store the converted
  // image in the asset directory for the blog.

  // sharp and exiftool read from a real file. They may run for longer than
  // the cache keeps a path, so the file is held while they do.
  const name = basename(path);
  const pathForTitle = join(dirname(path), name);
  const title = titlify(pathForTitle);
  const isRetina = path.toLowerCase().includes("@2x") ? 'data-2x="true"' : "";
  let outputPath = path;
  let extras;

  const { stat } = await withLocalHeld(blog.id, path, async (localPath) => {
    // An image that is converted has its EXIF read by the same job, from the
    // same bytes (to-png's exif arg): one jail and one read of the file, not
    // two. Only a conversion which runs reads it: one found in the cache does
    // not, and its EXIF is read after, as an image that is not converted has
    // its EXIF read, by the exif job (parseExif never rejects).
    const exifFields = exif.fieldsFor(blog.imageExif);
    let converted; // { exif } from a conversion that read the EXIF too

    const convert = async () => {
      if (EXTENSIONS_TO_CONVERT.includes(extname(path).toLowerCase())) {
        const transformer = new Transformer(blog.id, "img-converter");
        const hashPath = hash(path);
        const convertedFilename = `${name}.png`;
        const convertedRelativePath = `/_assets/${hashPath}/${convertedFilename}`;

        const writeConversion = async (sourcePath, relativePath) => {
          // the sandbox converts the image and we write it to a local path,
          // which we then commit to the blog's assets
          const absolutePath = assets.path(blog.id, relativePath);

          await fs.ensureDir(dirname(absolutePath));
          await assets.remove(blog.id, relativePath);
          const { outputs, meta } = await sandbox.run(
            "to-png",
            exifFields ? { exif: exifFields } : {},
            { path: sourcePath }
          );
          if (exifFields) converted = { exif: meta.exif };
          await fs.writeFile(absolutePath, outputs[0]);
          await assets.commit(blog.id, relativePath);

          return { relativePath };
        };

        const convertImage = async (sourcePath) =>
          writeConversion(sourcePath, convertedRelativePath);

        // The cache is keyed by the file's bytes, so a copy of the image at
        // another path would get the first path's directory back. Each path
        // owns its own: a result in any other is made again here.
        const ownPrefix = `/_assets/${hashPath}/`;
        const isValid = (result) =>
          !!result &&
          typeof result.relativePath === "string" &&
          result.relativePath.startsWith(ownPrefix);

        const conversion = await transformer.lookup(path, convertImage, {
          isValid,
        });

        const conversionRelativePath =
          conversion?.relativePath || convertedRelativePath;

        if (!(await assets.exists(blog.id, conversionRelativePath))) {
          await writeConversion(localPath, conversionRelativePath);
        }

        outputPath = conversionRelativePath;
      }
    };

    let parsedExif;

    await convert();

    if (converted) parsedExif = exif.shape(converted.exif, blog.imageExif);

    if (!parsedExif)
      parsedExif = await exif.parseExif(localPath, blog.imageExif);

    extras = Object.keys(parsedExif).length ? { exif: parsedExif } : undefined;
  });

  const contents = `<img src="${encodeURI(
    outputPath
  )}" title="${title}" alt="${title}" ${isRetina}/>`;

  return [contents, stat, extras];
}

// Called back with (err, html, stat, extras); without a callback it resolves
// to [html, stat, extras]
module.exports = { is, read: read, id: "img" };

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
const withResults = require("build/withResults");

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
    // exiftool and the conversion are separate jails reading the same
    // file, so they run side by side (parseExif never rejects)
    const exifPromise = exif.parseExif(localPath, blog.imageExif);

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
          const { outputs } = await sandbox.run(
            "to-png",
            {},
            { path: sourcePath }
          );
          await fs.writeFile(absolutePath, outputs[0]);
          await assets.commit(blog.id, relativePath);

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

        if (!(await assets.exists(blog.id, conversionRelativePath))) {
          await writeConversion(localPath, conversionRelativePath);
        }

        outputPath = conversionRelativePath;
      }
    };

    try {
      await convert();
    } finally {
      const parsedExif = await exifPromise;

      extras = Object.keys(parsedExif).length
        ? { exif: parsedExif }
        : undefined;
    }
  });

  const contents = `<img src="${encodeURI(
    outputPath
  )}" title="${title}" alt="${title}" ${isRetina}/>`;

  return [contents, stat, extras];
}

function lookupWithTransformer(transformer, src, transform) {
  return new Promise((resolve, reject) => {
    transformer.lookup(src, transform, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

// Called back with (err, html, stat, extras); without a callback it resolves
// to [html, stat, extras]
module.exports = { is, read: withResults(read), id: "img" };

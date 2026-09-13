const Transformer = require("helper/transformer");
const fs = require("fs-extra");
const { join, extname } = require("path");
const hash = require("helper/hash");
const config = require("config");
const sharp = require("sharp");
const mime = require("mime-types");

async function processImages(blogID, docPath, $) {
  const docHash = hash(docPath);
  const blogDir = join(config.blog_static_files_dir, blogID);
  const assetDir = join(blogDir, "_assets", docHash);

  const transformer = new Transformer(blogID, "gdoc-images");

  const images = [];

  $("img").each(function (i, elem) {
    images.push(elem);
  });

  await fs.ensureDir(assetDir);

  const dataImages = images.filter((elem) => {
    const src = $(elem).attr("src");
    return src && src.startsWith("data:");
  });

  const nonDataImages = images.filter((elem) => {
    const src = $(elem).attr("src");
    return src && !src.startsWith("data:");
  });

  const assetPrefix = `/_assets/${docHash}/`;
  const alreadyAssetImages = nonDataImages.filter((elem) => {
    const src = $(elem).attr("src");
    return src && src.startsWith(assetPrefix) && src.length > assetPrefix.length;
  });
  const needsProcessingImages = nonDataImages.filter(
    (elem) => !alreadyAssetImages.includes(elem)
  );

  // Fast-path: leave img src already pointing at Blot static assets unchanged
  // (e.g. from zip-export download flow that rewrote images/... to /_assets/...)
  // AlreadyAssetImages are skipped below; no copy or transformer lookup.

  // Handle images which embed image data directly
  for (const elem of dataImages) {
    try {
      const src = $(elem).attr("src");

      let buffer;
      let ext;
      let filename;

      const commaIndex = src.indexOf(",");

      if (commaIndex === -1) {
        continue;
      }

      const metadataPart = src.slice(5, commaIndex);
      const dataPart = src.slice(commaIndex + 1);
      const metadataParts = metadataPart.split(";");
      const mimeType = metadataParts.shift() || "";
      const isBase64 = metadataParts.includes("base64");

      buffer = Buffer.from(
        isBase64 ? dataPart : decodeURIComponent(dataPart),
        isBase64 ? "base64" : "utf8"
      );

      if (mimeType) {
        ext = mime.extension(mimeType);
      }

      if (!ext) {
        const metadata = await sharp(buffer).metadata();
        ext = metadata.format;
      }

      filename = hash(src) + "." + ext;
      await fs.outputFile(join(assetDir, filename), buffer);

      $(elem).attr("src", "/_assets/" + docHash + "/" + filename);
    } catch {
    }
  }

  // Handle images which reference external resources (remote URLs, relative paths)
  for (const elem of needsProcessingImages) {
    const src = $(elem).attr("src");
    const filenameBase = hash(src);

    try {

      const cachedFilename = await findCachedAsset(assetDir, filenameBase);

      if (cachedFilename) {
        $(elem).attr(
          "src",
          "/_assets/" + docHash + "/" + cachedFilename
        );
        continue;
      }

      const fetchImage = async (resolvedPath, done) => {
        try {
          const determinedExt = await determineExtension(resolvedPath);

          const computedFilename = `${filenameBase}.${determinedExt}`;
          const destination = join(assetDir, computedFilename);

          await fs.copy(resolvedPath, destination);
          done(null, {
            output: "/_assets/" + docHash + "/" + computedFilename,
          });
        } catch (err) {
          done(err);
        }
      };

      const { output } = await lookupWithTransformer(
        transformer,
        src,
        fetchImage
      );

      $(elem).attr("src", output);
    } catch {
      const fallbackFilename = await findCachedAsset(assetDir, filenameBase);

      if (fallbackFilename) {
        $(elem).attr(
          "src",
          "/_assets/" + docHash + "/" + fallbackFilename
        );
      }
    }
  }
}

async function findCachedAsset(assetDir, filenameBase) {
  try {
    const files = await fs.readdir(assetDir);
    return files.find((file) => file.startsWith(`${filenameBase}.`));
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      throw err;
    }
  }
}

function lookupWithTransformer(transformer, src, transform) {
  return new Promise((resolve, reject) => {
    transformer.lookup(src, transform, (err, result) => {
      if (result) {
        resolve(result);
      } else {
        reject(err || new Error("Image lookup failed for " + src));
      }
    });
  });
}

async function determineExtension(path) {
  let ext = extname(path).replace(/^\./, "").toLowerCase();

  if (!ext) {
    try {
      const metadata = await sharp(path).metadata();
      ext = metadata.format;
    } catch (err) {}
  }

  if (!ext) {
    throw new Error("Unable to determine extension for " + path);
  }

  return ext;
}

module.exports = processImages;

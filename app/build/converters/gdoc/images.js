const Transformer = require("helper/transformer");
const { extname } = require("path");
const hash = require("helper/hash");
const assets = require("storage/assets");
const sandbox = require("sandbox");
const mime = require("mime-types");

async function processImages(blogID, docPath, $) {
  const docHash = hash(docPath);
  const assetDir = "_assets/" + docHash;

  const transformer = new Transformer(blogID, "gdoc-images");

  const images = [];

  $("img").each(function (i, elem) {
    images.push(elem);
  });

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
    return (
      src && src.startsWith(assetPrefix) && src.length > assetPrefix.length
    );
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
        const { meta } = await sandbox.run("metadata", {}, buffer);
        ext = meta.format;
      }

      filename = hash(src) + "." + ext;
      await assets.write(blogID, assetDir + "/" + filename, buffer);

      $(elem).attr("src", "/_assets/" + docHash + "/" + filename);
    } catch {}
  }

  // Handle images which reference external resources (remote URLs, relative paths)
  for (const elem of needsProcessingImages) {
    const src = $(elem).attr("src");
    const filenameBase = hash(src);

    try {
      const cachedFilename = await findCachedAsset(
        blogID,
        assetDir,
        filenameBase
      );

      if (cachedFilename) {
        $(elem).attr("src", "/_assets/" + docHash + "/" + cachedFilename);
        continue;
      }

      const fetchImage = async (resolvedPath) => {
        const determinedExt = await determineExtension(resolvedPath);

        const computedFilename = `${filenameBase}.${determinedExt}`;

        await assets.writeFrom(
          blogID,
          assetDir + "/" + computedFilename,
          resolvedPath
        );

        return {
          output: "/_assets/" + docHash + "/" + computedFilename,
        };
      };

      const found = await transformer.lookup(src, fetchImage);

      if (!found) throw new Error("Image lookup failed for " + src);

      const { output } = found;

      $(elem).attr("src", output);
    } catch {
      const fallbackFilename = await findCachedAsset(
        blogID,
        assetDir,
        filenameBase
      );

      if (fallbackFilename) {
        $(elem).attr("src", "/_assets/" + docHash + "/" + fallbackFilename);
      }
    }
  }
}

async function findCachedAsset(blogID, assetDir, filenameBase) {
  const files = await assets.list(blogID, assetDir);
  return files.find((file) => file.startsWith(`${filenameBase}.`));
}

async function determineExtension(path) {
  let ext = extname(path).replace(/^\./, "").toLowerCase();

  if (!ext) {
    try {
      const { meta } = await sandbox.run("metadata", {}, { path });
      ext = meta.format;
    } catch (err) {}
  }

  if (!ext) {
    throw new Error("Unable to determine extension for " + path);
  }

  return ext;
}

module.exports = processImages;

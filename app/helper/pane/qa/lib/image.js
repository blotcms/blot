// PNG <-> { width, height, data } using sharp (already a dependency).

const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

async function loadPng(file) {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

async function savePng(img, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length), {
    raw: { width: img.width, height: img.height, channels: 4 },
  })
    .png()
    .toFile(file);
}

module.exports = { loadPng, savePng };

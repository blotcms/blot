const fs = require('fs-extra');
const sharp = require('sharp');
const toIco = require('to-ico');

module.exports = async function generateFavicon(sourcePath, destPath) {
  const faviconDimensions = [16, 24, 32, 64];
  const pngDimensions = [180];
  const metadata = await sharp(sourcePath).metadata();

  // Create buffer for each size for ICO
  const resizedBuffers = await Promise.all(faviconDimensions.map(dimension =>
    sharp(sourcePath, { density: dimension / Math.max(metadata.width, metadata.height) * metadata.density })
      .resize(dimension, dimension)
      .toBuffer()
  ));

  // Write the ICO file
  await fs.writeFile(destPath, await toIco(resizedBuffers));

  // Extract the path without .ico at the end
  const destPathWithoutICO = destPath.replace(/\.ico$/, '');

  // Generate and save PNG files
  await Promise.all(pngDimensions.map(async (dimension) => {
    const outputPath = `${destPathWithoutICO}-${dimension}x${dimension}.png`;
    
    await sharp(sourcePath, { density: dimension / Math.max(metadata.width, metadata.height) * metadata.density })
      .resize(dimension, dimension)
      .toFile(outputPath);
  }));
};